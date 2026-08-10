// ============================================================================
// app.js
//
// DOM interactions, session algorithm (recalculateAndRender), and chart
// rendering for the Instagram Usage Time Analyzer.
//
// This file must be loaded AFTER parser.js and sample-data.js.
// It consumes the globals produced by parser.js (rawTimestamps,
// loginLogoutPairs, DATA_SOURCES, etc.) and renders the results.
//
// Responsibilities:
//   - Upload zone wiring, drag-and-drop, sample-data button
//   - Session estimation algorithm (10-minute idle-gap checkpoint)
//   - KPI cards, monthly chart, hourly chart, yearly table, device doughnut
//   - IP-to-city geolocation (opt-in via user click)
//   - Markdown report generation and download
//
// Globals consumed (from parser.js):
//   rawTimestamps, activeDayTimestamps, rawTimestampSources, loginLogoutPairs,
//   activityRecords, extraMetadata, ownerName, knownUserGuess, DATA_SOURCES
// ============================================================================

// ========== Chart instances ==========
let monthlyChartInstance = null;
let hourlyChartInstance = null;
let deviceChartInstance = null;
// Latest computed total usage time (seconds). Used by device/location distribution
// to show "hours / %". Stored by renderExtraMetadata.
let lastTotalSeconds = 0;
// Extra snapshots for Markdown export (updated in recalculateAndRender)
let lastYearlyStats = {};
let lastMonthlyData = {};
let lastSessionCount = 0;
let lastActiveDaysCount = 0;
let lastActiveDayPercentage = '0';
let lastDailyAvgMinutes = 0;
// Active time range (hourly chart filtering)
let currentHourlyRange = 'all';

// ========== DOM Elements ==========
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const sampleBtn = document.getElementById('sample-btn');
const fileStatus = document.getElementById('file-status');
const fileStatusText = document.getElementById('file-status-text');
// Settings sliders removed: fixed 10-minute checkpoint, no cap.

const resultsSection = document.getElementById('results-section');

// ========== Event Listeners ==========
browseBtn.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (e) => {
    if (e.target === browseBtn || browseBtn.contains(e.target) || 
        e.target === sampleBtn || sampleBtn.contains(e.target)) return;
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleZipFile(e.target.files[0]);
    // Reset value so the same file can be re-selected. Otherwise the 'change'
    // event does not fire when the user picks the same ZIP again.
    e.target.value = '';
});

// Drag and drop
['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.add('border-slate-400', 'bg-slate-900/40');
    }, false);
});
['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.remove('border-slate-400', 'bg-slate-900/40');
    }, false);
});
dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files[0]) handleZipFile(files[0]);
});

sampleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    loadSampleData();
});

// ========== Guide Modal ==========
const guideModal = document.getElementById('guide-modal');
const openGuideBtn = document.getElementById('open-guide-btn');
const closeGuideBtn = document.getElementById('close-guide-btn');
const closeGuideBtn2 = document.getElementById('close-guide-btn-2');

function openGuide() {
    guideModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}
function closeGuide() {
    guideModal.classList.add('hidden');
    document.body.style.overflow = '';
}
openGuideBtn.addEventListener('click', openGuide);
closeGuideBtn.addEventListener('click', closeGuide);
closeGuideBtn2.addEventListener('click', closeGuide);
guideModal.addEventListener('click', (e) => { if (e.target === guideModal) closeGuide(); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !guideModal.classList.contains('hidden')) closeGuide();
});

// ========== Terminal Modal ==========
const terminalModal = document.getElementById('terminal-modal') || null;
const terminalCloseBtn = document.getElementById('terminal-close-btn') || null;
const terminalBody = document.getElementById('terminal-body') || null;
const terminalStatus = document.getElementById('terminal-status') || null;

function closeTerminalModal() {
    if (terminalModal) {
        terminalModal.classList.add('hidden');
        document.body.style.overflow = '';
    }
}
if (terminalCloseBtn) terminalCloseBtn.addEventListener('click', closeTerminalModal);
const terminalCloseBtn2 = document.getElementById('terminal-close-btn-2') || null;
if (terminalCloseBtn2) terminalCloseBtn2.addEventListener('click', closeTerminalModal);
if (terminalModal) {
    terminalModal.addEventListener('click', (e) => {
        if (e.target === terminalModal) closeTerminalModal();
    });
}

// ============================================================================
// Algorithm: Simple Checkpoint Logic
// - rawTimestamps is traversed once, in chronological order.
// ============================================================================

