// ============================================================================
// parser.js
//
// ZIP parser, state management, and live terminal logging for the
// Instagram Usage Time Analyzer. This file must be loaded BEFORE app.js.
//
// Responsibilities:
//   - Reads Instagram data-export ZIPs via a custom streaming parser
//   - Maintains all global state: timestamps, sessions, devices, locations
//   - Provides terminal logging utilities for the hacker-style overlay
//   - Implements account-owner heuristics (most frequent sender)
//
// Exports (globals used by app.js):
//   rawTimestamps, activeDayTimestamps, rawTimestampSources, loginLogoutPairs,
//   activityRecords, extraMetadata, ownerName, knownUserGuess,
//   DATA_SOURCES, handleZipFile, extractAnyTimestamp, loadSampleData
// ============================================================================

// ========== State Variables ==========
let rawTimestamps = [];
let activeDayTimestamps = [];
let rawTimestampSources = {};
let loginLogoutPairs = [];

let activityRecords = [];

let extraMetadata = {
    devices: {},
    locations: {},   // city label
    ips: {},         // raw IP
    signupDate: null
};

// Account owner detection: the "most frequent sender" is picked by sender_name count.
let ownerName = null;          // resolved account owner display name
let knownUserGuess = null;     // username guess derived from the ZIP filename
const _senderStats = new Map();   // sender_name
const _threadParticipants = new Map(); // thread_path

function _learnSender(name) {
    if (!name || typeof name !== 'string') return;
    _senderStats.set(name, (_senderStats.get(name) || 0) + 1);
}

// Called once per message_N.json. Updates aggregate stats only.
function _learnThreadParticipants(threadPath, participants) {
    if (!Array.isArray(participants)) return;
    const set = _threadParticipants.get(threadPath) || new Set();
    for (const p of participants) {
        if (p && typeof p.name === 'string' && p.name) set.add(p.name);
    }
    if (set.size) _threadParticipants.set(threadPath, set);
}

// Called once after enough data is collected.
// Rule: if a sender matches knownUserGuess, use it; otherwise pick the most active sender.
function _decideOwnerFromStats() {
    if (ownerName || _senderStats.size === 0) return;
    if (knownUserGuess) {
        const g = knownUserGuess.toLowerCase().replace(/[^a-z0-9]/g,'');
        if (g) {
            let best = null, bestScore = 0;
            for (const [name, count] of _senderStats) {
                const nl = name.toLowerCase().replace(/[^a-z0-9]/g,'');
                if (!nl) continue;
                let score = 0;
                if (nl === g) score = 10000 + count;
                else if (g.includes(nl) || nl.includes(g)) score = 5000 + count;
                if (score > bestScore) { bestScore = score; best = name; }
            }
            if (best) { ownerName = best; return; }
        }
    }
    // fallback: most active sender
    let maxName = null, maxCount = 0;
    for (const [name, count] of _senderStats) if (count > maxCount) { maxCount = count; maxName = name; }
    ownerName = maxName;
}

// Race-condition protection: only one ZIP can be processed at a time.
let isProcessingZip = false;

