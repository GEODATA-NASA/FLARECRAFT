# GeoFlare: running guide and API reference

GeoFlare is made of two services:

| Service | Folder | Port | What it does |
|---|---|---|---|
| **GeoFlare** | `geoflare/` | 8010 | The website (story, GeoFlare Dashboard, GeoFlare Fires, GeoFlare Air) and its API: the harmonized MODIS + VIIRS fire calendar, live fires, air quality near industry, the leaderboard. |
| **GeoData AI** | repository root | 8000 | The severity model (CatBoost, Fire Risk Score), the fire archive map, and the "ask the data" assistant. GeoFlare calls it for every severity score. It also runs on its own as the classic map. |

GeoFlare still opens without GeoData, but the Fires app, the severity scores and the 4-week outlook will say the service is offline.

Contents: [1. Data](#1-the-data-you-need) · [2. Native run (Windows)](#2-native-run-windows) · [3. Native run (macOS and Linux)](#3-native-run-macos-and-linux) · [4. Docker](#4-docker) · [5. API reference](#5-api-reference) · [6. Troubleshooting](#6-troubleshooting)

---

## 1. The data you need

None of the data is in git. Some files are bigger than GitHub allows, and all of it can be rebuilt from NASA's open archives.

| Data | Used by | Where it goes | How to get it |
|---|---|---|---|
| FIRMS fire archive CSVs and NASA POWER weather | GeoData | `raw_data/` | the GeoData pipeline (`python main.py`, see README) |
| Cleaned fires and weather | GeoData (map, model) and the GeoFlare leaderboard | `cleaned_data/` (or `CLEANED_DATA_DIR`) | the GeoData pipeline |
| Trained model | GeoData | `modeling/artifacts/high_frp_classifier.joblib` | in git; retrain with `python -m modeling.train_model` |
| FIRMS yearly country archives, about 9.6 GB | GeoFlare pipeline | `firms_archive/zips/` next to `geoflare/` (or `FIRMS_ARCHIVE_DIR`) | `python -m pipeline.download` |
| Harmonized record, about 320 MB | GeoFlare | `geoflare/data/product/` (or `EMBER_DATA_DIR`) | `python -m pipeline.aggregate` then `python -m pipeline.build` |
| Leaderboard | GeoFlare | `geoflare/data/product/rankings.json` | `python -m pipeline.rankings` (needs `cleaned_data/cleaned_master_fires.csv` and `geoflare/data/ref/countryInfo.txt` from [GeoNames](https://download.geonames.org/export/dump/countryInfo.txt)) |

Live fires (NASA FIRMS), air quality, wind and place search (Open-Meteo) are fetched at run time and need internet access. Live fires are cached in `geoflare/data/live/`.

**Preview data.** If `geoflare/data/product/report.json` does not exist yet, `geoflare\start.cmd` serves a small 2025-only preview from `geoflare/data/product-agg-dev` when that folder exists. Build it from the GeoData cleaned file with `python -m pipeline.dev_local` and then `python -m pipeline.build --source agg-dev --no-loyo`. The preview is for checking that the apps start, not for the 2003–2025 calendar.

> **Same data on every machine.** The apps show whatever is in the local data folders. For example, if one laptop's archive ends on 31 December and another's on 17 January, their maps open on different weeks. For a demo, copy `cleaned_data/` and `geoflare/data/` from one machine to the others.

---

## 2. Native run (Windows)

Requirements: Python 3.12 or newer (developed on 3.14) and Git.

### One-click scripts (recommended)

Four scripts automate everything below. Each creates its virtual environment (`.venv`) if it is missing and runs `pip install -r requirements.txt` on every start, so the packages GeoFlare needs (including `duckdb`) are always present.

| Script (from the repository root) | What it does |
|---|---|
| `start_all_master.cmd` | Everything, for a fresh clone: sets up the root `.venv`, runs `python main.py` (the GeoData pipeline), then calls `run_pipeline_and_servers.cmd` |
| `run_pipeline_and_servers.cmd` | Sets up `geoflare\.venv`, runs `pipeline.download`, `aggregate`, `build` and `rankings` in order, and only if all four succeed calls `geoflare\start.cmd`. If a step fails it stops and does not start the servers |
| `geoflare\start.cmd [dashboard\|fires\|air]` | Sets up `geoflare\.venv`, starts GeoData AI on port 8000 if it isn't running (it needs the root `.venv`), waits up to 90 seconds for it, starts GeoFlare on port 8010, and opens the browser |
| `scripts\start_app.cmd` | GeoData AI only, on port 8000 (the classic map) |

```text
start_all_master.cmd
 ├─ root .venv + requirements.txt
 ├─ python main.py                         GeoData pipeline: weather → transform → load → train
 └─ run_pipeline_and_servers.cmd
     ├─ geoflare\.venv + geoflare\requirements.txt
     ├─ pipeline.download → aggregate → build → rankings        GeoFlare data
     └─ geoflare\start.cmd                 GeoData AI :8000 · GeoFlare :8010 · browser
```

- The first run is slow. The FIRMS archives are about 9.6 GB (the download is resumable), and `main.py` needs the FIRMS CSVs in `raw_data/` and a configured `.env` (see the README).
- Keep the GeoFlare window open while you use the apps; closing it stops the server. GeoData AI runs in its own minimized window.
- `start.cmd` uses `data\product` when `report.json` exists, and otherwise the 2025 preview (see section 1).
- Use `run_pipeline_and_servers.cmd` when GeoData's pipeline has already run, and `geoflare\start.cmd` alone when GeoFlare's data is already built.

### Step by step (manual)

Run these once, from the repository root:

```bat
:: GeoData AI
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt

:: GeoFlare
cd geoflare
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Build GeoFlare's data once. The download is resumable and can take hours on a slow connection:

```bat
cd geoflare
.venv\Scripts\python -m pipeline.download
.venv\Scripts\python -m pipeline.aggregate
.venv\Scripts\python -m pipeline.build
.venv\Scripts\python -m pipeline.rankings
```

`python -m pipeline.run` does aggregate and build unattended, picking up each archive as it finishes downloading.

**Run GeoFlare by itself** (from the `geoflare` folder, after building its data):

```bat
.venv\Scripts\python -m uvicorn api.main:app --host 127.0.0.1 --port 8010
```

The GeoData AI service on port 8000 is only needed for severity scores and the Fires app integrations. To start both services together, use `start.cmd` as described below.

**Start everything.** Double-click `geoflare\start.cmd`. It starts GeoData on port 8000 if it isn't already running, then GeoFlare on port 8010, then opens the browser. To open one app directly:

```bat
geoflare\start.cmd            :: the story, then the apps
geoflare\start.cmd dashboard  :: GeoFlare Dashboard
geoflare\start.cmd fires      :: GeoFlare Fires
geoflare\start.cmd air        :: GeoFlare Air
```

**Or start both services by hand**, each in its own window:

```bat
:: window 1, repository root: GeoData AI on http://127.0.0.1:8000
.venv\Scripts\python -m uvicorn api.main:app --host 127.0.0.1 --port 8000

:: window 2, geoflare folder: GeoFlare on http://127.0.0.1:8010
.venv\Scripts\python -m uvicorn api.main:app --host 127.0.0.1 --port 8010
```

The apps are at http://127.0.0.1:8010/ (the story), `/dashboard`, `/fires` and `/air`. The classic map is at http://127.0.0.1:8000/. Neither server reloads code on its own, so restart it after changing Python files.

---

## 3. Native run (macOS and Linux)

The `.cmd` scripts are Windows-only. These commands do the same work as `start_all_master.cmd` and `geoflare\start.cmd`:

```bash
# once: GeoData AI (needs raw_data/ and .env, see the README)
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py

# once: GeoFlare data (about 9.6 GB download, resumable)
cd geoflare && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pipeline.download && .venv/bin/python -m pipeline.aggregate \
  && .venv/bin/python -m pipeline.build && .venv/bin/python -m pipeline.rankings
cd ..

# every time: two terminals
.venv/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8000                  # repository root
cd geoflare && .venv/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8010   # geoflare folder
```

---

## 4. Docker

Requirements: Docker Desktop (Windows or macOS) or Docker Engine with Compose v2. The data folders above are mounted into the containers, so build the data first, natively or with the one-off commands below.

```bash
cp .env.example .env              # once; set DB_PASSWORD, and ANTHROPIC_API_KEY for the assistant
docker compose build api geoflare
docker compose up -d db api geoflare
```

- GeoFlare: http://localhost:8010 (the `GEOFLARE_PORT` variable changes the port)
- GeoData AI and the classic map: http://localhost:8000 (the `API_PORT` variable changes the port)
- Logs: `docker compose logs -f geoflare api`
- Stop: `docker compose down`

Inside Compose, GeoFlare reaches GeoData at `http://api:8000` (`GEODATA_API`). The volumes are:
- `./geoflare/data`, for the harmonized record, live cache and leaderboard;
- `./cleaned_data`, read-only, for the leaderboard build.

The GeoData API uses PostgreSQL when it's available (`db` service) and otherwise falls back to the CSV files (`DATA_BACKEND=auto`). Set `DATA_BACKEND=csv` to skip the database.

Build GeoFlare's data inside the container instead of natively:

```bash
docker compose run --rm -e FIRMS_ARCHIVE_DIR=/app/data/zips geoflare python -m pipeline.download
docker compose run --rm -e FIRMS_ARCHIVE_DIR=/app/data/zips geoflare python -m pipeline.aggregate
docker compose run --rm geoflare python -m pipeline.build
docker compose run --rm geoflare python -m pipeline.rankings
```

Run GeoFlare's image on its own, without Compose:

```bash
docker build -t geoflare geoflare
docker run --rm -p 8010:8010 -v "$PWD/geoflare/data:/app/data" -e GEODATA_API=http://host.docker.internal:8000 geoflare
```

The classic-map button in GeoFlare Fires and the "Back to GeoFlare Fires" button on the classic map use ports 8010 and 8000 on the same host. Keep those ports, or both buttons need the new ones.

---

## 5. API reference

Both services publish interactive OpenAPI docs: http://127.0.0.1:8010/docs for GeoFlare and http://127.0.0.1:8000/docs for GeoData. All responses are JSON unless noted.

### 5.1 GeoData AI (port 8000)

| Method and path | What it returns |
|---|---|
| `GET /health` | Service status, data backend, model loaded, weather coverage, fire date range |
| `GET /api/v1/fires` | Fire detections. Filters: `start_date`, `end_date`, `source` (modis, viirs_j1, viirs_suomi; repeatable), `bbox=w,s,e,n`, `min_confidence`, `min_frp`, `daynight`, `limit` |
| `GET /api/v1/fires/geojson` | The same detections as GeoJSON. Add `predict=true` to attach each fire's severity chance, Fire Risk Score and risk level |
| `GET /api/v1/fires/stats` | Totals, severe share, counts by satellite and by day for the same filters |
| `GET /api/v1/fires/date-range` | Earliest and latest acquisition dates |
| `GET /api/v1/weather` | NASA POWER weather observations |
| `POST /api/v1/predict` | Score one fire (body below) |
| `POST /api/v1/predict/batch` | Score up to 5,000 fires: `{"observations": [ ... ]}` |
| `GET /api/v1/model` | Model details: features, metrics (chronological test, spatial CV, blank-input scores, before/after comparison), decision threshold, SHAP importance, risk-level cut-offs, training extent |
| `POST /api/v1/refresh` | Rebuild caches after loading new data |
| `GET /api/v1/ask/status`, `POST /api/v1/ask` | The assistant (needs `ANTHROPIC_API_KEY`): `{"question": "...", "history": []}` |

Predict request. Only `latitude`, `longitude` and `acq_date` are required. Anything else can be left out, because the model is trained to handle blanks.

```bash
curl -X POST http://127.0.0.1:8000/api/v1/predict -H "Content-Type: application/json" -d '{
  "latitude": -19.9, "longitude": 123.4, "acq_date": "2025-11-07", "acq_time": 600,
  "brightness": 360, "confidence": 100, "scan": 0.4, "track": 0.4, "type": 0 }'
```

Response, shortened:

```json
{
  "high_frp_probability": 0.9161,
  "is_high_frp": true,
  "predicted_label": "high_frp",
  "risk_score": 85.1,
  "risk_level": "Extreme",
  "decision_threshold": 0.4407,
  "high_frp_threshold_mw": 10.0,
  "in_training_extent": true,
  "weather": { "matched": true, "distance_km": 41.2, "rh2m": 28.1, "prectotcorr": 0.0, "gwettop": 0.12 }
}
```

- `high_frp_probability` is the model's raw score.
- `is_high_frp` is that score compared with the recall-first `decision_threshold`. Override the threshold per request with `?decision_threshold=0.5`, or for the whole service with `DECISION_THRESHOLD`.
- `risk_score` (0–100) is the calibrated chance in percent: a score of 30 means about 30% of such fires turn out severe (10 MW or more).
- `risk_level` is Low, Medium, High or Extreme, from the cut-offs in `GET /api/v1/model` → `risk_levels`.

### 5.2 GeoFlare (port 8010)

| Method and path | What it returns |
|---|---|
| `GET /api/meta` | Record years, VIIRS start year, global VIIRS/MODIS ratio, validation summary |
| `GET /api/countries` | Country names accepted by `country=` |
| `GET /api/calendar?country=Egypt` or `?bbox=w,s,e,n` | The place's calendar: weekly harmonized counts 2003–2025 with uncertainty, climatology, fire season, unusual months, trends, 4-week outlook |
| `GET /api/map?year=2025&week_from=39&week_to=41&country=Egypt` | Harmonized activity and industrial heat per 0.25° cell for a map |
| `GET /api/export.csv?country=…` | Weekly raw MODIS, raw VIIRS, reconstruction and harmonized series (CSV) |
| `GET /api/intro` | Everything the story needs: a year of weekly frames, the global record, industrial sites |
| `GET /api/live?window=24h` (or `7d`) | Live NASA FIRMS fires: counts, map cells, fiercest fire per country, busiest countries |
| `GET /api/live/severity` | Live fires scored by GeoData and graded against measured fire power: ROC-AUC, share caught, calibration, watch list |
| `GET /api/outlook` | Next 4 weeks: usual activity × severity chance, by place and country |
| `GET /api/industry` | Industrial heat sites, country ranking, yearly trend |
| `GET /api/air?lat=30.51&lon=47.81` | GeoFlare Air report: verdict, air quality and 36-hour forecast, wind, sites within 100 km, facts, precautions |
| `GET /api/places?q=Basra` | Place search for the Air check |
| `GET /api/rankings` | Leaderboard: fewest severe fires and least industrial heat per 1,000 km² |
| `/geodata/…` | Same-origin pass-through to GeoData (`health` and `api/v1/*` only), used by GeoFlare Fires |
| `GET /health` | Service status |

Example:

```bash
curl "http://127.0.0.1:8010/api/air?lat=30.51&lon=47.81"
```

The `verdict` holds the level (1 to 6), the US AQI band, how close industry is, and whether the wind is blowing from the brightest nearby site toward you. `facts` are tagged good, bad, warn or info, and `steps` are the precautions shown as animations.

### 5.3 Settings

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `GEODATA_API` | GeoFlare | `http://127.0.0.1:8000` | Where GeoData runs |
| `EMBER_DATA_DIR` | GeoFlare | `geoflare/data` | Data folder (product, live cache, ref) |
| `EMBER_PRODUCT` | GeoFlare | `<data>/product` | Harmonized record to serve |
| `EMBER_PREFETCH` | GeoFlare | `1` | Keep live fires, severity and outlook warm in the background |
| `FIRMS_ARCHIVE_DIR` | GeoFlare pipeline | `firms_archive/zips` next to `geoflare/` | FIRMS yearly archives |
| `CLEANED_DATA_DIR` | both | `cleaned_data/` | Cleaned GeoData CSVs |
| `DATA_BACKEND` | GeoData | `auto` | `postgres`, `csv` or `auto` |
| `DECISION_THRESHOLD` | GeoData | from the model | Overrides the saved recall-first threshold |
| `ANTHROPIC_API_KEY` | GeoData | none | Turns on the assistant |

Training settings are listed in the README section "Validation, early stopping and the decision threshold".

---

## 6. Troubleshooting

- **The browser shows an old version.** GeoFlare versions every script and stylesheet, so this shouldn't happen. If it does, close the tab and press Ctrl+F5.
- **"The GeoData AI service is not running."** Start GeoData on port 8000, or set `GEODATA_API`.
- **The map opens on different dates on different laptops.** Each machine shows its own data folders. Copy them across (see section 1).
- **Port already in use.** Another copy is running. Stop it, or change `API_PORT` or `GEOFLARE_PORT`.
- **`run_pipeline_and_servers.cmd` stops with "GeoFlare pipeline failed".** One of download, aggregate, build or rankings failed, so the servers were not started. Read the message above it and run the script again; the download resumes where it stopped.
- **"No module named 'duckdb'".** GeoFlare's packages are not installed in `geoflare\.venv`. Run `geoflare\start.cmd` (it installs them) or `pip install -r requirements.txt` inside `geoflare\`.
- **"GeoData AI service not found or its .venv is missing".** `start.cmd` starts GeoData with `.venv\Scripts\python.exe` in the GeoData folder. Create the root `.venv` with `start_all_master.cmd`, or by hand (the folder must be called `.venv`).
- **"Full record not built yet - using the 2025 preview data".** `geoflare\data\product\report.json` is missing. Run the GeoFlare pipeline (section 2).
- **The first start is slow.** `pip` checks the requirements on every start, and downloads them the first time.
- **Docker: GeoFlare starts, but the calendar is empty.** `geoflare/data/product` is missing. Build it (section 4) or copy it in.