function recalculateAndRender() {
    try {
    console.log('[DEBUG recalculateAndRender] called. rawTimestamps.len =', rawTimestamps ? rawTimestamps.length : 'null/undef', 'activeDay.len =', activeDayTimestamps ? activeDayTimestamps.length : 'null/undef');
    if (!rawTimestamps || rawTimestamps.length < 2) {
        console.warn('[DEBUG recalculateAndRender] EARLY RETURN: insufficient data');
        return;
    }

    const idleTimeoutSeconds = 10 * 60;  // 600 sec  user's preference: moderate gap cutoff
    const SESSION_MAX_SEC = 24 * 3600;   // one session cannot exceed 24h (safety)

    // --- Hourly distribution: computed once for all sessions ---
    // renderHourlyChart filters by active range and calls this
    const hourlyByRange = {
        '7d':  new Array(24).fill(0),
        '30d': new Array(24).fill(0),
        '90d': new Array(24).fill(0),
        '365d': new Array(24).fill(0),
        'all': new Array(24).fill(0)
    };

    const dataMaxMs = rawTimestamps[rawTimestamps.length - 1].date.getTime();
    const rangeCutoffs = {
        '7d':  dataMaxMs - 7 * 24 * 3600 * 1000,
        '30d': dataMaxMs - 30 * 24 * 3600 * 1000,
        '90d': dataMaxMs - 90 * 24 * 3600 * 1000,
        '365d': dataMaxMs - 365 * 24 * 3600 * 1000,
        'all': -Infinity
    };

    const monthlyData = {};
    const yearlyStats = {};
    const activeDaysSet = new Set();

    for (const evt of rawTimestamps) {
        const d = evt.date;
        const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        activeDaysSet.add(dayKey);
        const yearKey = d.getFullYear().toString();
        if (!yearlyStats[yearKey]) yearlyStats[yearKey] = { totalEntries: 0, sessionCount: 0, totalSeconds: 0, activeDays: new Set() };
        yearlyStats[yearKey].totalEntries++;
        yearlyStats[yearKey].activeDays.add(dayKey);
    }
    for (const d of activeDayTimestamps) {
        // stories_viewed type high-frequency sources
        const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        activeDaysSet.add(dayKey);
        // stories_viewed days.
        const yrKey = d.getFullYear().toString();
        if (!yearlyStats[yrKey]) yearlyStats[yrKey] = { totalEntries: 0, sessionCount: 0, totalSeconds: 0, activeDays: new Set() };
        yearlyStats[yrKey].activeDays.add(dayKey);
    }

    // --- Login-Logout pairs (real duration override, sorted by time) ---
    const loginLogoutPairsSorted = loginLogoutPairs
        .filter(p => p.logout && p.logout.getTime() > p.login.getTime())
        .map(p => ({ loginMs: p.login.getTime(), logoutMs: p.logout.getTime(),
                      durSec: Math.min((p.logout.getTime() - p.login.getTime()) / 1000, SESSION_MAX_SEC) }))
        .sort((a, b) => a.loginMs - b.loginMs);

    // Returns the duration of the first login-logout pair overlapping session [startMs, endMs]
    let pairPtr = 0;
    function findKnownDuration(sessionStartMs, sessionEndMs) {
        // Skip if the pair's login is NOT within the session [start, end] range
        while (pairPtr < loginLogoutPairsSorted.length && loginLogoutPairsSorted[pairPtr].loginMs < sessionStartMs) pairPtr++;
        if (pairPtr < loginLogoutPairsSorted.length
            && loginLogoutPairsSorted[pairPtr].loginMs >= sessionStartMs
            && loginLogoutPairsSorted[pairPtr].loginMs <= sessionEndMs
            && loginLogoutPairsSorted[pairPtr].logoutMs <= sessionEndMs) {
            return loginLogoutPairsSorted[pairPtr].durSec;
        }
        return undefined;
    }

    // --- Checkpoint clustering ---
    const sessionRecords = [];

    let sessionStart = rawTimestamps[0].date;
    let sessionLastDate = rawTimestamps[0].date;
    let sessionAccumSec = 0;          // Σ actual gaps

    // Splits the session duration into hourly buckets; sums the time that falls into each hour.
    function addToHourlyBuckets(startMs, durationSec) {
        if (durationSec <= 0) return;
        let remainMs = durationSec * 1000;
        let t = startMs;
        for (;;) {
            const d = new Date(t);
            const hour = d.getHours();
            const nextHourStart = new Date(d);
            nextHourStart.setHours(hour + 1, 0, 0, 0);
            const avail = Math.min(remainMs, nextHourStart.getTime() - t);
            const sec = avail / 1000;
            for (const [key, cutoff] of Object.entries(rangeCutoffs)) {
                if (t >= cutoff) hourlyByRange[key][hour] += sec;
            }
            remainMs -= avail;
            if (remainMs <= 0) break;
            t = nextHourStart.getTime();
        }
    }

    function closeSession() {
        // Is there a known login-logout pair inside the session?
        const sessionEndMs = sessionLastDate.getTime();
        const knownSec = findKnownDuration(sessionStart.getTime(), sessionEndMs);
        let totalSec;
        if (knownSec !== undefined) {
            totalSec = Math.max(sessionAccumSec, knownSec, 60);
        } else {
            // Pure actual gap sum   no weighting, min 60 sec.
            totalSec = Math.max(sessionAccumSec, 60);
        }
        totalSec = Math.min(totalSec, SESSION_MAX_SEC);

        const sd = new Date(sessionStart.getTime());
        const monthKey = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, '0')}`;
        const yearKey  = sd.getFullYear().toString();
        const dayKey   = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, '0')}-${String(sd.getDate()).padStart(2, '0')}`;
        sessionRecords.push({ startMs: sessionStart.getTime(), totalSeconds: totalSec, monthKey, yearKey, dayKey });
        addToHourlyBuckets(sessionStart.getTime(), totalSec);
    }

    for (let i = 0; i < rawTimestamps.length; i++) {
        const cur = rawTimestamps[i];
        if (i === 0) {
            sessionStart = cur.date;
            sessionLastDate = cur.date;
            sessionAccumSec = 0;
            continue;
        }

        const gapSec = (cur.date.getTime() - sessionLastDate.getTime()) / 1000;

        if (gapSec > idleTimeoutSeconds) {
            // Close the previous session, start a new one
            closeSession();
            sessionStart = cur.date;
            sessionLastDate = cur.date;
            sessionAccumSec = 0;
        } else {
            // Same session: add actual gap (NO weighting)
            sessionAccumSec += gapSec;
            sessionLastDate = cur.date;
        }

        if (i === rawTimestamps.length - 1) closeSession();
    }

    // --- Monthly/Yearly distribution (no cap) ---
    let totalSeconds = 0;
    for (const rec of sessionRecords) {
        monthlyData[rec.monthKey] = (monthlyData[rec.monthKey] || 0) + rec.totalSeconds;
        if (yearlyStats[rec.yearKey]) yearlyStats[rec.yearKey].totalSeconds += rec.totalSeconds;
        if (yearlyStats[rec.yearKey]) yearlyStats[rec.yearKey].sessionCount++;
        totalSeconds += rec.totalSeconds;
    }

    const totalHours = totalSeconds / 3600;
    const totalDays  = totalHours / 24;
    // Store for device/location distribution "hours/%" display
    lastTotalSeconds = totalSeconds;

    // Date range: must cover both rawTimestamps and activeDayTimestamps
    let minMs = Infinity, maxMs = -Infinity;
    for (const r of rawTimestamps) {
        const ms = r.date.getTime();
        if (ms < minMs) minMs = ms;
        if (ms > maxMs) maxMs = ms;
    }
    for (const d of activeDayTimestamps) {
        const ms = d.getTime();
        if (ms < minMs) minMs = ms;
        if (ms > maxMs) maxMs = ms;
    }
    if (minMs === Infinity) { console.warn('[DEBUG] no dates for span'); return; }
    const firstDate = new Date(minMs);
    const lastDate  = new Date(maxMs);
    // Calendar day count = day difference between the two dates' midnights (00:00) + 1.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const startMidnight = Math.floor(minMs / DAY_MS);
    const endMidnight   = Math.floor(maxMs / DAY_MS);
    const totalSpanDays = Math.max(1, endMidnight - startMidnight + 1);
    const dailyAvgMinutes = Math.round((totalHours * 60) / totalSpanDays);
    const activeDaysCount = activeDaysSet.size;
    const activeDayPercentage = ((activeDaysCount / totalSpanDays) * 100).toFixed(1);
    const sessionCount = sessionRecords.length;

    // KPI
    document.getElementById('kpi-hours').textContent = totalHours.toLocaleString('en-US', { maximumFractionDigits: 1 });
    document.getElementById('kpi-days').textContent = `${totalDays.toLocaleString('en-US', { maximumFractionDigits: 1 })} days`;
    document.getElementById('kpi-sessions').textContent = sessionCount.toLocaleString('en-US');
    document.getElementById('kpi-total-entries').textContent = rawTimestamps.length.toLocaleString('en-US');
    document.getElementById('kpi-daily-avg').textContent = dailyAvgMinutes.toLocaleString('en-US');
    document.getElementById('kpi-total-span-days').textContent = `${totalSpanDays.toLocaleString('en-US')} days`;
    document.getElementById('kpi-first-date').textContent = formatDate(firstDate);
    document.getElementById('kpi-last-date').textContent = formatDate(lastDate);

    const activeDaysLabel = document.getElementById('kpi-active-days');
    if (activeDaysLabel) activeDaysLabel.textContent = `${activeDaysCount} days (${activeDayPercentage}%)`;

    renderYearlyTable(yearlyStats);

    // Store hourly data globally so buttons can access it
    window._hourlyByRange = hourlyByRange;
    
    // Set up button listeners (safe on multiple calls)
    setupHourlyRangeButtons();
    
    // First render: create charts after the scroll container width is computed
    setTimeout(() => {
        // Adjust scroll container width for the monthly chart
        const mc = document.getElementById('monthlyChart');
        const mcParent = document.getElementById('monthly-chart-container');
        if (mc && mcParent) {
            mcParent.style.height = '320px';
            mc.style.height = '320px';
        }
        const hc = document.getElementById('hourlyChart');
        if (hc) { hc.style.width = '100%'; hc.style.height = '100%'; }
        
        try { renderMonthlyChart(monthlyData); } catch(e) { console.warn('monthlyChart error:', e); }
        try { renderHourlyChart(); } catch(e) { console.warn('hourlyChart error:', e); }
        try { renderExtraMetadata(); } catch(e) { console.warn('extraMetadata error:', e); }
    }, 150);

    // Update snapshot variables (for Markdown export)
    lastYearlyStats = yearlyStats || {};
    lastMonthlyData = monthlyData || {};
    lastSessionCount = sessionCount || 0;
    lastActiveDaysCount = activeDaysCount || 0;
    lastActiveDayPercentage = activeDayPercentage || '0';
    lastDailyAvgMinutes = dailyAvgMinutes || 0;
    
    // Make the export button visible
    const exportBtn = document.getElementById('export-md-btn');
    if (exportBtn) {
        exportBtn.classList.remove('hidden');
    }
    } catch (err) {
        console.error('[recalculateAndRender] CRASH:', err);
        if (typeof showFileStatus === 'function') {
            showFileStatus('Calculation error: ' + err.message, true);
        }
        if (typeof appendTerminalLine === 'function') {
            appendTerminalLine('error', `> HATA: Calculation crashed: ${err.message}`);
        }
    }
}