// ========== Source definitions ==========
const DATA_SOURCES = [
    // --- Account/security sources ---
    { key: 'login',    fileMatch: /login_activity\.json$/i,       label: 'Login Records',      icon: 'fa-right-to-bracket', required: true, kind: 'session' },
    { key: 'logout',   fileMatch: /logout_activity\.json$/i,             label: 'Logout Records',     icon: 'fa-right-from-bracket', required: false, kind: 'session' },
    { key: 'profile',  fileMatch: /profile_activity\.json$/i,              label: 'Profile Activity',    icon: 'fa-id-badge', required: false, kind: 'metadata' },
    { key: 'signup',   fileMatch: /signup_details\.json$/i,                label: 'Signup Date',        icon: 'fa-cake-candles', required: false, kind: 'metadata' },
    { key: 'account_security', fileMatch: /(password_change_activity|profile_privacy_changes|profile_status_changes|last_known_location)\.json$/i, label: 'Account Security', icon: 'fa-shield-halved', required: false, kind: 'session' },
    // --- your_instagram_activity ---
    { key: 'comments', fileMatch: /comments\/.*\.json$/i,                   label: 'Comments',          icon: 'fa-comment', required: true, kind: 'session' },
    { key: 'likes',    fileMatch: /likes\/(liked_posts|liked_comments)\.json$/i, label: 'Likes',       icon: 'fa-heart', required: true, kind: 'session' },
    { key: 'story',    fileMatch: /story_interactions\/(story_likes|polls|quizzes|questions|emoji_sliders|countdowns|story_reaction_sticker_reactions)\.json$/i, label: 'Story Interactions', icon: 'fa-circle-play', required: false, kind: 'session' },
    { key: 'story_viewed', fileMatch: /story_interactions\/stories_viewed\.json$/i, label: 'Stories Viewed', icon: 'fa-eye', required: false, kind: 'active-days-only' },
    { key: 'saved',    fileMatch: /saved\/(saved_posts|saved_music|saved_collections)\.json$/i, label: 'Saved Items', icon: 'fa-bookmark', required: false, kind: 'session' },
    // messages: ONLY messages SENT by the user count toward usage time
    { key: 'messages', fileMatch: /messages\/(inbox|message_requests|ai_conversations)(\/.*)?\/message_\d+\.json$/i, label: 'Messages (inbox)', icon: 'fa-envelope', required: false, kind: 'session', sentOnly: true },
    { key: 'messages_bulk', fileMatch: /messages\/(ai_conversations|your_scheduled_chat_notifications)\.json$/i, label: 'Messages (bulk)', icon: 'fa-envelope-open', required: false, kind: 'session' },
    // secret_conversations.json: ig_secret_conversations.armadillo_devices[]
    { key: 'secret_devices', fileMatch: /messages\/secret_conversations\.json$/i, label: 'Secret Chat Devices', icon: 'fa-user-secret', required: false, kind: 'session' },
    // --- logged_information ---
    { key: 'searches', fileMatch: /recent_searches\/(profile_searches|word_or_phrase_searches)\.json$/i, label: 'Searches', icon: 'fa-magnifying-glass', required: false, kind: 'session' },
];

// ========== Custom Streaming ZIP Parser ==========
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG   = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

function readU32LE(buf, off) { return buf[off] + (buf[off+1]*0x100) + (buf[off+2]*0x10000) + (buf[off+3]*0x1000000); }
function readU16LE(buf, off) { return buf[off] + (buf[off+1]*0x100); }

