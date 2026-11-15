"""GeoFlare release launcher: starts both servers with the bundled Python and data, shows Flick's menu window
(loading animation, then "What do you want to open?"), and stops everything from the menu's Stop button or when
the black window closes. Run by GeoFlare.exe (or "Run GeoFlare (backup).cmd"); nothing is installed."""

import atexit
import ctypes
import json
import os
import platform
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
# Two layouts: the release folder (app/ with its own python/ and data/), or a repository clone, where this file is
# release/launch.py and each server runs in its own .venv with the data the pipelines built (paths from .env).
BUNDLED = (APP / "python").is_dir()
if BUNDLED:
    GEODATA, GEOFLARE, DATA, LOGS = APP / "geodata", APP / "geoflare", APP / "data", APP / "logs"
    PYTHONS = {"geodata": Path(sys.executable), "geoflare": Path(sys.executable)}
else:
    GEODATA, GEOFLARE, DATA, LOGS = ROOT, ROOT / "geoflare", None, ROOT / "logs"
    PYTHONS = {"geodata": ROOT / ".venv" / "Scripts" / "python.exe", "geoflare": ROOT / "geoflare" / ".venv" / "Scripts" / "python.exe"}
MENU_PORT = 8020
MENU = f"http://127.0.0.1:{MENU_PORT}/"
STATE = {"geodata": False, "geoflare": False, "failed": False, "problems": [], "warnings": []}
NEEDS = {"geodata": "fastapi, uvicorn, pandas, numpy, sklearn, catboost, sqlalchemy, dotenv, requests",
         "geoflare": "fastapi, uvicorn, pandas, numpy, scipy, duckdb, pyarrow, requests"}
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


def preflight():
    """Everything GeoFlare needs, checked before anything starts. Returns (problems, warnings) in plain words."""
    problems, warnings = [], []
    here = str(APP).lower()
    if "\\appdata\\local\\temp\\" in here and ".zip" in here:
        problems.append("GeoFlare is running from inside the zip. Right-click GeoFlare_v1.0.zip, choose Extract All, and start GeoFlare.exe from the extracted folder.")
        return problems, warnings
    if not platform.machine().endswith("64"):
        problems.append("This computer runs 32-bit Windows; GeoFlare needs 64-bit Windows 10 or 11.")
    try:
        LOGS.mkdir(exist_ok=True)
        (LOGS / "write-test.txt").write_text("ok", encoding="utf-8")
        (LOGS / "write-test.txt").unlink()
    except OSError:
        problems.append(f"GeoFlare cannot write to {APP}. Copy the GeoFlare folder to the Desktop or Documents (not a read-only drive) and start it there.")
    for name, py in PYTHONS.items():
        if not py.is_file():
            problems.append(f"Python for {name} is missing ({py}). " + ("Download and extract the zip again." if BUNDLED else "Run run_pipeline_and_servers.cmd once to set it up."))
            continue
        probe = subprocess.run([str(py), "-c", f"import {NEEDS[name]}"], capture_output=True, text=True)
        if probe.returncode and not BUNDLED:   # a clone: install what is missing (needs internet once)
            print(f"  Installing missing packages for {name} (one time, needs internet)...", flush=True)
            req = (GEODATA if name == "geodata" else GEOFLARE) / "requirements.txt"
            subprocess.run([str(py), "-m", "pip", "install", "-q", "-r", str(req)])
            probe = subprocess.run([str(py), "-c", f"import {NEEDS[name]}"], capture_output=True, text=True)
        if probe.returncode:
            last = (probe.stderr.strip().splitlines() or ["unknown error"])[-1]
            problems.append(f"A package for {name} does not load ({last}). " + ("Download and extract the zip again; antivirus may have removed a file." if BUNDLED else "Run: pip install -r requirements.txt"))
    needed = ([DATA / "cleaned" / "fires_sample.csv", DATA / "cleaned" / "cleaned_weather.csv", DATA / "product" / "cellweek.parquet"] if BUNDLED
              else [GEOFLARE / "data" / "product" / "cellweek.parquet"]) + [GEODATA / "modeling" / "artifacts" / "high_frp_classifier.joblib"]
    for f in needed:
        if not f.is_file():
            problems.append(f"Data file missing: {f}. " + ("Download and extract the zip again." if BUNDLED else "Run run_pipeline_and_servers.cmd to build the data."))
    for port in (8000, 8010):
        if busy(port):
            problems.append(f"Port {port} is used by another program. Close it (or restart the computer), then start GeoFlare again.")
    try:
        socket.create_connection(("firms.modaps.eosdis.nasa.gov", 443), timeout=3).close()
    except OSError:
        warnings.append("No internet: today's fires, air quality, town search and map backgrounds will not load. The history, the archives, the model and the presentation work offline.")
    return problems, warnings


