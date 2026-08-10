#!/usr/bin/env python3
"""
run_app.py

Local development server for the Instagram Usage Time Analyzer.

This script starts a simple HTTP server in the project directory and opens
the user's default browser automatically. It tries ports 8000 through 8003
in order, falling back to the next one if the current port is busy.

Usage:
    python run_app.py

Requirements:
    Python 3.6+ (standard library only, no external packages needed)

Note:
    The application is fully static. You can also open index.html directly
    in a browser without running this server, but some browsers restrict
    local file access for security reasons. This server avoids that issue.
"""

import http.server
import socketserver
import webbrowser
import os
import sys

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Preferred port to start with. If busy, we try the next few ports.
PORT = 8000

# Fallback ports in order of preference.
FALLBACK_PORTS = [PORT, 8001, 8002, 8003]


def run():
    """
    Start the HTTP server and open the browser.

    Changes the working directory to the script's location so that all
    static files are served correctly regardless of where the user
    launched the script from.
    """
    # Ensure we serve files from the directory containing this script,
    # not from wherever the user happened to run the command.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    # Use the simplest possible HTTP handler: serves files, no caching.
    # ThreadingTCPServer would allow concurrent requests, but for local
    # single-user development this is sufficient and keeps things simple.
    Handler = http.server.SimpleHTTPRequestHandler

    # Allow immediate reuse of the port after shutdown, so restarting
    # the server quickly does not fail with "Address already in use".
    socketserver.TCPServer.allow_reuse_address = True

    last_error = None

    for p in FALLBACK_PORTS:
        try:
            with socketserver.TCPServer(("", p), Handler) as httpd:
                url = f"http://localhost:{p}"

                # Print a friendly banner so the user knows it worked.
                print("\n" + "=" * 55)
                print("  Instagram Usage Time Calculator  ")
                print("=" * 55)
                print(f" Web Interface Started: {url}")
                print(" Opening browser automatically...")
                print(" Press [CTRL+C] to stop.")
                print("=" * 55 + "\n")

                # Open the user's default browser at the served URL.
                # If no browser is found, the user can still visit the URL
                # manually, so we do not treat this as fatal.
                webbrowser.open(url)

                try:
                    httpd.serve_forever()
                except KeyboardInterrupt:
                    # Clean shutdown on Ctrl+C. Exit code 0 means success.
                    print("\nServer shut down.")
                    sys.exit(0)

        except OSError as e:
            # Port is already in use or otherwise unavailable. Record it
            # and try the next port in the list.
            last_error = e
            print(f"[!] Port {p} is busy, trying {p + 1}...")

    # If we exhausted all fallback ports, give up with a clear message.
    if last_error:
        print(f"No port available: {last_error}")
        sys.exit(1)


if __name__ == "__main__":
    run()