async function readZipCentralDirectory(file) {
    const size = file.size;
    const tailSize = Math.min(size, 65557);
    const tailBuf = new Uint8Array(await file.slice(size - tailSize, size).arrayBuffer());
    let eocdOffset = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
        if (readU32LE(tailBuf, i) === ZIP_EOCD_SIG) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) throw new Error('EOCD not found  not a valid ZIP');
    const cdEntries = readU16LE(tailBuf, eocdOffset + 10);
    const cdOffset = readU32LE(tailBuf, eocdOffset + 16);
    const cdBuf = new Uint8Array(await file.slice(cdOffset, size - tailSize + eocdOffset).arrayBuffer());
    const entries = [];
    let p = 0;
    for (let i = 0; i < cdEntries; i++) {
        if (readU32LE(cdBuf, p) !== ZIP_CD_SIG) break;
        const compMethod = readU16LE(cdBuf, p + 10);
        const compSize = readU32LE(cdBuf, p + 20);
        const uncompSize = readU32LE(cdBuf, p + 24);
        const nameLen = readU16LE(cdBuf, p + 28);
        const extraLen = readU16LE(cdBuf, p + 30);
        const commentLen = readU16LE(cdBuf, p + 32);
        const localHeaderOffset = readU32LE(cdBuf, p + 42);
        let name = '';
        for (let c = 0; c < nameLen; c++) name += String.fromCharCode(cdBuf[p + 46 + c]);
        try { name = decodeURIComponent(escape(name)); } catch {}
        entries.push({ name, compMethod, compSize, uncompSize, localHeaderOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

async function readZipEntry(file, entry) {
    const lhBuf = new Uint8Array(await file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
    if (readU32LE(lhBuf, 0) !== ZIP_LOCAL_SIG) throw new Error('Corrupt local header: ' + entry.name);
    const lhNameLen = readU16LE(lhBuf, 26);
    const lhExtraLen = readU16LE(lhBuf, 28);
    const dataOffset = entry.localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const raw = await file.slice(dataOffset, dataOffset + entry.compSize).arrayBuffer();
    if (entry.compMethod === 0) {
        return new TextDecoder('utf-8').decode(new Uint8Array(raw));
    } else if (entry.compMethod === 8) {
        const blob = new Blob([raw]);
        const ds = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const decompressed = await new Response(ds).arrayBuffer();
        return new TextDecoder('utf-8').decode(new Uint8Array(decompressed));
    }
    throw new Error('Unknown compression: ' + entry.compMethod);
}

// ========== Live Terminal Logging ==========
function openTerminalModal() {
    if (typeof terminalModal !== 'undefined' && terminalModal) {
        terminalModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        if (typeof terminalBody !== 'undefined' && terminalBody) terminalBody.innerHTML = '';
    }
}
function appendTerminalLine(type, text) {
    if (typeof terminalBody === 'undefined' || !terminalBody) return;
    const line = document.createElement('div');
    const colors = { ok:'text-teal-400', warn:'text-amber-400', error:'text-red-400', info:'text-slate-400' };
    line.className = `text-xs ${colors[type] || 'text-slate-300'} font-mono leading-relaxed`;
    line.textContent = text;
    terminalBody.appendChild(line);
    terminalBody.scrollTop = terminalBody.scrollHeight;
}
function setTerminalStatus(isSuccess) {
    if (typeof terminalStatus === 'undefined' || !terminalStatus) return;
    if (isSuccess) {
        terminalStatus.innerHTML = '<i class="fa-solid fa-circle-check text-teal-400"></i> <span class="text-teal-300">All checks completed</span>';
    } else {
        terminalStatus.innerHTML = '<i class="fa-solid fa-circle-xmark text-red-400"></i> <span class="text-red-300">An error occurred during checks</span>';
    }
}

// ========== Main ZIP Processing ==========
async function handleZipFile(file) {    if (isProcessingZip) {
        appendTerminalLine('warn', `> New ZIP rejected  previous file is still processing. Please wait.`);
        showFileStatus('Previous file still processing  please wait', true);
        return;
    }
    isProcessingZip = true;
    try {
        await handleZipFileInner(file);
    } finally {
        isProcessingZip = false;
    }
}

async function handleZipFileInner(file) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
        showFileStatus('Only .zip Instagram export files are accepted. Check the file extension.', true);
        return;
    }

    openTerminalModal();
    showFileStatus(`Scanning ZIP: ${file.name}...`);

    extraMetadata = { devices: {}, locations: {}, ips: {}, signupDate: null };
    rawTimestamps = [];
    activeDayTimestamps = [];
    rawTimestampSources = {};
    loginLogoutPairs = [];
    activityRecords = [];

    // Reset state for account owner detection  guess from filename.
    ownerName = null;
    knownUserGuess = guessOwnerFromFilename(file.name) || null;
    _senderStats.clear();
    _threadParticipants.clear();

    appendTerminalLine('info', `> Scanning ZIP: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)`);
    if (knownUserGuess) appendTerminalLine('info', `> Account guess (from filename): ${knownUserGuess}`);
    
    let entries = [];
    try {
        entries = await readZipCentralDirectory(file);
        appendTerminalLine('info', `> ${entries.length} files found in ZIP.`);
    } catch (err) {
        appendTerminalLine('error', `> ERROR: Could not read ZIP: ${err.message}`);
        setTerminalStatus(false);
        showFileStatus("ZIP could not be read", true);
        return;
    }
    
    // Message parsing is 2 PHASES:
    // (A) First all message_N.json files are read  SENDER STATS collected only
    //     (no events emitted). This finalizes ownerName.
    // (B) Then all sources are processed. Text from _inboxCache is reused for
    //     messages (no double ZIP disk I/O).
    const _inboxCache = new Map();   // entry.name → jsonText (messages source only)
    const messagesSrc = DATA_SOURCES.find(s => s.key === 'messages');
    if (messagesSrc) {
        const mEntries = entries.filter(e => messagesSrc.fileMatch.test(e.name));
        for (const entry of mEntries) {
            try {
                const jsonText = await readZipEntry(file, entry);
                _inboxCache.set(entry.name, jsonText);
                // Statistics only: parse, collect sender/participants
                try {
                    const data = JSON.parse(jsonText);
                    if (Array.isArray(data.participants)) _learnThreadParticipants(entry.name, data.participants);
                    const msgs = Array.isArray(data.messages) ? data.messages : null;
                    if (msgs) {
                        for (const m of msgs) {
                            if (m && typeof m.sender_name === 'string') _learnSender(m.sender_name);
                        }
                    }
                } catch (_) { /* parse error: processSourceFile retries later */ }
            } catch (_) { /* file unreadable: retried later */ }
        }
        _decideOwnerFromStats();
        if (ownerName) appendTerminalLine('info', `> Account owner detected: ${ownerName} (only messages sent by them will count)`);
        else appendTerminalLine('warn', `> Account owner could not be detected  all messages will count`);
    }

    for (const src of DATA_SOURCES) {
        const matched = entries.filter(e => src.fileMatch.test(e.name));
        if (matched.length > 0) {
            let totalTsForSource = 0, errorsForSource = 0;
            for (const entry of matched) {
                try {
                    const jsonText = _inboxCache.get(entry.name) || await readZipEntry(file, entry);
                    const result = processSourceFile(src, jsonText);
                    totalTsForSource += result.tsCount;
                    if (result.error) errorsForSource++;
                } catch (e) { errorsForSource++; }
            }
            if (src.kind === 'metadata') {
                appendTerminalLine('ok', `  [\u2713] ${src.label}: processed`);
            } else if (totalTsForSource > 0) {
                appendTerminalLine('ok', `  [\u2713] ${src.label}: ${totalTsForSource} events (${matched.length} files)`);
                if (errorsForSource > 0) appendTerminalLine('info', `     \u2937 ${errorsForSource}/${matched.length} files had no timestamps`);
            } else {
                appendTerminalLine('warn', `  [!] ${src.label}: ${matched.length} files found but no timestamps`);
            }
        } else {
            appendTerminalLine(src.required ? 'warn' : 'info', `  [${src.required ? '!' : 'i'}] ${src.label} ${src.required ? 'MISSING (required)' : 'not present (optional)'}`);
        }
    }
    _inboxCache.clear(); // free up large strings (669K+ lines)

    // Report incoming message count via config for visibility
    if (rawTimestampSources._msgs_in) {
        appendTerminalLine('info', `> Incoming messages (excluded from time, only active days): ${rawTimestampSources._msgs_in}`);
    }

    appendTerminalLine('info', `> ─────────────────────────────`);
    appendTerminalLine('info', `> Total ${rawTimestamps.length} events merged.`);
    appendTerminalLine('info', `> Source distribution: ${Object.entries(rawTimestampSources).filter(([k]) => !k.startsWith('_')).map(([k,v]) => `${k}:${v}`).join(', ') || 'none'}${activeDayTimestamps.length > 0 ? ` | active-days:${activeDayTimestamps.length}` : ''}`);
    
    if (rawTimestamps.length < 2) {
        appendTerminalLine('error', '> ERROR: At least 2 timestamps are required. Processing halted.');
        setTerminalStatus(false);
        showFileStatus("Insufficient data", true);
        return;
    }
    
    rawTimestamps.sort((a, b) => a.date - b.date);
    
    const beforeDedup = rawTimestamps.length;
    const SOURCE_PRIORITY = ['logout','login','account_security','secret_devices','messages','messages_bulk','saved','searches','comments','likes','story','story_viewed'];
    const deduped = [];
    for (const t of rawTimestamps) {
        if (deduped.length === 0) { deduped.push(t); continue; }
        const last = deduped[deduped.length - 1];
        if (Math.abs(t.date.getTime() - last.date.getTime()) >= 1000) { deduped.push(t); }
        else if (SOURCE_PRIORITY.indexOf(t.source) < SOURCE_PRIORITY.indexOf(last.source)) { deduped[deduped.length - 1] = t; }
    }
    rawTimestamps = deduped;
    if (beforeDedup !== rawTimestamps.length) {
        appendTerminalLine('info', `> Dedup: ${beforeDedup - rawTimestamps.length} events collapsed (${beforeDedup} → ${rawTimestamps.length})`);
    }
    
    // Fill raw activity records: ms epoch list for the hourly chart (time-counting events only)
    activityRecords = rawTimestamps.map(t => t.date.getTime());
    
    // Recalculate source counters AFTER dedup based on the real state
    rawTimestampSources = {};
    for (const t of rawTimestamps) {
        rawTimestampSources[t.source] = (rawTimestampSources[t.source] || 0) + 1;
    }
    const activeDaySourceCount = {};
    // activeDayTimestamps is not an object but a Date list  its source is carried over
    rawTimestampSources._activeDays = activeDayTimestamps.length;
    
    // Login Logout matching
    const logins  = rawTimestamps.filter(t => t.source === 'login').map(t => t.date);
    const logouts = rawTimestamps.filter(t => t.source === 'logout').map(t => t.date);
    if (logouts.length > 0) {
        const sLogins = logins.slice().sort((a,b)=>a-b), sLogouts = logouts.slice().sort((a,b)=>a-b);
        let lIdx = 0;
        sLogins.forEach((login, idx) => {
            while (lIdx < sLogouts.length && sLogouts[lIdx].getTime() < login.getTime()) lIdx++;
            if (lIdx < sLogouts.length) {
                const candidate = sLogouts[lIdx];
                const nextLogin = (idx + 1 < sLogins.length) ? sLogins[idx + 1] : null;
                if (!nextLogin || candidate.getTime() < nextLogin.getTime()) {
                    loginLogoutPairs.push({ login, logout: candidate }); lIdx++;
                } else { loginLogoutPairs.push({ login, logout: null }); }
            } else { loginLogoutPairs.push({ login, logout: null }); }
        });
        appendTerminalLine('info', `> Login↔Logout: ${logins.length} logins, ${logouts.length} logouts, ${loginLogoutPairs.filter(p=>p.logout).length} pairs found.`);
    }
    
    const missingRequired = DATA_SOURCES.filter(s => s.required && !rawTimestampSources[s.key]);
    if (missingRequired.length > 0) appendTerminalLine('warn', `> MISSING required source: ${missingRequired.map(s=>s.label).join(',')}`);
    appendTerminalLine('ok', `> CHECK COMPLETE. ${rawTimestamps.length} events ready.`);
    setTerminalStatus(true);
    
    setTimeout(() => {
        console.log('[DEBUG handleZipFile setTimeout fired] rawTimestamps.len =', rawTimestamps.length, 'typeof recalculateAndRender =', typeof recalculateAndRender, 'typeof resultsSection =', typeof resultsSection);
        showFileStatus(`${rawTimestamps.length} events processed (${Object.keys(rawTimestampSources).length} sources)`);
if (typeof resultsSection !== 'undefined' && resultsSection) resultsSection.classList.remove('hidden');
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (typeof recalculateAndRender === 'function') {
                try {
                    recalculateAndRender();
                } catch (err) {
                    console.error('[DEBUG] recalculateAndRender CRASHED:', err);
                    appendTerminalLine('error', `> ERROR: Calculation crashed (KPIs could not be written): ${err.message}`);
                    showFileStatus(`Calculation error: ${err.message}`, true);
                }
            } else {
                // app.js not loaded/parse failed → recalculateAndRender never defined.
                console.error('[DEBUG] recalculateAndRender UNDEFINED  app.js failed to load / parse error');
                appendTerminalLine('error', '> ERROR: app.js failed to load (recalculateAndRender undefined). Check browser Console (F12).');
                showFileStatus('app.js failed to load  refresh page (Ctrl+R)', true);
            }
            if (typeof resultsSection !== 'undefined' && resultsSection) resultsSection.scrollIntoView({ behavior: 'smooth' });
        }));
    }, 400);
}