def last_lines(path, n=6):
    try:
        return [l for l in path.read_text(encoding="utf-8", errors="ignore").splitlines() if l.strip()][-n:]
    except OSError:
        return []


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
    if busy(MENU_PORT):
        print(f"  Port {MENU_PORT} is used by another program. Close it (or restart the computer) and try again.")
        input("\n  Press Enter to close.")
        return
    menu = ThreadingHTTPServer(("127.0.0.1", MENU_PORT), Menu)
    threading.Thread(target=menu.serve_forever, daemon=True).start()
    open_window(MENU)

    print("  Checking this computer...", flush=True)
    problems, warnings = preflight()
    STATE["problems"], STATE["warnings"] = problems, warnings
    for w in warnings:
        print("  [!] " + w)
    if problems:
        STATE["failed"] = True
        print("\n  GeoFlare cannot start yet:")
        for p in problems:
            print("  [x] " + p)
        input("\n  Fix the items above, then start GeoFlare again. Press Enter to close.")
        return
    print("  [ok] Everything GeoFlare needs is here.")
    env = {**os.environ, "GEODATA_API": "http://127.0.0.1:8000", "PYTHONIOENCODING": "utf-8"}
    if BUNDLED:
        key = groq_key()
        env.update({"CLEANED_DATA_DIR": str(DATA / "cleaned"), "DATA_BACKEND": "csv", "CSV_MAX_ROWS": "1000000",
                    "API_LOG_FILE": str(LOGS / "geodata.log"), "ASSISTANT_ENABLED": "1" if key else "0", "GROQ_API_KEY": key,
                    "EMBER_PRODUCT": str(DATA / "product"), "EMBER_DATA_DIR": str(GEOFLARE / "data"), "PYTHONDONTWRITEBYTECODE": "1"})
    else:   # a clone: the repository's .env decides the data folder, the database and the Groq key
        key = "from .env"
        env.setdefault("EMBER_PRODUCT", str(GEOFLARE / "data" / "product"))
    for name, folder, port in (("geodata", GEODATA, 8000), ("geoflare", GEOFLARE, 8010)):
        log = open(LOGS / f"{name}-server.log", "w", encoding="utf-8")
        servers.append(subprocess.Popen([str(PYTHONS[name]), "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", str(port),
                                         "--log-level", "warning"], cwd=folder, env=env, stdout=log, stderr=subprocess.STDOUT))
    atexit.register(stop_servers)
    print("  Starting the servers (about 30 seconds)", end="", flush=True)

    started = time.time()
    while not (STATE["geodata"] and STATE["geoflare"]):
        STATE["geodata"] = STATE["geodata"] or answers("http://127.0.0.1:8000/health")
        STATE["geoflare"] = STATE["geoflare"] or answers("http://127.0.0.1:8010/api/meta")
        if any(p.poll() is not None for p in servers) or time.time() - started > 240:
            STATE["failed"] = True
            for name in ("geodata", "geoflare"):
                if not STATE[name]:
                    tail = last_lines(LOGS / f"{name}-server.log")
                    STATE["problems"].append(f"The {name} server did not start: " + (tail[-1] if tail else "no message") + f" (full log: {LOGS / (name + '-server.log')})")
            print(f"\n\n  GeoFlare could not start:")
            for p in STATE["problems"]:
                print("  [x] " + p)
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