// ========== Markdown Export Butonu ==========
// This block must be bound at page end (inside window.onload).
window._initExportButton = function() {
    const exportMdBtn = document.getElementById('export-md-btn');
    if (!exportMdBtn) return;
    
    // Set up once only
    if (exportMdBtn._mdBound) return;
    exportMdBtn._mdBound = true;
    
    exportMdBtn.addEventListener('click', () => {
        // Read data from global state (no other source)
        if (!rawTimestamps || rawTimestamps.length < 2) {
            alert('Load a ZIP file or use the sample data first.');
            return;
        }
        
        try {
            // State checks (null values would crash buildMarkdownReport)
            const safeD = {
                yearlyStats: lastYearlyStats || {},
                monthlyData: lastMonthlyData || {},
                totalHours: (lastTotalSeconds || 0) / 3600,
                totalDays: (lastTotalSeconds || 0) / 86400,
                sessionCount: lastSessionCount || 0,
                firstDate: rawTimestamps[0] ? new Date(rawTimestamps[0].date.getTime()) : new Date(),
                lastDate: rawTimestamps[rawTimestamps.length-1] ? new Date(rawTimestamps[rawTimestamps.length-1].date.getTime()) : new Date(),
                totalSpanDays: rawTimestamps.length > 1 ? Math.max(1, Math.floor((rawTimestamps[rawTimestamps.length-1].date - rawTimestamps[0].date) / 86400000)) : 0,
                activeDaysCount: lastActiveDaysCount || 0,
                activeDayPercentage: lastActiveDayPercentage || '0',
                dailyAvgMinutes: lastDailyAvgMinutes || 0
            };
            const safeExtra = {
                devices: (extraMetadata && extraMetadata.devices) || {},
                locations: (extraMetadata && extraMetadata.locations) || {},
                ips: (extraMetadata && extraMetadata.ips) || {},
                signupDate: extraMetadata && extraMetadata.signupDate ? extraMetadata.signupDate : null
            };
            const safeSources = rawTimestampSources || {};
            const safePairs = loginLogoutPairs || [];
            const safeActiveDays = activeDayTimestamps || [];
            
            const md = buildMarkdownReport(safeD, rawTimestamps, safeSources, safeExtra, safePairs, safeActiveDays);

            // Create blob and download
            const blob = new Blob([md], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'instagram-usage-time-analysis.md';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('[Markdown export] OK');
        } catch (err) {
            console.error('[Markdown export] HATA:', err);
            alert('Could not generate report: ' + err.message);
        }
    });

    // Make the button visible (skip if already visible)
    exportMdBtn.classList.remove('hidden');
    exportMdBtn.classList.add('visible');
};

// Init after page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window._initExportButton?.());
} else {
    setTimeout(() => window._initExportButton?.(), 0);
}

function formatDate(date) {
    return date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }) + 
           ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function renderYearlyTable(yearlyStats) {
    const tbody = document.getElementById('yearly-table-body');
    tbody.innerHTML = '';
    const years = Object.keys(yearlyStats).sort().reverse();
    for (const year of years) {
        const stat = yearlyStats[year];
        const yearHours = stat.totalSeconds / 3600;
        const yearDays = yearHours / 24;
        const activeDays = stat.activeDays ? stat.activeDays.size : 0;
        const tr = document.createElement('tr');
        tr.className = "hover:bg-slate-900/60 transition-colors";
        tr.innerHTML = `
            <td class="py-3 px-4 font-bold text-slate-100">${year}</td>
            <td class="py-3 px-4 text-slate-300">${stat.totalEntries.toLocaleString('en-US')}</td>
            <td class="py-3 px-4 text-slate-300">${stat.sessionCount.toLocaleString('en-US')}</td>
            <td class="py-3 px-4" style="color:#2eb41a">${activeDays.toLocaleString('en-US')}</td>
            <td class="py-3 px-4 font-semibold text-slate-100">${yearHours.toLocaleString('en-US', { maximumFractionDigits: 1 })} hours</td>
            <td class="py-3 px-4 text-slate-400">${yearDays.toLocaleString('en-US', { maximumFractionDigits: 1 })} days</td>
        `;
        tbody.appendChild(tr);
    }
}

// Monthly chart zoom state: bar width in pixels per month (column-based zoom).
// All months are ALWAYS rendered; zoom shrinks or stretches each column's width.
let monthlyBarWidth = 18;           // starting bar width (px per month)
const MIN_BAR_WIDTH = 4;            // fully zoomed out: thin columns, everything visible
const MAX_BAR_WIDTH = 140;          // fully zoomed in: wide columns, scrollbars engage

// Keep the last dataset so wheel-zoom can re-render without a full recalculation.
let lastMonthlyDataset = null;

// mouse wheel zoom
function setupMonthlyChartWheel(scrollContainer) {
    if (!scrollContainer || scrollContainer._monthlyWheelBound) return;
    scrollContainer._monthlyWheelBound = true;

    scrollContainer.addEventListener('wheel', (e) => {
        if (!lastMonthlyDataset) return;
        e.preventDefault();

        const months = lastMonthlyDataset.sortedMonths;
        const total = months.length;
        if (total < 2) return;

        const zoomIn = e.deltaY < 0;
        const factor = zoomIn ? 1.25 : 0.8;              // ~25% per wheel step
        let newWidth = monthlyBarWidth * (zoomIn ? factor : factor);
        newWidth = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, newWidth));
        if (newWidth === monthlyBarWidth) return;

        // Anchor: month index under the cursor, in dataset coordinates
        const rect = scrollContainer.getBoundingClientRect();
        const scrollX = e.clientX - rect.left + scrollContainer.scrollLeft;
        const contentW = scrollContainer.scrollWidth || rect.width;
        const frac = Math.max(0, Math.min(1, scrollX / contentW));
        const anchor = frac * total;                     // month index (float)

        monthlyBarWidth = newWidth;

        // Re-render with the new column width, then put the anchor back under the cursor
        renderMonthlyChart(lastMonthlyDataset.data, true);
        const newContentW = scrollContainer.scrollWidth;
        const newFrac = (anchor / total);
        scrollContainer.scrollLeft = newFrac * newContentW - (e.clientX - rect.left);
    }, { passive: false });
}