// ========== Source File Processing ==========
function processSourceFile(src, jsonText) {
    try {
        if (src.kind === 'metadata' && src.key === 'profile') { extractMetadataFromProfileActivity(jsonText); return { tsCount: 0, error: false }; }
        else if (src.kind === 'metadata' && src.key === 'signup') { extractSignupDate(jsonText); return { tsCount: 0, error: false }; }
        else {
            const events = extractTimestampsFromJson(jsonText, src.key);
            // Extract device + IP/network distribution from login_activity.json.
            if (src.key === 'login') extractMetadataFromLoginActivity(jsonText);
            // Sent/received separation (only on sentOnly sources, eg. messages)
            let outEvents = events, inEvents = [];
            if (src.sentOnly && ownerName) {
                outEvents = [];
                inEvents = [];
                for (const ev of events) {
                    if (ev.meta && ev.meta.sender === ownerName) outEvents.push(ev);
                    else inEvents.push(ev);
                }
                rawTimestampSources._msgs_in = (rawTimestampSources._msgs_in || 0) + inEvents.length;
            }
            rawTimestampSources[src.key] = (rawTimestampSources[src.key] || 0) + outEvents.length;
            if (inEvents.length) rawTimestampSources._msgs_in_label = rawTimestampSources._msgs_in; // visibility in reports
            if (src.kind === 'active-days-only') {
                for (const ev of events) activeDayTimestamps.push(ev.date);
            } else {
                for (const ev of outEvents) rawTimestamps.push(ev);
                for (const ev of inEvents)  activeDayTimestamps.push(ev.date);
            }
            return { tsCount: outEvents.length, error: outEvents.length === 0 };
        }
    } catch (e) { return { tsCount: 0, error: true }; }
}

