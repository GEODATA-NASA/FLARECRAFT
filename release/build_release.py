"""Build the ready-to-run GeoFlare release folder (and its zip) for judges: Windows, no installs, no setup.

    python release/build_release.py [output folder]      # default: ../GeoFlare_v1.0 next to the repository

Needs: the data already built (GeoData cleaned_data with fires_sample.csv and cleaned_weather.csv, and
geoflare/data/product), the two working environments (.venv and geoflare/.venv), the Python 3.14 they were made
from (copied as the bundled runtime), and Windows' own C# compiler for GeoFlare.exe. Nothing is downloaded.

Layout of the result:
    GeoFlare.exe                      Flick icon; runs app/launch.py
    Run GeoFlare (backup).cmd         the same, for computers that block unsigned programs
    HOW TO RUN.txt
    Ask Flick key (optional).txt
    app/ python/  geodata/  geoflare/  data/cleaned/  data/product/  launch.py
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
OUT = Path(ARGS[0]) if ARGS else REPO.parent / "GeoFlare_v1.0"
APP = OUT / "app"
BASE_PYTHON = Path(os.getenv("RELEASE_BASE_PYTHON", r"C:\Python314"))
CLEANED = Path(os.getenv("CLEANED_DATA_DIR", REPO.parent / "cleaned_data"))
PRODUCT = REPO / "geoflare" / "data" / "product"
CSC = Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe")
GEOFLARE_VENV = REPO / "geoflare" / ".venv"   # GeoFlare's environment: fastapi, pandas, duckdb, pyarrow, scipy, scikit-learn
GEODATA_VENV = REPO / ".venv"                   # GeoData's: adds what only the severity API needs
GEODATA_ONLY = ["catboost", "scikit-learn", "sqlalchemy", "anthropic", "python-dotenv"]
# CatBoost lists these for its plotting helpers only; the API never plots, and the self-check proves the rest imports.
LEAVE_OUT = ["matplotlib", "plotly", "graphviz", "pillow", "fonttools", "contourpy", "kiwisolver", "cycler", "pyparsing"]
# Prints {distribution: [files]} for the given distributions and their required dependencies (run in the GeoData venv).
CLOSURE = r"""
import json, re, sys
from importlib import metadata
todo, skip, seen = [n.lower() for n in json.loads(sys.argv[1])], set(json.loads(sys.argv[2])), {}
while todo:
    name = todo.pop()
    if name in seen or name in skip:
        continue
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError:   # a requirement for another platform (its marker excludes Windows)
        continue
    seen[name] = [str(f) for f in (dist.files or [])]
    for req in dist.requires or []:
        if 'extra ==' not in req:
            todo.append(re.split(r'[ ;<>=!~\[(]', req, maxsplit=1)[0].lower().replace('_', '-'))