function renderMonthlyChart(monthlyData) {
    const canvas = document.getElementById('monthlyChart');
    if (!canvas) { console.warn('monthlyChart canvas not found'); return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { console.warn('monthlyChart getContext failed'); return; }
    
    const scrollContainer = document.getElementById('monthly-chart-scroll');
    const container = document.getElementById('monthly-chart-container');
    if (!container) { console.warn('monthly-chart-container not found'); return; }
    
    const sortedMonths = Object.keys(monthlyData).sort();
    const totalMonthCount = sortedMonths.length;
    const visibleMonths = sortedMonths;
    const monthCount = visibleMonths.length;
    const containerHeight = 280;
    
    // Bar width
    const FIT_BARS = 59;
    const baseWidth = scrollContainer ? scrollContainer.clientWidth : 600;
    const contentWidth = Math.max(baseWidth, monthCount * 18);

    let barWidth;
    if (monthCount <= FIT_BARS) {
        barWidth = Math.max(18, Math.floor(baseWidth / monthCount) - 2);
    } else {
        barWidth = 18;
    }

    // Subtitle: always list total; show zoom hint
    const subtitle = document.getElementById('monthly-chart-subtitle');
    if (subtitle) {
        subtitle.textContent = `${totalMonthCount} months`;
    }

    // Labels and values for the VISIBLE window only
    const labels = visibleMonths.map(m => {
        const [y, monthNum] = m.split('-');
        const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return `${monthNames[parseInt(monthNum) - 1]} '${y.slice(2)}`;
    });

    const values = visibleMonths.map(m => parseFloat((monthlyData[m] / 3600).toFixed(1)));
    const maxVal = values.length ? Math.max(...values) : 1;
    
    // Color function: category colors based on hour (no gradient flat color)
    // User preference: 100+ hours = red, 80+ = orange, 60+ = pale yellow, below = gray
    const getCategoryColor = (val) => {
        if (val >= 100) return '#dc2626';   // red
        if (val >= 80)  return '#ea580c';   // orange
        if (val >= 60)  return '#eab308';   // pale yellow
        return '#64748b';                    // gray
    };
    
    if (monthlyChartInstance) { monthlyChartInstance.destroy(); monthlyChartInstance = null; }
    if (sortedMonths.length === 0) return;
    
    // Canvas container boyutunu ayarla
    container.style.width = contentWidth + 'px';
    container.style.height = containerHeight + 'px';
    canvas.width = contentWidth;
    canvas.height = containerHeight;
    canvas.style.width = contentWidth + 'px';
    canvas.style.height = containerHeight + 'px';
    
    monthlyChartInstance = new Chart(ctx, {
        type: 'bar',
        data: { 
            labels, 
            datasets: [{
                label: 'Usage (hours)', 
                data: values,
                backgroundColor: function(context) {
                    const val = context.dataset.data[context.dataIndex];
                    return getCategoryColor(val);
                },
                borderColor: 'rgba(255,255,255,0.08)',
                borderWidth: 0,
                borderRadius: 2,
                borderSkipped: false,
                barPercentage: 0.9,
                categoryPercentage: 0.9
            }]
        },
        options: {
            responsive: false,  // We control canvas size ourselves (for scroll)
            maintainAspectRatio: false, 
            animation: { duration: 600, easing: 'easeOutQuart' },
            interaction: { intersect: false, mode: 'index' },
            // Show tooltip when hovering over axis labels (outside plot area):
            // Find nearest bar by x-coordinate and trigger tooltip manually.
            // (Chart.js native 'index' mode does not work in the axis region.)
            onHover: (event, activeElements, chart) => {
                const canvasRect = chart.canvas.getBoundingClientRect();
                const x = event.x;  // x relative to canvas
                const y = event.y;
                // Also works in the tick area below the plot area
                if (y > chart.chartArea.bottom) {
                    // Find the nearest index on the X axis
                    const points = chart.getElementsAtEventForMode(event, 'index', { intersect: false }, true);
                    if (points.length > 0) {
                        const idx = points[0].index;
                        const meta = chart.getDatasetMeta(0);
                        const bar = meta.data[idx];
                        if (bar) {
                            chart.setActiveElements([{ datasetIndex: 0, index: idx }]);
                            chart.tooltip.setActiveElements([{ datasetIndex: 0, index: idx }], {
                                x: bar.x, y: Math.min(y, chart.chartArea.top + 10)
                            });
                            chart.update('none');
                            return;
                        }
                    }
                } else if (activeElements.length === 0) {
                    // Plot area outside but hover moved to an element - clear
                    chart.setActiveElements([]);
                    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
                    chart.update('none');
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10, 14, 23, 0.95)',
                    titleColor: '#f1f5f9',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(148, 163, 184, 0.2)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    padding: 12,
                    titleFont: { size: 13, weight: 'bold' },
                    bodyFont: { size: 14 },
                    callbacks: {
                        title: (items) => items[0]?.label || '',
                        label: (c) => ` ${c.parsed.y.toLocaleString('en-US', {maximumFractionDigits: 1})} hours`,
                        labelColor: (c) => {
                            const val = c.parsed.y;
                            let color = '#64748b';
                            if (val >= 100) color = '#dc2626';
                            else if (val >= 80) color = '#ea580c';
                            else if (val >= 60) color = '#eab308';
                            return { borderColor: color, backgroundColor: color, borderWidth: 2, borderRadius: 2 };
                        }
                    }
                }
            },
            scales: {
                x: {
                    grayd: { display: false },
                    ticks: {
                        color: '#cbd5e1', 
                        font: { size: 11, weight: '500' },
                        maxRotation: 45,
                        minRotation: 45,
                        autoSkip: false,  // Show all months
                        padding: 6
                    },
                    border: { color: '#475569', width: 1 }
                },
                y: { 
                    grid: { color: (ctx) => ctx.tick ? 'rgba(148, 163, 184, 0.5)' : 'transparent', borderDash: [3, 3], drawBorder: false }, 
                    ticks: { 
                        color: '#94a3b8', 
                        font: { size: 11 },
                        callback: (val) => val.toLocaleString('en-US')
                    },
                    border: { display: false }
                }
            }
        }
    });

    // Bind the TradingView-style wheel zoom (no-op if already bound)
    setupMonthlyChartWheel(scrollContainer);
}

function renderHourlyChart(selectedRange) {
    const ranges = window._hourlyByRange || {};
    const rangeKey = selectedRange || currentHourlyRange || 'all';
    const hourlyData = ranges[rangeKey] || ranges['all'] || new Array(24).fill(0);
    
    const canvas = document.getElementById('hourlyChart');
    if (!canvas) { console.warn('hourlyChart canvas not found'); return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { console.warn('hourlyChart getContext failed'); return; }
    const parent = canvas.parentElement;
    if (parent) { canvas.width = parent.clientWidth || 300; canvas.height = parent.clientHeight || 288; }
    const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    if (hourlyChartInstance) { hourlyChartInstance.destroy(); hourlyChartInstance = null; }

    const rangeLabels = { '7d': 'Last 7 Days', '30d': 'Last 30 Days', '90d': 'Last 90 Days', '365d': 'Last Year', 'all': 'All Time' };
    const label = rangeLabels[rangeKey] || rangeKey;

    hourlyChartInstance = new Chart(ctx, {
        type: 'line',
        data: { 
            labels, 
            datasets: [{
                label, data: hourlyData.map(v => v / 3600),
                borderColor: '#02be89', backgroundColor: 'rgba(45, 220, 109, 0.07)',
                borderWidth: 2.5, fill: true, tension: 0.35, 
                pointRadius: 6, pointHoverRadius: 10, pointBackgroundColor: '#00ff33',
                pointBorderColor: '#22ff77', pointBorderWidth: 2.5
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            hover: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10, 14, 23, 0.95)', 
                    titleColor: '#f1f5f9', 
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(34, 211, 238, 0.3)', 
                    borderWidth: 1, 
                    cornerRadius: 8,
                    padding: 12,
                    titleFont: { size: 14, weight: 'bold' },
                    bodyFont: { size: 13 },
                    callbacks: { 
                        title: (items) => `Hour ${items[0]?.label || ''}`,
                        label: (c) => ` ${c.parsed.y.toFixed(1)} hours used`
                    }
                }
            },
            scales: {
                x: { 
                    grayd: { color: '#1e293b', drawBorder: false }, 
                    ticks: { color: '#94a3b8', font: { size: 11 }, maxRotation: 0 },
                    border: { color: '#334155', width: 1 }
                },
                y: { 
                    grid: { color: (ctx) => ctx.tick ? 'rgba(148, 163, 184, 0.5)' : 'transparent', borderDash: [3, 3], drawBorder: false }, 
                    ticks: { 
                        color: '#94a3b8', 
                        font: { size: 11 },
                        callback: (val) => val.toFixed(1) + 's'
                    },
                    border: { display: false }
                }
            }
        }
    });
}