function extractTimestampsFromJson(jsonString, sourceKey) {
    const data = JSON.parse(jsonString);
    const events = [];
    let arr = null;
    if (Array.isArray(data)) { arr = data; }
    else {
        const PREFERRED = ['messages','comments_reels_comments','comments_story_comments',
                           'likes_comment_likes','searches_user','searches_keyword',
                           'account_history_login_history','account_history_logout_history',
                           'account_history_registration_info','armadillo_devices'];
        for (const pk of PREFERRED) { if (Array.isArray(data[pk]) && data[pk].length > 0) { arr = data[pk]; break; } }
        if (!arr) {
            // Nested scan: if data is an object, merge ALL arrays inside (at least 1 element)
            const nestedArrays = [];
            const collectArrays = (obj, depth) => {
                if (!obj || typeof obj !== 'object' || depth > 4) return;
                if (Array.isArray(obj)) {
                    if (obj.length > 0) nestedArrays.push(obj);
                    for (const item of obj) collectArrays(item, depth + 1);
                    return;
                }
                for (const k in obj) collectArrays(obj[k], depth + 1);
            };
            collectArrays(data, 0);
            // Merge all found arrays into one  no data loss
            for (const a of nestedArrays) {
                if (!arr) arr = [];
                for (const item of a) arr.push(item);
            }
        }
    }
    if (!arr || arr.length === 0) return events;
    for (const e of arr) {
        let ts = extractAnyTimestamp(e);
        if (ts && ts > 0) {
            const d = normalizeTimestamp(ts);
            if (d && !isNaN(d.getTime()) && d.getFullYear() >= 2010 && d.getFullYear() <= new Date().getFullYear() + 1) {
                // Preserve sender_name as meta  used in the next step (processSourceFile)
                // for the sent/received split. Not required on other sources.
                events.push({ date: d, source: sourceKey, meta: { sender: e.sender_name, isMe: e.is_me === true } });
            }
        }
    }
    return events;
}

