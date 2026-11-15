"""GeoFlare release launcher: starts both servers with the bundled Python and data, shows Flick's menu window
(loading animation, then "What do you want to open?"), and stops everything from the menu's Stop button or when
the black window closes. Run by GeoFlare.exe (or "Run GeoFlare (backup).cmd"); nothing is installed."""

import atexit
import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP = Path(__file__).resolve().parent            # <release>/app
ROOT = APP.parent
PY = Path(sys.executable)
GEODATA, GEOFLARE, DATA, LOGS = APP / "geodata", APP / "geoflare", APP / "data", APP / "logs"
MENU_PORT = 8020
MENU = f"http://127.0.0.1:{MENU_PORT}/"
STATE = {"geodata": False, "geoflare": False, "failed": False}
servers = []
stopping = threading.Event()


def busy(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def answers(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return r.status == 200
    except OSError:
        return False


def groq_key():
    """Ask Flick needs a free Groq key; the release ships without one (see the key file next to GeoFlare.exe)."""
    path = ROOT / "Ask Flick key (optional).txt"
    if not path.is_file():
        return ""
    lines = [l.strip() for l in path.read_text(encoding="utf-8", errors="ignore").splitlines()]
    return next((l for l in lines if l.startswith("gsk_")), "")


def open_window(url):
    """A desktop-style window: Microsoft Edge in app mode (no tabs or address bar), else the default browser."""
    for base in (os.environ.get("ProgramFiles(x86)", ""), os.environ.get("ProgramFiles", ""), os.environ.get("LOCALAPPDATA", "")):
        edge = Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
        if base and edge.is_file() and not os.environ.get("BROWSER"):
            subprocess.Popen([str(edge), f"--app={url}", "--window-size=1000,760", "--new-window"])
            return
    webbrowser.open(url)


class Menu(BaseHTTPRequestHandler):
    FILES = {"/": (APP / "launcher.html", "text/html; charset=utf-8"), "/flick.ico": (APP / "flick.ico", "image/x-icon"),
             "/web/flick.js": (GEOFLARE / "web" / "flick.js", "text/javascript"), "/web/style.css": (GEOFLARE / "web" / "style.css", "text/css")}

    def do_GET(self):
        if self.path.startswith("/status"):
            return self.send(json.dumps(STATE).encode(), "application/json")
        path, kind = self.FILES.get(self.path.split("?")[0], (None, None))
        if path is None or not path.is_file():
            self.send_error(404)
            return
        self.send(path.read_bytes(), kind)

    def do_POST(self):
        if self.path == "/stop":
            self.send(b"{}", "application/json")
            stopping.set()
        else:
            self.send_error(404)

    def send(self, body, kind):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def stop_servers():
    for p in servers:
        if p.poll() is None:
            p.terminate()


def main():
    ctypes.windll.kernel32.SetConsoleTitleW("GeoFlare - close this window to stop")
    print("\n  GeoFlare v1.0  -  Team FLARECRAFT, NASA Space Apps 2026\n")
    if answers(MENU + "status"):
        print("  GeoFlare is already running. Opening Flick's menu...")
        open_window(MENU)
        time.sleep(2)
        return
    for port in (8000, 8010, MENU_PORT):
        if busy(port):
            print(f"  Port {port} is used by another program. Close it (or restart the computer) and try again.")
            input("\n  Press Enter to close.")
            return

    LOGS.mkdir(exist_ok=True)
    key = groq_key()
    env = {**os.environ,
           "CLEANED_DATA_DIR": str(DATA / "cleaned"), "DATA_BACKEND": "csv", "CSV_MAX_ROWS": "1000000",
           "API_LOG_FILE": str(LOGS / "geodata.log"), "ASSISTANT_ENABLED": "1" if key else "0", "GROQ_API_KEY": key,
           "EMBER_PRODUCT": str(DATA / "product"), "EMBER_DATA_DIR": str(GEOFLARE / "data"),
           "GEODATA_API": "http://127.0.0.1:8000", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    for name, folder, port in (("geodata", GEODATA, 8000), ("geoflare", GEOFLARE, 8010)):
        log = open(LOGS / f"{name}-server.log", "w", encoding="utf-8")
        servers.append(subprocess.Popen([str(PY), "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", str(port),
                                         "--log-level", "warning"], cwd=folder, env=env, stdout=log, stderr=subprocess.STDOUT))
    atexit.register(stop_servers)

    menu = ThreadingHTTPServer(("127.0.0.1", MENU_PORT), Menu)
    threading.Thread(target=menu.serve_forever, daemon=True).start()
    open_window(MENU)
    print("  Flick's menu window is open. Starting the servers (about 30 seconds)", end="", flush=True)

    started = time.time()
    while not (STATE["geodata"] and STATE["geoflare"]):
        STATE["geodata"] = STATE["geodata"] or answers("http://127.0.0.1:8000/health")
        STATE["geoflare"] = STATE["geoflare"] or answers("http://127.0.0.1:8010/api/meta")
        if any(p.poll() is not None for p in servers) or time.time() - started > 240:
            STATE["failed"] = True
            print(f"\n\n  GeoFlare could not start. The details are in {LOGS}.")
            input("\n  Press Enter to close.")
            return
        if stopping.is_set():
            return
        print(".", end="", flush=True)
        time.sleep(1)
    print(" ready!\n")
    print("  GeoFlare ......... http://127.0.0.1:8010/")
    print("  Presentation ..... http://127.0.0.1:8010/present/")
    print("  Severity map ..... http://127.0.0.1:8000/")
    print(f"  Ask Flick: {'on' if key else 'off (add a free Groq key to the key file next to GeoFlare.exe)'}")
    print("\n  To stop: press Stop GeoFlare in Flick's menu, or close this window.\n")
    ctypes.windll.user32.ShowWindow(ctypes.windll.kernel32.GetConsoleWindow(), 6)   # minimise: the menu window is the app
    while all(p.poll() is None for p in servers) and not stopping.is_set():
        time.sleep(0.5)
    stop_servers()
    if not stopping.is_set():
        print(f"  A server stopped. The details are in {LOGS}.")
        input("  Press Enter to close.")


if __name__ == "__main__":
    main()