// ========== Markdown Table Symmetry Formatter ==========

function _cellWidth(s) {
    // count ONLY the characters that actually render
    const plain = s.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
    return [...plain].length;
}
function formatMarkdownTables(md) {
    const lines = md.split('\n');
    const out = [];
    let i = 0;
    const isTableLine = (l) => {
        const t = l.replace(/\s+$/,'').replace(/^\s+/,'');
        return t.length >= 2 && t[0] === '|' && t[t.length-1] === '|';
    };
    while (i < lines.length) {
        if (isTableLine(lines[i])) {
            const start = i;
            while (i < lines.length && isTableLine(lines[i])) i++;
            const block = lines.slice(start, i);
            out.push(..._padTableBlock(block));
        } else {
            out.push(lines[i]);
            i++;
        }
    }
    return out.join('\n');
}
function _padTableBlock(block) {
    // single-row tables (e.g. some fallback rows) -> just return as-is
    if (block.length < 2) return block;
    // a0 row: '|---|---|' -> ['---','---'] (empty edges filtered)
    const parseRow = (l) => {
        const t = l.trim();
        return t.split('|').slice(1, -1).map(s => s.trim());
    };
    const isSep = (l) => {
        const cells = parseRow(l);
        // separator row: every cell is dashes/colons only, at least one dash
        return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c.trim()));
    };
    const rows = block.map(parseRow);
    const colCount = Math.max(...rows.map(r => r.length));
    // width per column = max RAW (js-string) length of the trimmed cell
    const widths = new Array(colCount).fill(3);
    rows.forEach(r => {
        for (let c = 0; c < colCount; c++) {
            const cell = r[c] !== undefined ? r[c] : '';
            widths[c] = Math.max(widths[c], [...cell].length);
        }
    });
    const pad = (cell, w) => {
        return cell + ' '.repeat(Math.max(0, w - [...cell].length));
    };
    return block.map((orig, idx) => {
        if (isSep(orig)) {
            return '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|';
        }
        const r = rows[idx];
        const cells = [];
        for (let c = 0; c < colCount; c++) {
            cells.push(' ' + pad(r[c] !== undefined ? r[c] : '', widths[c]) + ' ');
        }
        return '|' + cells.join('|') + '|';
    });
}