// Extract Instagram handle from the ZIP filename
function guessOwnerFromFilename(fname) {
    if (!fname) return null;
    const m = fname.match(/^instagram-(.+?)-\d{4}-\d{2}-\d{2}(?:-.+)?\.zip$/i);
    return m ? m[1] : null;
}

function extractAnyTimestamp(e) {
    if (!e || typeof e !== 'object') return null;
    if (typeof e.timestamp === 'number' && e.timestamp > 0) return e.timestamp;
    if (typeof e.creation_timestamp === 'number' && e.creation_timestamp > 0) return e.creation_timestamp;
    if (typeof e.timestamp_ms === 'number' && e.timestamp_ms > 0) return e.timestamp_ms;
    // secret_conversations.json: armadillo_devices[].last_active_time (unix saniye)
    if (typeof e.last_active_time === 'number' && e.last_active_time > 0) return e.last_active_time;   // secret_conversations.json: unix seconds
    if (e.string_map_data && e.string_map_data.Time && typeof e.string_map_data.Time.timestamp === 'number' && e.string_map_data.Time.timestamp > 0) return e.string_map_data.Time.timestamp;
    if (Array.isArray(e.string_list_data) && e.string_list_data[0] && typeof e.string_list_data[0].timestamp === 'number' && e.string_list_data[0].timestamp > 0) return e.string_list_data[0].timestamp;
    if (Array.isArray(e.label_values)) {
        for (const lv of e.label_values) { if (typeof lv.timestamp_value === 'number' && lv.timestamp_value > 0) return lv.timestamp_value; }
    }
    if (e.string_map_data) {
        for (const k in e.string_map_data) {
            const sub = e.string_map_data[k];
            if (sub && typeof sub === 'object' && typeof sub.timestamp === 'number' && sub.timestamp > 0) return sub.timestamp;
        }
    }
    if (typeof e.title === 'string' && e.title.length > 10 && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.title)) { const d = new Date(e.title); if (!isNaN(d.getTime())) return d.getTime(); }
    if (typeof e.timestamp === 'string') { const d = new Date(e.timestamp); if (!isNaN(d.getTime())) return d.getTime(); }
    if (typeof e.creation_timestamp === 'string') { const d = new Date(e.creation_timestamp); if (!isNaN(d.getTime())) return d.getTime(); }
    if (typeof e.last_active_time === 'string') { const d = new Date(e.last_active_time); if (!isNaN(d.getTime())) return d.getTime(); }
    return null;
}