print(json.dumps(seen))
"""
SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", "logs", "catboost_info")
VC_RUNTIME = ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll", "vcomp140.dll"]


def step(text):
    print(f"== {text}", flush=True)


def copy_python():
    step(f"Python runtime from {BASE_PYTHON}")
    shutil.copytree(BASE_PYTHON, APP / "python", ignore=shutil.ignore_patterns(
        "site-packages", "test", "tests", "idlelib", "tkinter", "turtledemo", "tcl", "Doc", "include", "libs", "Scripts",
        "__pycache__", "*.pyc", "ensurepip"))
    (APP / "python" / "Lib" / "site-packages").mkdir(exist_ok=True)
    for dll in VC_RUNTIME:   # app-local copy of the Visual C++ runtime, for computers that never installed it
        source = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / dll
        if source.is_file():
            shutil.copy2(source, APP / "python" / dll)


def install_packages():
    """Copy the packages from the two environments the servers already run in (no download): GeoFlare's
    environment whole, then the GeoData-only distributions and their dependencies from the GeoData one."""
    step("packages (copied from the working environments)")
    target = APP / "python" / "Lib" / "site-packages"
    shutil.copytree(GEOFLARE_VENV / "Lib" / "site-packages", target, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "pip", "pip-*.dist-info"))
    listing = subprocess.run([str(GEODATA_VENV / "Scripts" / "python.exe"), "-c", CLOSURE, json.dumps(GEODATA_ONLY), json.dumps(LEAVE_OUT)],
                             check=True, capture_output=True, text=True).stdout
    have = {d.name.split("-")[0].lower().replace("_", "-") for d in target.glob("*.dist-info")}
    source = GEODATA_VENV / "Lib" / "site-packages"
    copied = []
    for name, files in json.loads(listing).items():
        if name in have:
            continue
        for rel in files:
            if "__pycache__" in rel or rel.endswith(".pyc") or rel.startswith(".."):
                continue
            (target / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / rel, target / rel)
        copied.append(name)
    print("  from GeoData:", ", ".join(sorted(copied)))


def copy_code():
    step("code")
    geodata = APP / "geodata"
    for name in ("api", "modeling", "utils", "frontend"):
        shutil.copytree(REPO / name, geodata / name, ignore=SKIP)
    shutil.copy2(REPO / "config.py", geodata / "config.py")
    for name in ("api", "pipeline", "web"):
        shutil.copytree(REPO / "geoflare" / name, APP / "geoflare" / name, ignore=SKIP)
    for name in ("launch.py", "launcher.html", "flick.ico"):   # the launcher and Flick's menu window
        shutil.copy2(HERE / name, APP / name)


def copy_data():
    step("data")
    cleaned = APP / "data" / "cleaned"
    cleaned.mkdir(parents=True)
    for name in ("fires_sample.csv", "fires_sample.meta.json", "cleaned_weather.csv"):
        shutil.copy2(CLEANED / name, cleaned / name)
    product = APP / "data" / "product"
    product.mkdir(parents=True)
    for name in ("cellweek.parquet", "cells.parquet", "report.json", "findings.json", "rankings.json"):
        shutil.copy2(PRODUCT / name, product / name)


def front_files():
    step("GeoFlare.exe, the backup starter and the instructions")
    subprocess.run([str(CSC), "/nologo", "/target:exe", "/optimize+", f"/win32icon:{HERE / 'flick.ico'}",
                    f"/out:{OUT / 'GeoFlare.exe'}", str(HERE / "launcher.cs")], check=True)
    # newline="": text mode would turn \r\n into \r\r\n and cmd would misread the lines
    (OUT / "Run GeoFlare (backup).cmd").write_text('@echo off\r\ntitle GeoFlare\r\ncd /d "%~dp0app"\r\n"python\\python.exe" launch.py\r\n',
                                                     encoding="ascii", newline="")
    shutil.copy2(HERE / "HOW TO RUN.txt", OUT / "HOW TO RUN.txt")
    (OUT / "Ask Flick key (optional).txt").write_text(
        "Ask Flick, the chat, needs a free Groq API key from https://console.groq.com\r\n"
        "Paste the key (it starts with gsk_) on the line below, save this file, and start GeoFlare again.\r\n"
        "Keep the key private: do not share this folder with your key inside.\r\n\r\n", encoding="utf-8", newline="")


def check():
    step("self-check: the bundled Python imports everything")
    probe = ("import fastapi, uvicorn, pandas, numpy, scipy, sklearn, catboost, duckdb, pyarrow, joblib, sqlalchemy, anthropic, requests; "
             "print('imports ok', pandas.__version__, catboost.__version__)")
    subprocess.run([str(APP / "python" / "python.exe"), "-c", probe], check=True)
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"release folder: {OUT}  ({size / 1e9:.2f} GB)")


def main():
    if OUT.exists():
        raise SystemExit(f"{OUT} already exists; delete it first (it is rebuilt from scratch).")
    for path in (BASE_PYTHON / "python.exe", CSC, HERE / "flick.ico", CLEANED / "fires_sample.csv", PRODUCT / "cellweek.parquet"):
        if not path.is_file():
            raise SystemExit(f"Missing: {path}")
    copy_python(); install_packages(); copy_code(); copy_data(); front_files(); check()
    if "--zip" in sys.argv:
        step("zip")
        print(shutil.make_archive(str(OUT), "zip", OUT.parent, OUT.name))


if __name__ == "__main__":
    main()