// ========== Markdown Report Builder (detailed) ==========
function buildMarkdownReport(d, rawTimestamps, rawTimestampSources, extraMetadata, loginLogoutPairs, activeDayTimestamps) {
    const dateStr = (dt) => dt.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    // NULL SAFETY: most basic checks here so the caller doesn't crash
    if (!d || !d.yearlyStats) d = { yearlyStats: {} };
    if (!d.monthlyData) d = { monthlyData: {} };
    if (!rawTimestamps || rawTimestamps.length === 0) rawTimestamps = [{ date: new Date(), source: 'unknown' }];
    if (!rawTimestampSources) rawTimestampSources = {};
    if (!extraMetadata) extraMetadata = { devices: {}, locations: {}, ips: {}, signupDate: null };
    if (!loginLogoutPairs) loginLogoutPairs = [];
    
    const totalHours = (lastTotalSeconds || 0) / 3600;
    const totalDaysVal = (lastTotalSeconds || 0) / 86400;
    
    // Membership duration
    let membershipDays = 0;
    let signupStr = 'Unknown';
    if (extraMetadata.signupDate) {
        const signup = new Date(extraMetadata.signupDate);
        signupStr = dateStr(signup);
        membershipDays = Math.max(0, Math.floor((new Date() - signup) / 86400000));
    }
    
    // Yearly statistics (all years, day equivalent included)
    const yearlyRows = Object.keys(d.yearlyStats).sort((a,b) => b - a).map(y => {
        const s = d.yearlyStats[y];
        const hours = s.totalSeconds / 3600;
        const days = hours / 24;
        const activeDays = s.activeDays ? s.activeDays.size : 0;
        return `| ${y} | ${s.totalEntries.toLocaleString('en-US')} | ${s.sessionCount.toLocaleString('en-US')} | ${activeDays} | ${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })} | ${days.toLocaleString('en-US', { maximumFractionDigits: 1 })} |`;
    }).join('\n');
    
    // Monthly breakdown (ALL months, chronological)
    const allMonthEntries = Object.entries(d.monthlyData).sort((a,b) => a[0].localeCompare(b[0]));
    const monthlyRows = allMonthEntries.map(([k, v]) => `| ${k} | ${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} |`).join('\n');
    
    const topMonths = [...allMonthEntries].sort((a,b) => b[1] - a[1]).slice(0, 5);
    const bottomMonths = [...allMonthEntries].sort((a,b) => a[1] - b[1]).slice(0, 5);
    
    // Calculation details
    const idleSec = 600;
    const loginLogoutCount = loginLogoutPairs.filter(p => p.logout).length;
    
    // Hourly distribution (All time)
    const hourlyAll = new Array(24).fill(0);
    const IDLE_MS = idleSec * 1000;
    if (rawTimestamps.length > 1) {
        for (let i = 0; i < rawTimestamps.length - 1; i++) {
            const t1 = rawTimestamps[i].date.getTime();
            const t2 = rawTimestamps[i+1].date.getTime();
            if (t2 - t1 > IDLE_MS) continue;
            let cursor = t1;
            while (cursor < t2) {
                const dt = new Date(cursor);
                const hour = dt.getHours();
                const hourEnd = new Date(dt);
                hourEnd.setMinutes(0,0,0);
                hourEnd.setHours(hour + 1);
                const chunkEnd = Math.min(t2, hourEnd.getTime());
                hourlyAll[hour] += (chunkEnd - cursor) / 3600000;
                cursor = chunkEnd;
                if (chunkEnd === t2) break;
            }
        }
    }
    const maxHourVal = Math.max(...hourlyAll, 0.001);
    const hourlyRows = hourlyAll.map((v, i) => {
        const bars = Math.round((v / maxHourVal) * 20);
        // Use only full-block chars + spaces: '█' and '░' render at different
        // widths in many fonts, making the bar ends look crooked.
        const bar = ('█'.repeat(bars)).padEnd(20);
        return `| ${String(i).padStart(2,'0')}:00 | ${v > 0 ? v.toFixed(1) : '0'} | ${bar} |`;
    }).join('\n');
    
    // Device distribution
    const devices = extraMetadata.devices || {};
    const devTotal = Object.values(devices).reduce((a,b) => a+b, 0);
    const deviceRows = Object.entries(devices).sort((a,b) => b[1]-a[1]).map(([name, count]) => {
        const pct = devTotal > 0 ? ((count / devTotal) * 100).toFixed(1) : '0.0';
        return `| ${name} | ${count.toLocaleString('en-US')} | %${pct} |`;
    }).join('\n') || '| Veri yok | 0 | %0 |';
    
    // Location distribution (IP->City)
    let locationRowsStr = '| City | Sessions | Hours | % |';
    locationRowsStr += '\n|---|---|---|---|';
    try {
        const geoCache = loadGeoCache();
        const cityRows = buildCityRows(geoCache);
        if (cityRows.length > 0) {
            const topCities = cityRows.slice(0, 10);
            const cityTotal = topCities.reduce((s,r) => s + r.count, 0);
            const cHours = totalHours;
            locationRowsStr = topCities.map(r => {
                const pct = cityTotal > 0 ? ((r.count / cityTotal) * 100).toFixed(1) : '0.0';
                const h = cityTotal > 0 ? (r.count / cityTotal) * cHours : 0;
                return `| ${r.flag || ''} ${r.label} | ${r.count.toLocaleString('en-US')} | ${h.toLocaleString('en-US',{maximumFractionDigits:1})} | %${pct} |`;
            }).join('\n');
        } else {
            const ipRows = buildIpFallbackRows().slice(0,10);
            const ipTotal = ipRows.reduce((s,r) => s + r.count, 0);
            locationRowsStr = ipRows.map(r => `| ${r.label} | ${r.count.toLocaleString('en-US')} | ${(ipTotal > 0 ? (r.count/ipTotal)*totalHours : 0).toLocaleString('en-US',{maximumFractionDigits:1})} | %${(ipTotal>0? (r.count/ipTotal)*100 : 0).toFixed(1)} |`).join('\n');
        }
    } catch(e) { locationRowsStr += '\n| Location data could not be processed | - | - | - |'; }
    
    // Source distribution
    const totalEvents = Object.values(rawTimestampSources).reduce((a,b) => a+b, 0);
    const sourceRows = Object.entries(rawTimestampSources)
        .filter(([k]) => !k.startsWith('_'))
        .sort((a,b) => b[1] - a[1])
        .map(([k,v]) => `| ${k} | ${v.toLocaleString('en-US')} | %${(totalEvents>0?((v/totalEvents)*100):0).toFixed(1)} |`)
        .join('\n');

    const summaryRows = [
        ['Estimated Total Usage', `**${totalHours.toLocaleString('en-US', { maximumFractionDigits: 1 })} hours**`],
        ['Day Equivalent', `**${totalDaysVal.toLocaleString('en-US', { maximumFractionDigits: 1 })} days**`],
        ['Number of Sessions', `**${d.sessionCount.toLocaleString('en-US')}**`],
        ['Total Events Processed', `**${rawTimestamps.length.toLocaleString('en-US')}**`],
        ['Active Days', `**${d.activeDaysCount} days** (${d.activeDayPercentage}%)`],
        ['Daily Average', `**${d.dailyAvgMinutes} min**`],
        ['Date Range', `${dateStr(d.firstDate)} to ${dateStr(d.lastDate)}`],
        ['Total Duration (Calendar)', `${d.totalSpanDays.toLocaleString('en-US')} days`],
        ['Signup Date', signupStr],
        ['Membership Duration', `${membershipDays.toLocaleString('en-US')} days`],
    ];

    return formatMarkdownTables(`# Instagram Usage Duration Analysis

## Summary

| Metric | Value |
|---|---|
${summaryRows.map(r => `| ${r[0]} | ${r[1]} |`).join('\n')}

| Metric | Value |
|---|---|
| Estimated Total Usage | **${totalHours.toLocaleString('en-US', { maximumFractionDigits: 1 })} hours** |
| Day Equivalent | **${totalDaysVal.toLocaleString('en-US', { maximumFractionDigits: 1 })} days** |
| Number of Sessions | **${d.sessionCount.toLocaleString('en-US')}** |
| Total Events Processed | **${rawTimestamps.length.toLocaleString('en-US')}** |
| Active Days | **${d.activeDaysCount} days** (${d.activeDayPercentage}%) |
| Daily Average | **${d.dailyAvgMinutes} min** |
| Date Range | ${dateStr(d.firstDate)} to ${dateStr(d.lastDate)} |
| Total Duration (Calendar) | ${d.totalSpanDays.toLocaleString('en-US')} days |
| Signup Date | ${signupStr} |
| Membership Duration | ${membershipDays.toLocaleString('en-US')} days |

## Calculation Algorithm

| Step | Detail |
|---|---|
| Gap Threshold | Consecutive events **${idleSec/60} minutes** apart |
| Session Definition | If the gap between events exceeds 10 minutes, a new session starts |
| Login↔Logout Pairs | ${loginLogoutCount} real login->logout pairs detected |
| Measurement Model | Total time = Sum of all session durations |
| Message Filter | Received messages are NOT counted; ONLY messages YOU sent are processed |

## Yearly Detailed Breakdown

| Year | Total Events | Sessions | Active Days | Estimated Usage (Hours) | Day Equivalent |
|---|---|---|---|---|---|
${yearlyRows}

## Monthly Estimated Usage

| Month | Estimated Usage (Hours) |
|---|---|
${monthlyRows}

## Top 5 Heaviest Months (Hours)

| # | Month | Hours |
|---|---|---|
${topMonths.map((m,i) => `| ${i+1} | ${m[0]} | ${m[1].toLocaleString('en-US',{maximumFractionDigits:1})} |`).join('\n')}

## Bottom 5 Lightest Months

| # | Month | Hours |
|---|---|---|
${bottomMonths.map((m,i) => `| ${i+1} | ${m[0]} | ${m[1].toLocaleString('en-US',{maximumFractionDigits:1})} |`).join('\n')}

## Hourly Usage Distribution (All Time)

| Hour | Average Session Duration (hours) | Chart |
|---|---|---|
${hourlyRows}

## Source Distribution (Time-Counting Events)

| Source | Event Count | Share |
|---|---|---|
${sourceRows}
| Stories viewed (active day) | ${activeDayTimestamps.length.toLocaleString('en-US')} | - |

## Device Distribution

| Device | Event Count | Percentage |
|---|---|---|
${deviceRows}

## Location Distribution

${locationRowsStr}

## Additional Metadata

- **Device Count:** ${Object.keys(devices).length} unique devices
- **Location Count:** ${Object.keys(extraMetadata.locations).length} distinct locations
- **IP Count:** ${Object.keys(extraMetadata.ips).length} unique IPs
- **Signup Date:** ${signupStr}

---
*Generated:* ${new Date().toLocaleString('en-US')}*
`);
}
function setupHourlyRangeButtons() {
    const buttons = document.querySelectorAll('.hourly-range-btn');
    const chart = document.getElementById('hourlyChart');
    if (!buttons.length || !chart) return;

    buttons.forEach(btn => {
        // Do not re-bind
        if (btn._hourlyBound) return;
        btn._hourlyBound = true;

        btn.addEventListener('click', () => {
            // Aktif state
            buttons.forEach(b => {
                b.classList.remove('active');
                b.style.background = 'rgba(30, 41, 59, 0.6)'; // slate-800/60
                b.style.borderColor = 'rgba(51, 65, 85, 0.5)'; // slate-700/50
                b.style.color = '#94a3b8'; // slate-400
            });
            btn.classList.add('active');
            btn.style.background = 'rgba(34, 211, 238, 0.2)';   // aqua transparent
            btn.style.borderColor = 'rgba(34, 211, 238, 0.35)';
            btn.style.color = '#67e8f9';                        // cyan-300

            currentHourlyRange = btn.dataset.range;
            
            // Subtitle update
            const subtitle = document.getElementById('hourly-chart-subtitle');
            if (subtitle) {
                const labels = {
                    '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days',
                    '365d': 'Last year', 'all': 'All time'
                };
                subtitle.textContent = `${labels[currentHourlyRange]} > hourly distribution`;
            }
            
            try { renderHourlyChart(currentHourlyRange); } catch(e) { console.warn('hourly render error:', e); }
        });
    });
}

// ========== Extra Metadata Render ==========
function renderExtraMetadata() {
    const membershipCard = document.getElementById('kpi-membership-card');
    if (extraMetadata.signupDate) {
        membershipCard.classList.remove('hidden');
        const now = new Date();
        const daysSince = Math.floor((now - extraMetadata.signupDate) / (1000 * 60 * 60 * 24));
        document.getElementById('kpi-membership-days').textContent = daysSince.toLocaleString('en-US');
        document.getElementById('kpi-signup-date').textContent = extraMetadata.signupDate.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } else {
        membershipCard.classList.add('hidden');
    }

    const dlSection = document.getElementById('device-location-section');
    const devices = extraMetadata.devices;
    const ips = extraMetadata.ips || {};
    if (Object.keys(devices).length > 0 || Object.keys(ips).length > 0) {
        dlSection.classList.remove('hidden');
        if (Object.keys(devices).length > 0) renderDeviceChart(devices);
        if (Object.keys(ips).length > 0)     renderLocationSection();
    } else {
        dlSection.classList.add('hidden');
    }
}