function normalizeTimestamp(ts) {
    if (typeof ts !== 'number') return new Date(ts);
    let finalMs;
    if (ts < 10000000000)         finalMs = ts * 1000;
    else if (ts < 10000000000000) finalMs = ts;
    else                            finalMs = ts / 1000;
    return new Date(finalMs);
}

function extractMetadataFromProfileActivity(jsonString) {
    const data = JSON.parse(jsonString);
    // profile_activity.json is an array in old format, a single object in new format.
    const items = Array.isArray(data) ? data : [data];
    for (const e of items) {
        if (!e || !e.label_values) continue;
        for (const lv of e.label_values) {
            if (lv.label === 'App' && lv.value) {
                const cat = categorizeDevice(lv.value);
                extraMetadata.devices[cat] = (extraMetadata.devices[cat] || 0) + 1;
            }
            if (lv.dict && Array.isArray(lv.dict)) {
                for (const d of lv.dict) {
                    if (d.label === 'Location' && d.value) {
                        extraMetadata.locations[d.value] = (extraMetadata.locations[d.value] || 0) + 1;
                    }
                }
            }
        }
    }
}

// Extract device + IP/network distribution from login_activity.json
function normalizeIpKey(ip) {
    ip = String(ip || '').trim();
    if (!ip) return '';
    if (ip.includes(':')) {
        const parts = ip.toLowerCase().split(':');
        return parts.slice(0, 4).join(':') + '::/64';
    }
    return ip; // IPv4: full address
}

function extractMetadataFromLoginActivity(jsonString) {
    const data = JSON.parse(jsonString);
    const arr = data.account_history_login_history || [];
    for (const e of arr) {
        if (!e || !e.string_map_data) continue;
        const sm = e.string_map_data;
        const ua = (sm['User Agent'] && sm['User Agent'].value) || '';
        if (ua) {
            const cat = categorizeDevice(ua);   // single call  old version called it twice
            extraMetadata.devices[cat] = (extraMetadata.devices[cat] || 0) + 1;
        }
        // Raw IP is collected; geographic resolution (city: Istanbul, Berlin...) is done in app.js
        const ip = String((sm['IP Address'] && sm['IP Address'].value) || '').trim();
        if (ip) {
            extraMetadata.ips[ip] = (extraMetadata.ips[ip] || 0) + 1;
        }
    }
}

function extractSignupDate(jsonString) {
    const data = JSON.parse(jsonString);
    const arr = data.account_history_registration_info || [];
    if (arr.length === 0) return;
    const ts = arr[0]?.string_map_data?.Time?.timestamp;
    if (ts && ts > 0) {
        extraMetadata.signupDate = normalizeTimestamp(ts);
    }
}

function categorizeDevice(rawDevice) {
    if (!rawDevice) return 'Unknown';
    const d = rawDevice.toLowerCase();
    if (d.includes('windows')) return 'Windows';
    if (d.includes('iphone') || d === 'ios') return 'iOS';
    if (d.includes('android')) return 'Android';
    if (d === 'web' || d.includes('mac')) return 'Web/Mac';
    return rawDevice;
}

function showFileStatus(text, isError = false) {
    if (typeof fileStatus === 'undefined' || !fileStatus) return;
    fileStatus.classList.remove('hidden');
    if (typeof fileStatusText !== 'undefined') fileStatusText.textContent = text;
    if (isError) {
        fileStatus.className = "mt-4 px-3 py-1.5 bg-red-950/40 border border-red-800 rounded-md text-xs text-red-300 flex items-center gap-2";
    } else {
        fileStatus.className = "mt-4 px-3 py-1.5 bg-slate-900/60 border border-slate-700 rounded-md text-xs text-slate-200 flex items-center gap-2";
    }
}