function renderDeviceChart(devices) {
    const canvas = document.getElementById('deviceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const parent = canvas.parentElement;
    if (parent) { canvas.width = parent.clientWidth || 400; canvas.height = parent.clientHeight || 240; }
    if (deviceChartInstance) deviceChartInstance.destroy();

    const categories = {};
    for (const [d, count] of Object.entries(devices)) {
        const cat = categorizeDevice(d);
        categories[cat] = (categories[cat] || 0) + count;
    }
    const labels = Object.keys(categories);
    const values = Object.values(categories);
    const totalLogins = values.reduce((a, b) => a + b, 0);
    const colors = ['#2eb41a', '#6366f1', '#f59e0b', '#64748b', '#94a3b8'];

    // Login-ratio divided total hours (user preference: "divide total by login share")
    const totalHours = lastTotalSeconds / 3600;
    function hoursFor(val) {
        if (totalLogins === 0) return 0;
        return (val / totalLogins) * totalHours;
    }
    function fmtHours(h) {
        if (h >= 100) return h.toLocaleString('en-US', { maximumFractionDigits: 0 });
        if (h >= 10)  return h.toLocaleString('en-US', { maximumFractionDigits: 1 });
        return h.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    deviceChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: colors.slice(0, labels.length), borderColor: '#111827', borderWidth: 2 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#f8fafc',
                        font: { family: 'monospace', size: 11 },
                        padding: 16,
                        generateLabels: (chart) => {
                            const ds = chart.data.datasets[0];
                            const total = ds.data.reduce((a, b) => a + b, 0);
                            return chart.data.labels.map((label, i) => {
                                const val = ds.data[i];
                                const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
                                const h = hoursFor(val);
                                return {
                                    text: `${label}: ${fmtHours(h)} hrs / %${pct} (${val.toLocaleString('en-US')} logins)`,
                                    fillStyle: ds.backgroundColor[i],
                                    strokeStyle: ds.backgroundColor[i],
                                    fontColor: '#f8fafc',
                                    index: i
                                };
                            });
                        }
                    }
                },
                tooltip: {
                    backgroundColor: '#121620', titleColor: '#f8fafc', bodyColor: '#f1f5f9',
                    borderColor: '#1e2433', borderWidth: 1, cornerRadius: 6,
                    callbacks: {
                        label: (c) => {
                            const total = c.dataset.data.reduce((a,b)=>a+b,0);
                            const pct = total > 0 ? ((c.parsed / total) * 100).toFixed(1) : '0.0';
                            const h = hoursFor(c.parsed);
                            return `${c.label}: ${fmtHours(h)} hours / %${pct} (${c.parsed} logins)`;
                        }
                    }
                }
            }
        }
    });
}

// ========== Location Distribution (IP - City, ip-api.com) ==========

function loadGeoCache() {
    try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveGeoCache(cache) {
    try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

// ISO country code - flag emoji (no external asset): "TR" - 🇹🇷
function countryCodeToFlag(cc) {
    if (!cc || cc.length !== 2) return '';
    const base = 0x1F1E6;
    const up = cc.toUpperCase();
    return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
}
// No hardcoded city mapping  general capitalization rule
function titleCaseTr(s) {
    const t = String(s || '').trim();
    if (!t) return 'Bilinmiyor';
    return t.charAt(0).toLocaleUpperCase('en-US') + t.slice(1);
}

// ips + geo cache  city based rows
function buildCityRows(cache) {
    const agg = {};
    for (const [ip, count] of Object.entries(extraMetadata.ips || {})) {
        const g = cache[ip];
        if (!g || g.status !== 'success') continue;
        // City selection 
        let raw;
        if (g.countryCode === 'TR') raw = g.regionName || g.city;
        else raw = g.city || g.regionName;
        const city = titleCaseTr(raw);
        const key = city + '|' + (g.countryCode || '');
        if (!agg[key]) agg[key] = { city, cc: g.countryCode || '', count: 0 };
        agg[key].count += count;
    }
    return Object.values(agg).sort((a, b) => b.count - a.count)
        .map(a => ({ label: a.city, flag: countryCodeToFlag(a.cc), count: a.count }));
}

// Geo unavailable/failed fallback: IPv6 /64 grouped raw IP table.
function buildIpFallbackRows() {
    const agg = {};
    for (const [ip, count] of Object.entries(extraMetadata.ips || {})) {
        const key = (typeof normalizeIpKey === 'function') ? normalizeIpKey(ip) : ip;
        agg[key] = (agg[key] || 0) + count;
    }
    return Object.entries(agg).sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count }));
}

// Common row renderer
function renderLocationRows(rows, animate) {
    const tbody = document.getElementById('location-table');
    if (!tbody) return;
    const top = rows.slice(0, 10);
    const totalLogins = top.reduce((s, r) => s + r.count, 0);
    const totalHoursLoc = lastTotalSeconds / 3600;
    function fmtH(h) {
        if (h >= 100) return h.toLocaleString('en-US', { maximumFractionDigits: 0 });
        if (h >= 10)  return h.toLocaleString('en-US', { maximumFractionDigits: 1 });
        return h.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    tbody.innerHTML = top.map((r) => {
        const pct = totalLogins > 0 ? ((r.count / totalLogins) * 100).toFixed(1) : '0.0';
        const h = totalLogins > 0 ? (r.count / totalLogins) * totalHoursLoc : 0;
        const flag = r.flag ? `<span class="mr-1.5">${r.flag}</span>` : '';
        return `
        <tr class="loc-row border-b border-slate-800/50 hover:bg-slate-900/40 transition-all duration-300" style="${animate ? 'opacity:0;transform:translateX(-8px)' : ''}">
            <td class="py-2 px-3 text-slate-200 font-medium whitespace-nowrap">${flag}${escapeHTML(r.label)}</td>
            <td class="py-2 px-3 text-slate-300 font-mono whitespace-nowrap">${fmtH(h)} sa / %${pct}</td>
            <td class="py-2 px-3 w-1/3">
                <div class="w-full bg-slate-800 h-1.5 rounded overflow-hidden">
                    <div class="loc-bar h-1.5 rounded bg-teal-600 transition-[width] duration-700 ease-out" style="width:${animate ? '0' : pct}%"></div>
                </div>
            </td>
        </tr>`;
    }).join('');
    if (animate) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const trs = tbody.querySelectorAll('.loc-row');
            trs.forEach((tr, i) => {
                setTimeout(() => {
                    tr.style.opacity = '1';
                    tr.style.transform = 'translateX(0)';
                    const bar = tr.querySelector('.loc-bar');
                    const pct = totalLogins > 0 ? ((top[i].count / totalLogins) * 100).toFixed(1) : '0';
                    if (bar) bar.style.width = pct + '%';
                }, i * 60);
            });
        }));
    }
}

// ip-api.com batch endpoint: up to 100 IPs per request, keyless, CORS enabled.
async function fetchGeoForIps(onProgress) {
    const cache = loadGeoCache();
    const allIps = Object.keys(extraMetadata.ips || {});
    const missing = allIps.filter(ip => !cache[ip]);
    const CHUNK = 100;
    const batches = [];
    for (let i = 0; i < missing.length; i += CHUNK) batches.push(missing.slice(i, i + CHUNK));
    let done = 0;
    for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        onProgress({ done, total: missing.length, batch: bi + 1, batches: batches.length });
        const res = await fetch('http://ip-api.com/batch?fields=status,message,country,countryCode,regionName,city,query&lang=tr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const results = await res.json();
        for (const r of results) { if (r && r.query) cache[r.query] = r; }
        saveGeoCache(cache);
        done += batch.length;
        onProgress({ done, total: missing.length, batch: bi + 1, batches: batches.length });
        if (bi < batches.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
    return cache;
}

function renderLocationSection() {
    const statusEl = document.getElementById('geo-status');
    const btn = document.getElementById('geo-resolve-btn');
    const badge = document.getElementById('geo-cache-badge');
    const ips = extraMetadata.ips || {};
    const ipCount = Object.keys(ips).length;
    if (ipCount === 0) return;

    const cache = loadGeoCache();
    const resolved = Object.keys(ips).filter(ip => cache[ip] && cache[ip].status === 'success').length;

    // All IPs are cached - directly show city table, no request.
    if (resolved === ipCount) {
        if (badge) badge.classList.remove('hidden');
        if (btn) btn.classList.add('hidden');
        if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-city mr-1" style="color:#ffffff"></i> ${ipCount} login IPs resolved to cities`;
        renderLocationRows(buildCityRows(cache), true);
        return;
    }

    // Unresolved IPs exist - button + privacy note; show raw IP fallback table for now.
    if (badge) badge.classList.add('hidden');
    if (btn) btn.classList.remove('hidden');
    if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-circle-info text-slate-500 mr-1"></i> ${ipCount} unique IP found. Click the button to resolve to cities   IPs are sent to <span class="text-slate-300">ip-api.com</span>, result is cached in your browser.`;
    renderLocationRows(buildIpFallbackRows(), false);

    if (btn && !btn._bound) {
        btn._bound = true;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.classList.add('opacity-60', 'cursor-wait');
            try {
                const finalCache = await fetchGeoForIps((p) => {
                    if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1" style="color:#ffffff"></i> Cities are being resolved... ${p.done}/${p.total} IP <span class="text-slate-500">(batch ${p.batch}/${p.batches})</span>`;
                });
                const rows = buildCityRows(finalCache);
                if (rows.length === 0) throw new Error('no city could be resolved');
                if (badge) badge.classList.remove('hidden');
                btn.classList.add('hidden');
                if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-city mr-1" style="color:#ffffff"></i> ${ipCount} IP - ${rows.length} city resolved`;
                renderLocationRows(rows, true);
            } catch (err) {
                if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1"></i> City resolution failed (${escapeHTML(err.message)}). Showing network/IP table.`;
                renderLocationRows(buildIpFallbackRows(), false);
            } finally {
                btn.disabled = false;
                btn.classList.remove('opacity-60', 'cursor-wait');
            }
        });
    }
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ========== Sample Data ==========
// Fetched on-demand from sample-data.json. sample-data.js is no longer used

async function loadSampleData() {
    // Reset state - same cleanup as handleZipFile
    extraMetadata = { devices: {}, locations: {}, ips: {}, signupDate: null };
    rawTimestamps = [];
    activeDayTimestamps = [];
    rawTimestampSources = {};
    loginLogoutPairs = [];
    activityRecords = [];
    ownerName = null;
    knownUserGuess = null;

    let rows = null;
    try {
        showFileStatus('Sample data loading (10 MB)...');
        const resp = await fetch('sample-data.json');
        if (!resp.ok) throw new Error('sample-data.json not found');
        rows = await resp.json();
    } catch (_) {
        // fetch may be blocked on file:// - load as <script> instead (once, on demand)
        rows = await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'sample-data.js';
            s.onload = () => {
                if (window.SAMPLE_DATA && window.SAMPLE_DATA.length > 0) resolve(window.SAMPLE_DATA);
                else reject(new Error('sample-data.js loaded but SAMPLE_DATA is empty'));
            };
            s.onerror = () => reject(new Error('sample-data.js could not be loaded'));
            document.head.appendChild(s);
        });
    }

    try {
        if (!Array.isArray(rows)) throw new Error('invalid format');
        rows.sort((a, b) => a.t - b.t);

        const generatedEvents = [];
        for (const r of rows) {
            const d = new Date(r.t);
            if (isNaN(d.getTime())) continue;
            generatedEvents.push({ date: d, source: r.s || 'login' });
        }
        if (generatedEvents.length === 0) throw new Error('empty data');

        rawTimestamps = generatedEvents;
        activityRecords = generatedEvents.map(t => t.date.getTime());

        rawTimestampSources = {};
        for (const e of generatedEvents) {
            rawTimestampSources[e.source] = (rawTimestampSources[e.source] || 0) + 1;
        }

        // Login/logout pairs: some sessions get a real pair
        loginLogoutPairs = [];
        let currentSession = null;
        for (let i = 0; i < generatedEvents.length; i++) {
            const evt = generatedEvents[i];
            const gapSec = currentSession
                ? (evt.date.getTime() - currentSession.lastEvent.getTime()) / 1000
                : null;
            if (gapSec === null || gapSec > 600) {
                if (currentSession && currentSession.events.length > 0) {
                    if (Math.random() < 0.2) {
                        const sMs = currentSession.startMs;
                        const eMs = currentSession.lastEvent.getTime();
                        loginLogoutPairs.push({
                            login: new Date(sMs),
                            logout: new Date(sMs + (eMs - sMs) * 0.9 + Math.random() * 300000)
                        });
                    }
                }
                currentSession = { startMs: evt.date.getTime(), lastEvent: evt.date, events: [evt] };
            } else {
                currentSession.events.push(evt);
                currentSession.lastEvent = evt.date;
            }
        }
        if (currentSession && Math.random() < 0.2) {
            const sMs = currentSession.startMs;
            const eMs = currentSession.lastEvent.getTime();
            loginLogoutPairs.push({
                login: new Date(sMs),
                logout: new Date(sMs + (eMs - sMs) * 0.9 + Math.random() * 300000)
            });
        }

        activeDayTimestamps = [];

        extraMetadata = {
            devices: { 'iPhone 13': 850, 'Samsung Galaxy S21': 420, 'Web Chrome': 180, 'iPhone 12': 95, 'Android': 32 },
            locations: { 'Istanbul': 1200, 'Istanbul': 340, 'Ankara': 85, 'Bursa': 50 },
            ips: {
                // Germany (Hetzner Nuremberg)
                '88.198.39.199': 380,
                // Germany (Hetzner Falkenstein)
                '5.9.55.18': 240,
                // France (Scaleway Paris)
                '163.172.45.20': 180,
                // France (OVH Roubaix)
                '51.178.10.20': 320,
                // Netherlands (DigitalOcean Amsterdam)
                '188.166.100.1': 150,
                '5.206.224.10': 85,
                // Luxembourg (root S.A.)
                '94.242.206.2': 210,
                // USA (DigitalOcean NYC)
                '104.131.55.20': 45,
                // Turkey(Superonline Pendik)
                '212.252.108.22': 100
            },
            signupDate: new Date(2015, 5, 15)
        };

        showFileStatus(`Sample data loaded (${rawTimestamps.length.toLocaleString('en-US')} records, 2015-2026)`);
        resultsSection.classList.remove('hidden');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                try {
                    recalculateAndRender();
                } catch (err) {
                    console.error('[DEBUG] recalculateAndRender (sample data) CRASHED:', err);
                }
                resultsSection.scrollIntoView({ behavior: 'smooth' });
            });
        });
    } catch (err) {
        console.error('[sample] load FAILED:', err);
        showFileStatus('Sample data could not be loaded: ' + err.message, true);
    }
}
