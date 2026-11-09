# 🌍 GeoData AI: Forest Fires & Climate Intelligence Pipeline

> **GeoFlare**, the NASA Space Apps 2026 app by Team FLARECRAFT, lives in [`geoflare/`](./geoflare). It has three parts: GeoFlare Dashboard, GeoFlare Fires and GeoFlare Air. This GeoData service supplies its severity model, fire archive and assistant. To run both natively or with Docker, and for every API endpoint, see **[GEOFLARE_GUIDE.md](./GEOFLARE_GUIDE.md)**.

An end-to-end wildfire analytics platform built on open NASA data. It ingests satellite fire detections (NASA FIRMS: MODIS and VIIRS) together with daily weather (NASA POWER), cleans and stores them in PostgreSQL/PostGIS, trains a machine-learning model that estimates how **severe** a detected fire is, and serves everything through a FastAPI service, an interactive Leaflet map, and a natural-language "ask the data" assistant powered by Claude.

```text
 NASA FIRMS + NASA POWER ──▶ ETL pipeline ──▶ PostgreSQL/PostGIS ──▶ CatBoost model
                                                      │                      │
                                                      └──────▶ FastAPI ◀─────┘
                                                                 │
                                                  Leaflet map  ·  Ask-the-data assistant
```

---

## 📑 Table of Contents

- [Features](#-features)
- [Technology Stack](#️-technology-stack)
- [Architecture](#-architecture)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [The Pipeline in Detail](#-the-pipeline-in-detail)
- [GeoAI Model](#-geoai-model)
- [API (FastAPI)](#-api-fastapi)
- [Frontend (Leaflet map)](#️-frontend-leaflet-map)
- [Ask the Data (assistant)](#-ask-the-data-assistant)
- [Docker](#-docker)
- [Scheduling and Airflow](#️-scheduling-and-airflow)
- [Configuration Reference](#️-configuration-reference)
- [Logging](#-logging)
- [Tests](#-tests)
- [CI/CD (GitHub Actions)](#-cicd-github-actions)
- [Verify the Load](#-verify-the-load)
- [Troubleshooting](#-troubleshooting)
- [Known Limitations](#️-known-limitations)
- [Roadmap](#️-roadmap)
- [Business Model (Concept)](#-business-model-concept)
- [License and Data Attribution](#-license-and-data-attribution)
- [Contribution](#-contribution)

---

## ✨ Features

- **One-command pipeline**: `python main.py` runs weather extraction, cleaning, database loading, and model training in order.
- **Global fire coverage**: merges the NASA FIRMS MODIS and VIIRS (NOAA-20 and Suomi NPP) archives into one standardized dataset of tens of millions of detections, processed in chunks.
- **Global weather coverage**: downloads NASA POWER humidity, precipitation, and soil wetness for every place and day that has fires, tile by tile, with a resumable cache.
- **Idempotent stages**: every stage skips work whose output is already current, so repeat runs are cheap and a failed run can simply be restarted.
- **Safe database loading**: uploads go to a staging table that is swapped in inside one transaction, so a crash never leaves a half-loaded table behind.
- **Data-quality validation**: coordinates, brightness, and FRP are checked and duplicates removed; the check runs once and is recorded with a flag file.
- **Severity model**: a CatBoost classifier estimates the probability that a detected fire has a fire radiative power (FRP) of at least 10 MW, evaluated on a chronological hold-out.
- **Model benchmarking**: `modeling/compare_models.py` compares Random Forest, XGBoost, and CatBoost with stratified cross-validation.
- **REST API**: filtered fire queries, GeoJSON for maps, aggregate statistics, single and batch predictions, with PostgreSQL or CSV storage and graceful degradation.
- **Interactive map**: fires coloured by predicted severity, daily statistics, filters, and a click-to-predict tool.
- **Ask the data**: a Claude-powered assistant that answers questions using read-only data tools and a documentation search.
- **Orchestration**: an Airflow DAG with retries, a dependency-free interval scheduler, and a Docker Compose setup.
- **Structured logging** for the pipeline, the API, and the scheduler.
- **CI/CD**: GitHub Actions runs the tests, builds the Docker image, and publishes it to GitHub Container Registry on every push to `main`.
- **Windows one-click launcher** (`scripts/start_app.cmd`) that starts the API and opens the map.

---

## 🛠️ Technology Stack

| Layer | Tools |
|---|---|
| Language | Python 3.10 – 3.12 |
| ETL / Processing | Pandas, NumPy, Requests |
| Database | PostgreSQL, PostGIS, SQLAlchemy, Psycopg2 |
| Machine Learning | CatBoost (production model), XGBoost and scikit-learn (model comparison, BallTree matching), joblib |
| API | FastAPI, Uvicorn, Pydantic |
| Assistant | Anthropic Claude API (`anthropic` SDK), TF-IDF retrieval over project docs |
| Frontend | Leaflet.js, vanilla JavaScript (served by the API) |
| Deployment | Docker, Docker Compose (PostGIS image) |
| Orchestration | Apache Airflow 3 (DAG), `scheduler.py` |
| Testing | pytest, httpx |
| CI/CD | GitHub Actions, GitHub Container Registry (GHCR) |

**Data sources**

- **[NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)** (NASA LANCE): MODIS and VIIRS active fire archives
- **NASA POWER API**: daily relative humidity (`RH2M`), precipitation (`PRECTOTCORR`), and surface soil wetness (`GWETTOP`)

---

## 🧭 Architecture

```text
 ┌──────────────┐   ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────┐
 │   Extract    │ ─▶│    Transform    │ ─▶│       Load       │ ─▶│      Model       │
 │ NASA POWER   │   │ Clean, validate,│   │ PostgreSQL       │   │ CatBoost         │
 │ (grid tiles) │   │ standardize     │   │ fire_events      │   │ high-FRP         │
 │ FIRMS CSVs   │   │ → cleaned_data/ │   │ weather_data     │   │ classifier       │
 │ in raw_data/ │   │                 │   │                  │   │ → .joblib        │
 └──────────────┘   └─────────────────┘   └──────────────────┘   └──────────────────┘
                                                   │                       │
                                                   ▼                       ▼
                                          ┌─────────────────────────────────────┐
                                          │  FastAPI  (api/)                    │
                                          │  repositories · predictor · weather │
                                          │  index · assistant                  │
                                          └──────────────┬──────────────────────┘
                                                         │
                                       ┌─────────────────┴──────────────────┐
                                       │ Leaflet frontend (frontend/)       │
                                       │ REST clients · Ask-the-data        │
                                       └────────────────────────────────────┘
```

The pipeline stages are coordinated by `main.py` (or by the Airflow DAG), and the API reads the same database and the same model artifact the pipeline produces.

---

## 📂 Project Structure

```text
GeoData-AI-Forest-Fires-Climate-Intelligence-Pipeline
├─ main.py                  # Pipeline orchestrator: weather → transform → load → train
├─ config.py                # Loads .env; DB settings, data directories, pipeline logging
├─ scheduler.py             # Dependency-free interval scheduler that reruns main.py
├─ requirements.txt         # Runtime dependencies
├─ requirements-dev.txt     # Adds pytest and httpx
├─ Dockerfile               # One image for the API (default) and the pipeline
├─ docker-compose.yml       # PostGIS + API, plus pipeline / scheduler / airflow profiles
├─ .env.example             # Template for every environment variable
├─ .dockerignore            # Keeps secrets (.env), data, logs, virtual environments, and Git history out of the image
├─ LICENSE                  # MIT
│
├─ .github/
│  └─ workflows/
│     └─ ci.yml             # CI/CD: test → build → publish image to GHCR
├─ scripts/
│  ├─ start_app.cmd         # Windows one-click launcher: starts the API and opens the map
│  └─ geodata.ico           # Icon for a desktop shortcut to the launcher
│
├─ raw_data/                # (not in Git) FIRMS archives and the downloaded NASA POWER weather
│  └─ power_cache/          #   Cached POWER tile responses (created by the extractor)
├─ cleaned_data/            # (not in Git) cleaned CSVs and the validation flag
├─ logs/                    # (not in Git) pipeline.log, api.log, scheduler.log
│
├─ integration/
│  └─ NASA_POWER.py         # Extract: downloads daily weather for the places and dates with fires
├─ transformation/
│  └─ transform.py          # Transform: cleans FIRMS and POWER data into analysis-ready CSVs
├─ utils/
│  └─ quality_checks.py     # validate_fire_data(): coordinate, brightness, FRP, duplicate checks
├─ loadation/
│  └─ load.py               # Load: bulk upload to PostgreSQL through staging tables
├─ modeling/
│  ├─ train_model.py        # Builds the training set, trains and evaluates the CatBoost classifier
│  ├─ compare_models.py     # Benchmarks Random Forest, XGBoost, and CatBoost with cross-validation
│  └─ artifacts/
│     └─ high_frp_classifier.joblib   # Trained pipeline + metadata (committed)
│
├─ api/                     # FastAPI service
│  ├─ main.py               # App factory (uvicorn api.main:app), lifespan, routers, static frontend
│  ├─ settings.py           # API settings from environment variables
│  ├─ deps.py               # Dependencies and the shared fire-filter parser
│  ├─ filters.py            # FireFilters shared by all backends
│  ├─ schemas.py            # Pydantic request/response models
│  ├─ serialization.py      # DataFrame → JSON-safe records
│  ├─ runtime.py            # Shared state: repository, model, refreshable caches
│  ├─ predictor.py          # Loads the model, builds features, serves predictions
│  ├─ weather_index.py      # Same-day nearest-neighbour weather lookup (BallTree)
│  ├─ logging_config.py     # Rotating api.log and per-request logging middleware
│  ├─ version.py            # API version
│  ├─ routers/              # health, fires, weather, predict, assistant endpoints
│  ├─ repositories/         # Data access: postgres.py, csv_backend.py, base.py
│  ├─ assistant/            # service.py (tool loop), tools.py, knowledge.py (docs retrieval)
│  ├─ tools_make_sample.py  # Builds a random sample CSV for the CSV backend
│  └─ tools_create_indexes.py   # Creates the PostgreSQL indexes the API relies on
│
├─ frontend/                # Leaflet map UI: index.html, app.js, style.css
├─ orchestration/
│  ├─ tasks.py              # Pipeline stages as plain task functions
│  ├─ dags/geodata_pipeline.py  # Airflow DAG
│  └─ airflow.Dockerfile    # Airflow image with the project's dependencies
└─ tests/                   # pytest suite (API, assistant, SQL repository, loader, DAG, weather download)
```

---

## 🚀 Getting Started

### Prerequisites

- Python 3.10 – 3.12
- PostgreSQL 14+ with the PostGIS extension (or use the Docker setup, which provides it)
- The NASA FIRMS archive CSV files (see step 3)
- Internet access for the NASA POWER API
- Optional: an Anthropic API key for the assistant

### 1. Clone and install

```bash
git clone https://github.com/GEODATA-NASA/GeoData-AI-Forest-Fires-Climate-Intelligence-Pipeline.git
cd GeoData-AI-Forest-Fires-Climate-Intelligence-Pipeline

python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

pip install -r requirements.txt   # use requirements-dev.txt to also run the tests
```

### 2. Prepare the database

```sql
CREATE DATABASE geodata_db;
\c geodata_db
CREATE EXTENSION IF NOT EXISTS postgis;
```

### 3. Add the FIRMS archives

Download the MODIS and VIIRS archive CSVs from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) and place them in `raw_data/` using these file names (they are defined in `config.py`):

| Satellite source | Expected file |
|---|---|
| `modis` | `raw_data/fire_archive_M-C61_820251.csv` |
| `viirs_j1` (NOAA-20) | `raw_data/fire_archive_J1V-C2_820252.csv` |
| `viirs_suomi` (Suomi NPP) | `raw_data/fire_archive_SV-C2_820253.csv` |

The folder can be moved with `RAW_DATA_DIR` and `CLEANED_DATA_DIR`. Weather is downloaded automatically; you do not provide it.

### 4. Configure environment variables

```bash
cp .env.example .env
```

At minimum set the database credentials:

```env
DB_NAME=geodata_db
DB_USER=postgres
DB_PASSWORD=your_password_here
DB_HOST=localhost
DB_PORT=5432
```

Every other variable is optional and documented in [Configuration Reference](#️-configuration-reference).

### 5. Run the pipeline

```bash
python main.py
```

The first run downloads weather for the whole fire footprint (a few hundred POWER requests, resumable), cleans both datasets, loads the database, and trains the model. Later runs skip whatever is already done.

### 6. Start the API and open the map

```bash
uvicorn api.main:app --reload
```

| URL | What it serves |
|---|---|
| `http://localhost:8000/` | The Leaflet map |
| `http://localhost:8000/docs` | Interactive API reference (Swagger UI) |
| `http://localhost:8000/redoc` | ReDoc API reference |
| `http://localhost:8000/health` | Service, database, and model status |

**Windows shortcut:** double-click `scripts/start_app.cmd`. On the first run it creates a `.venv`, installs `requirements.txt`, then starts the API on `127.0.0.1:8000` and opens the browser once the data has loaded (about 20 seconds). If the app is already running it only opens the browser. Set `GEODATA_PORT` to use another port or `GEODATA_NO_BROWSER=1` to skip opening the browser. Close the window to stop the server. Python 3.10 or newer must be installed.

---

## 🔄 The Pipeline in Detail

`main.py` runs the stages below in order and exits with status 1 (after logging the traceback) if any stage fails. Each stage can also be run on its own.

### Stage 1: Extract weather (`integration/NASA_POWER.py`)

Downloads NASA POWER daily weather (`RH2M`, `PRECTOTCORR`, `GWETTOP`) for the places and dates that have fires. Two modes, selected with `WEATHER_COVERAGE`:

| Mode | Behaviour |
|---|---|
| `grid` (default) | Scans the fire data to find where and when fires occurred, then downloads weather for those places over the full fire date range using the POWER **regional** endpoint. Each request returns a whole 10° × 10° tile on the native 0.5° × 0.625° grid. Points are thinned to `WEATHER_GRID_LAT_STEP` × `WEATHER_GRID_LON_STEP` (default 1.0° × 1.25°), so every fire lies within about 90 km of a weather point, inside the 100 km matching radius used for training and serving. |
| `point` | The original behaviour: one location (`WEATHER_LATITUDE`, `WEATHER_LONGITUDE`) between `WEATHER_START` and `WEATHER_END`. |

Details worth knowing:

- Raw tile responses are cached under `raw_data/power_cache/`, so an interrupted download resumes where it stopped.
- Requests retry with exponential backoff on throttling and server errors, and pause `WEATHER_REQUEST_PAUSE` seconds between calls to be polite to the public API.
- A manifest file next to the weather CSV records what was downloaded. If the file and manifest still match the fire data, the stage is skipped.
- The output keeps one format in both modes: `date, RH2M, PRECTOTCORR, GWETTOP, latitude, longitude`.

### Stage 2: Transform (`transformation/transform.py`)

**Fires** (`transform_fire_data`): reads each configured FIRMS archive in chunks of 100,000 rows and, for every chunk:

- lower-cases and trims the column names, enforces a **canonical column schema** (the same columns in the same fixed order for every source, so MODIS and VIIRS chunks stay aligned when merged), and adds `satellite_source` (`modis`, `viirs_j1`, `viirs_suomi`);
- parses `acq_date` and drops rows without coordinates;
- converts VIIRS confidence labels to numbers (`l` → 25, `n` → 50, `h` → 100) and casts `type` and `acq_time` to integers;
- runs `validate_fire_data` (see below);
- writes the result to a temporary file in `cleaned_data/`.

The temporary file replaces `cleaned_master_fires.csv` in one atomic step (`os.replace`) only after all sources have been processed, so an interrupted run never leaves a half-written master file behind.

**Weather** (`transform_weather_data`): drops rows without a date or coordinates, converts POWER's `-999` fill value to missing, drops rows where every climate value is missing, and writes `cleaned_data/cleaned_weather.csv` through a temporary file and an atomic replace.

**Data-quality checks** (`utils/quality_checks.py`): `validate_fire_data` keeps only rows with valid coordinates (latitude −90..90, longitude −180..180), brightness above zero, FRP of zero or more, and removes fully duplicated rows. The brightness column is recognized under its sensor-specific names (`brightness`, `bright_ti4`, `bright_ti5`). It logs how many rows were dropped and why, and can raise if nothing is left. When an already-cleaned file is found, it is validated once and `cleaned_data/.fire_validated.flag` is written; later runs skip the heavy check unless the cleaned file is newer than the flag.

### Stage 3: Load (`loadation/load.py`)

Uploads the cleaned CSVs to PostgreSQL with pandas and SQLAlchemy:

- **`fire_events`**: one row per satellite detection. Columns: `latitude`, `longitude`, `brightness`, `scan`, `track`, `acq_date`, `acq_time`, `satellite`, `instrument`, `confidence`, `version`, `bright_t31`, `frp`, `daynight`, `type`, `satellite_source`.
- **`weather_data`**: one row per grid point per day. Columns: `date`, `RH2M`, `PRECTOTCORR`, `GWETTOP`, `latitude`, `longitude`.

Each table is first written to a `*_staging` table in chunks, then swapped into place in one transaction (drop old, rename staging, create an index on `acq_date` or `date`). A crashed upload therefore never replaces a good table. For heavier API workloads, run `python -m api.tools_create_indexes` to add the remaining indexes (see [API](#-api-fastapi)).

### Stage 4: Train (`modeling/train_model.py`)

Builds the training set, trains the classifier, evaluates it on a chronological hold-out, and saves the artifact. See [GeoAI Model](#-geoai-model).

### Smart execution (skip logic)

| Stage | Skipped when |
|---|---|
| Weather extraction | The weather CSV exists and its manifest matches the fire footprint, date range, and grid (point mode: the file exists) |
| Fire transformation | `cleaned_master_fires.csv` already exists (it is validated once, then flagged) |
| Weather transformation | `cleaned_weather.csv` exists and the raw weather file has not changed since |
| Fire loading | `fire_events` already contains rows |
| Weather loading | `weather_data` already has the same number of rows as the cleaned file (a different count triggers a reload, so an extended download reaches the database) |
| Training | The model artifact already exists (set `FORCE_RETRAIN=1` to retrain) |

To force a stage to run again, remove its output (file, table, or artifact) and rerun `python main.py`. To rebuild `fire_events` after changing the fire data, drop the table first, because the loader never reloads a populated fires table on its own.

---

## 🤖 GeoAI Model

### What it predicts

The model estimates the probability that an **already detected** fire is severe, defined as `FRP >= HIGH_FRP_THRESHOLD` (10 MW by default). It does **not** predict whether a fire will start: `fire_events` contains detections only, with no labelled "no fire" observations. Each row is one satellite detection, not one fire, since a single large fire produces many detections.

### How it is built

| Aspect | Choice |
|---|---|
| Algorithm | CatBoost classifier (gradient-boosted decision trees); hyperparameters are defined in `modeling/train_model.py` |
| Fire features | `latitude`, `longitude`, `brightness`, `confidence`, `scan`, `track`, `type`, `acq_time`, `day_of_year` |
| Weather features | `rh2m`, `prectotcorr`, `gwettop`, matched per fire |
| Weather matching | Each fire is paired with the nearest NASA POWER point **from the same day** within `MAX_WEATHER_DISTANCE_KM` (default 100 km), using a haversine BallTree per day |
| Sampling | Fires are streamed in chunks and a uniform random sample of up to `MAX_TRAINING_ROWS` rows is kept |
| Validation | Chronological split by date: the first 80% of distinct dates train, the last 20% test, so the model is scored on later data than it learned from. No random splitting, which would leak temporal patterns |
| Output | `modeling/artifacts/high_frp_classifier.joblib` |

The same matching rule is used at serving time by `api/weather_index.py`, which avoids train/serve skew. By default only weather-matched fires are used for training (`REQUIRE_WEATHER_MATCH=1`); set it to `0` to train on every detection, including those without a matched weather record.

### Production model

The production trainer (`modeling/train_model.py`) fits a CatBoost classifier for the binary high-FRP task (FRP ≥ 10 MW by default). Its evaluation on the chronological hold-out (including ROC-AUC, recall, and the Brier score used to check probability calibration), together with the feature list, training extent, and hyperparameters, is stored inside the artifact and returned by `GET /api/v1/model`. Retraining replaces these values.

#### Missing inputs

A caller does not always know every input. A forecast, for example, knows only the place and the date. CatBoost treats a blank as lower than every real value. A model trained only on complete rows never learns what a blank means, so a request with blank brightness, scan and track was scored about 99% "severe".

The trainer therefore appends copies of training rows with groups of inputs blanked (`BLANK_AUGMENT_SHARE`, default 0.5). The groups are: measurements and weather together (place and time only), measurements only, weather only, and one random input. The original rows are kept unchanged, and the hold-out period is never augmented. The artifact records each blank pattern's hold-out AUC under `metrics.blank_inputs`.

| Chronological hold-out (from 2025-10-20) | Trained on complete rows | Trained with blanked copies |
|---|---|---|
| ROC-AUC, every input | 0.894 | 0.893 |
| Brier score | 0.127 | 0.125 |
| ROC-AUC, place and time only | 0.67, but every fire scored 92–100% | 0.71, mean 0.46 |

On 20,000 live VIIRS fires (7–8 Nov 2026), the blank-trained model scored AUC 0.864 with every input, against 0.861 for the complete-rows CatBoost and 0.858 for the earlier random forest. With place and time only, it scored 0.708, against 0.562 for the random forest with median filling.

#### Derived features

`modeling/features.py` adds eight features computed from one detection's own inputs: `dryness` ((100 - humidity) x (1 - soil wetness)), `hot_dry`, `rain_class`, `doy_sin` and `doy_cos` (season on a circle), `abs_latitude`, `pixel_area` and `brightness_per_km2`. The trainer and `api/predictor.py` call the same function, so serving matches training. A blank input gives a blank derived feature, never an error, and the blank-input training copies recompute them. Humidity change versus the previous day and multi-day drought trends are not included: they need a second weather lookup per fire, and the weather index holds one nearest-station tree per day.

#### Validation, early stopping and the decision threshold

- **Early stopping.** Training holds out the last `VALIDATION_SHARE` of the training dates, stops after `CATBOOST_EARLY_STOPPING_ROUNDS` rounds without a validation AUC gain, and keeps the best iteration (`metrics.best_iteration`).
- **Spatial cross-validation.** `metrics.spatial_cv` is 5-fold GroupKFold over 5 x 5 degree blocks, so each fold is scored on places the model never trained on. It is reported as mean and standard deviation of ROC-AUC, Brier score, and recall and precision at the saved threshold. The chronological hold-out (`metrics.roc_auc` and the other existing keys) is unchanged.
- **Recall-first threshold.** A missed severe fire costs more than a false alarm, so the saved `decision_threshold` is the highest one that still reaches `TARGET_RECALL` on the validation slice. `metrics.at_decision_threshold` gives precision and recall on the test period. The API uses the artifact's threshold unless `DECISION_THRESHOLD` is set, and `?decision_threshold=` on a request overrides both.
- **Explainability.** After training, CatBoost's native TreeSHAP runs on 5,000 test rows. The mean absolute SHAP value per feature is logged as a text table, stored as `shap_importance`, and returned by `GET /api/v1/model`. In the current model, brightness, confidence, brightness per km² and scan carry most of the weight; every weather input is under 1%.
- **Tuning.** `TUNE=1` scores depth 4/6/8 × learning rate 0.05/0.1 with spatial GroupKFold and keeps a setting only if it beats the default by `TUNE_MIN_GAIN` (0.005 AUC). In the run behind the current model, the best setting gained 0.0006, so the default (depth 6, learning rate 0.05) was kept.

#### Fire Risk Score (0–100)

Because training uses balanced class weights, the raw probability runs high: on the test period it averaged 0.37 while 0.26 of fires were severe. `modeling/risk.py` fits an isotonic calibration on the validation slice (never the test period). The score is the calibrated chance in percent, so a score of 30 means about 30% of such fires turn out severe. Levels use measured cut-offs: Medium from half the typical severe share, High from the recall-first threshold, and Extreme from a 50% calibrated chance. Every prediction returns `risk_score` and `risk_level`, and `GET /api/v1/model` returns the cut-offs. Older artifacts without a scale return `null` for both.

On the test period, the calibrated score cut the Brier score from 0.126 to 0.107 and matched the observed share (0.260 vs 0.257). The levels separate well:

| Level | Share of test fires | Actually severe |
|---|---|---|
| Low | 53% | 5% |
| Medium | 11% | 19% |
| High | 17% | 35% |
| Extreme | 20% | 77% |

#### Before and after, on identical splits

`COMPARE_WITH=<old artifact>` scores the previous model on exactly the same validation slice and chronological test period (76,073 fires from 2025-10-20). Each model's threshold is picked on the validation slice with the same rule. The previous model trained on the dates that now form the validation slice, so only its test numbers are a fair comparison.

| Test period | Previous (blank-trained CatBoost) | Current |
|---|---|---|
| ROC-AUC | 0.8928 | 0.8928 |
| PR-AUC | 0.7856 | 0.7871 |
| Threshold (from validation) | 0.453 | 0.441 |
| Recall | 0.805 | 0.813 |
| Precision | 0.592 | 0.582 |
| F1 | 0.682 | 0.678 |
| Severe fires missed | 3,806 | 3,658 |
| Spatial CV ROC-AUC (5° blocks) | not measured | 0.895 ± 0.005 |
| Spatial CV recall at threshold | not measured | 0.828 ± 0.010 |

Ranking quality is unchanged. The gains are fewer missed severe fires, calibrated scores, and validation that measures generalisation to unseen places.

Limitations, stated plainly:
- On 20,000 live fires from 7–8 Nov 2026, the current model scored AUC 0.861 with every input (previous: 0.864) and 0.677 with place and date only (previous: 0.708). That is two days of data, but it is the deployment year, so the place-and-date-only case may have lost a little.
- The derived features made no difference in spatial CV (0.8949 with and without). Training without them scored lower on the test period (0.8902), so they stay on (`USE_DERIVED_FEATURES=1`).
- Early stopping holds back the last 15% of training dates. Refitting on all training dates at the chosen iteration may recover some accuracy; this has not been tested.
- The model is trained on one year (2025). Scores for other years and for places outside the training extent are extrapolations.
- No temporal (multi-day) weather features and no fire-weather index: neither is available per fire at serving time, so neither was invented.

CatBoost was benchmarked against Random Forest and XGBoost; see the next section.

### Comparing baseline models

`modeling/compare_models.py` compares Random Forest, XGBoost, and CatBoost using stratified 5-fold cross-validation. It derives the binary `high_frp` target from `frp >= 10 MW` by default, uses the project's fire predictors (and weather predictors if present in the input CSV), and reports Accuracy, Precision, Recall, F1, and ROC-AUC as mean ± standard deviation. This is a random-fold comparison; nearby detections and dates can be correlated, so use the production trainer's chronological hold-out when estimating performance on future dates.

Install the model-comparison dependencies with `pip install -r requirements.txt`.

```bash
python modeling/compare_models.py
python modeling/compare_models.py --data cleaned_data/cleaned_master_fires.csv --folds 5 --max-rows 500000
python modeling/compare_models.py --task regression --target-column frp
```

The default 500,000-row cap is a reproducible uniform sample to keep repeated CV practical on the full fire archive. Use `--max-rows 0` to evaluate every usable row. For another dataset, pass `--feature-columns col_a,col_b,...` and set `--target-column`; categorical predictors are imputed and one-hot encoded. To tune the baseline models, adjust their estimator settings in `make_models()` in [modeling/compare_models.py](./modeling/compare_models.py).

**Results of a run on 500,000 rows** sampled from `cleaned_master_fires.csv` (about 40.7 million valid rows in the archive), using the fire features only (`latitude`, `longitude`, `brightness`, `confidence`, `scan`, `track`, `type`, `acq_time`, `day_of_year`), mean ± standard deviation over 5 folds:

| Model | Accuracy | Precision | Recall | F1 | ROC-AUC |
|---|---|---|---|---|---|
| Random Forest | 0.8401 ± 0.0009 | 0.7451 ± 0.0018 | 0.6539 ± 0.0018 | 0.6965 ± 0.0017 | 0.8927 ± 0.0003 |
| XGBoost | **0.8463** ± 0.0005 | **0.7907** ± 0.0013 | 0.6154 ± 0.0008 | 0.6921 ± 0.0009 | **0.8987** ± 0.0007 |
| CatBoost | 0.8125 ± 0.0007 | 0.6311 ± 0.0012 | **0.7985** ± 0.0019 | **0.7050** ± 0.0009 | 0.8967 ± 0.0006 |

How to read it:

- All three models rank detections similarly well (ROC-AUC between 0.893 and 0.899); the differences are in the precision/recall trade-off.
- **CatBoost** has the best F1 and by far the highest recall, so it finds the most severe detections but raises more false alarms (lowest precision).
- **XGBoost** is the most precise and the most accurate, but misses more severe detections.
- **Random Forest** sits between the two.
- The production trainer uses CatBoost. These folds are random, so they are likely more optimistic than the chronological hold-out; compare models on the same split before drawing conclusions about future performance.

### Training options

```bash
python modeling/train_model.py                      # train (skipped if the artifact exists)
FORCE_RETRAIN=1 python modeling/train_model.py      # retrain over an existing artifact
TRAINING_SOURCE=csv python modeling/train_model.py  # train from cleaned_data/ without PostgreSQL
```

| Variable | Default | Purpose |
|---|---|---|
| `HIGH_FRP_THRESHOLD` | `10` | FRP (MW) at or above which a detection is labelled severe |
| `MAX_WEATHER_DISTANCE_KM` | `100` | Maximum distance for matching a fire to a same-day weather point |
| `MAX_TRAINING_ROWS` | `500000` | Cap on the size of the random training sample |
| `REQUIRE_WEATHER_MATCH` | `1` | `1` trains only on weather-matched fires; `0` trains on all and leaves missing weather blank (the model learns blanks) |
| `TRAINING_SOURCE` | `db` | `db` (PostgreSQL) or `csv` (cleaned files, uses `fires_sample.csv` when present) |
| `MODEL_ARTIFACT_PATH` | `modeling/artifacts/high_frp_classifier.joblib` | Where the model is saved |
| `FORCE_RETRAIN` | `0` | Retrain even if an artifact exists |
| `DB_SCHEMA` | `public` | Schema holding the tables |
| `CATBOOST_ITERATIONS` | `1000` | Cap on boosting rounds; early stopping usually stops sooner |
| `CATBOOST_EARLY_STOPPING_ROUNDS` | `50` | Stop when validation AUC has not improved for this many rounds, and keep the best iteration |
| `CATBOOST_DEPTH` / `CATBOOST_LEARNING_RATE` / `CATBOOST_L2_LEAF_REG` | `6` / `0.05` / `3` | Tree depth, learning rate, L2 regularisation |
| `CATBOOST_BORDER_COUNT` | `0` (CatBoost default) | Number of bins per numeric feature |
| `VALIDATION_SHARE` | `0.15` | Share of the latest training dates used for early stopping and the threshold (the test period is never used) |
| `TARGET_RECALL` | `0.85` | The saved decision threshold is the highest one that still catches this share of severe fires on the validation slice |
| `TUNE` | `0` | `1` first tries depth 4/6/8 x learning rate 0.05/0.1 with 3-fold spatial cross-validation and uses the best |
| `BLANK_AUGMENT_SHARE` | `0.5` | Extra training copies with inputs blanked (see Missing inputs) |

Model hyperparameters are set in `modeling/train_model.py`. The artifact is written to a temporary file and swapped in, so a running API never reads a half-written model and a failed save keeps the previous one.

---

## 🌐 API (FastAPI)

Start it with `uvicorn api.main:app --reload` (or through Docker). The interactive reference is at `/docs`.

### Endpoints

| Method and path | Description |
|---|---|
| `GET /health` | Status of the data backend, model, weather index, and fire date range (`ok` or `degraded`) |
| `GET /api/v1/model` | Model metadata: features, target, metrics, feature importances, training extent |
| `POST /api/v1/refresh` | Rebuild the weather index and date-range caches after a pipeline run |
| `GET /api/v1/fires` | Filtered, paginated detections; `predict=true` attaches predictions, `include_total=true` adds a total count |
| `GET /api/v1/fires/geojson` | The same detections as a GeoJSON FeatureCollection (predictions on by default) |
| `GET /api/v1/fires/stats` | Totals, mean and max FRP, severe share, and breakdowns by date, satellite, and day/night |
| `GET /api/v1/fires/date-range` | Earliest and latest acquisition dates |
| `GET /api/v1/weather` | Weather observations with optional date filter |
| `POST /api/v1/predict` | Score one detection (weather is matched automatically) |
| `POST /api/v1/predict/batch` | Score many detections (up to `API_MAX_BATCH_PREDICTIONS`) |
| `POST /api/v1/ask` | Ask a question in plain language (see [Ask the Data](#-ask-the-data-assistant)) |
| `GET /api/v1/ask/status` | Whether the assistant is available |

**Fire filters** (shared by the fire endpoints): `start_date`, `end_date`, `bbox` (`min_lon,min_lat,max_lon,max_lat`), `source` (repeatable: `modis`, `viirs_j1`, `viirs_suomi`), `min_confidence`, `min_frp`, `max_frp`, `daynight` (`D` or `N`), `limit`, `offset`, and `order` (`acq_date_desc`, `acq_date_asc`, `frp_desc`, `frp_asc`). Invalid combinations return `422`.

**Example**

```bash
curl -X POST http://localhost:8000/api/v1/predict \
  -H "Content-Type: application/json" \
  -d '{
        "latitude": 30.05, "longitude": 31.2, "acq_date": "2025-01-15",
        "acq_time": 1130, "brightness": 325.4, "confidence": 80,
        "scan": 1.1, "track": 1.0, "type": 0
      }'
```

The response contains `high_frp_probability`, `is_high_frp`, `predicted_label`, the `weather` that was matched (or `supplied` by the caller), and `in_training_extent`, which is `false` when the location or date lies outside what the model was trained on, meaning the score is an extrapolation. Weather values can be passed in the request (`rh2m`, `prectotcorr`, `gwettop`) and take priority over the matched ones.

### Data backends

`DATA_BACKEND` selects where the API reads data:

| Value | Behaviour |
|---|---|
| `auto` (default) | Use PostgreSQL when reachable, otherwise fall back to the cleaned CSV files |
| `postgres` | PostgreSQL only; fail if unavailable |
| `csv` | In-memory CSV backend |

The CSV backend serves `cleaned_data/fires_sample.csv` when present, otherwise the first `CSV_MAX_ROWS` rows of `cleaned_master_fires.csv`. Create a sample with:

```bash
python -m api.tools_make_sample --rows 300000
```

For fast filtering on large PostgreSQL tables, create the indexes once (idempotent):

```bash
python -m api.tools_create_indexes
```

### Resilience

A missing database or model does not stop the service. The affected endpoints answer `503` with an explanation, `/health` reports `degraded` and says why, and the frontend keeps loading. The weather index and fire date range are cached and rebuilt after `API_CACHE_TTL_SECONDS` (default 300) or when `POST /api/v1/refresh` is called, so new weather data and an extended date range appear without restarting the API. The model and the CSV fire data are loaded at startup, so restart the API after retraining or replacing CSV files (see [Known Limitations](#️-known-limitations)).

---

## 🗺️ Frontend (Leaflet map)

The API serves the frontend at `/` (disable with `SERVE_FRONTEND=0`). It needs internet access in the browser to load Leaflet, anime.js, a web font, and map tiles.

- **Map** of fire detections coloured by predicted severity, predicted probability, measured FRP, or satellite, with several basemaps (light, dark, satellite imagery, streets).
- **Summary panel** with the number of detections, the share the model expects to be severe versus the share measured at or above the threshold, a daily chart, and a per-satellite breakdown.
- **Filters**: date range, satellite, "only the area on screen", minimum confidence, minimum FRP, day/night, and how many points to draw (up to 50,000).
- **Score a detection of your own**: click the map to place a draggable pin, set the sensor and detection values, and get the severity probability with the weather that was matched, plus the features that drive the model.
- **Ask about the data**: the assistant panel described below.
- **Appearance**: Graphite and Forest palettes with auto, light, and dark modes.

---

## 💬 Ask the Data (assistant)

`POST /api/v1/ask` (and the "Ask about the data" panel in the map) answers natural-language questions such as "How did severe fires change month by month?" or "How reliable is the severity model?". It is powered by Claude and works through read-only tools, so numbers come from the data rather than from the model's memory.

| Tool | Purpose |
|---|---|
| `get_data_coverage` | Date range, backend, whether the API serves a random sample, weather coverage |
| `get_fire_statistics` | Counts, FRP statistics, severe share, and breakdowns for any filter |
| `list_fires` | Individual detections (up to 50), optionally with predicted probability |
| `predict_fire_severity` | Score a hypothetical or real detection |
| `get_model_info` | Metrics, feature importances, hyperparameters, training extent |
| `search_project_docs` | TF-IDF search over this README and a built-in data dictionary |

Details:

- The tool loop is capped (`ASSISTANT_MAX_ROUNDS`), every lookup is returned to the caller in `tool_calls`, and tool errors are passed back to the model so it can correct its input.
- Tool inputs are validated and clamped before they reach a query.
- The system prompt and tool definitions are prompt-cached between requests.
- When the CSV backend serves a sample, the assistant says so and scales absolute counts accordingly.
- The assistant needs `ANTHROPIC_API_KEY`; the rest of the API works without it. Switch it off with `ASSISTANT_ENABLED=0`. Choose the model with `ASSISTANT_MODEL` and the reasoning effort with `ASSISTANT_EFFORT` (`low`, `medium`, `high`, `xhigh`, or `max`).
- `ASSISTANT_FALLBACKS=1` lets the API re-run a request on Anthropic's recommended fallback model if a safety classifier declines it.
- Because `search_project_docs` indexes this README, keeping it accurate directly improves the assistant's answers about the project.

---

## 🐳 Docker

One image serves both the API (default command) and the pipeline. The image runs as a non-root user and has a health check on `/health`.

```bash
cp .env.example .env            # set DB_PASSWORD (required by Compose)

docker compose up -d                       # PostGIS + API (the API falls back to CSV until data is loaded)
docker compose run --rm pipeline           # one full run: extract → transform → load → train
docker compose --profile scheduled up -d   # also start the scheduler that reruns the pipeline periodically
docker compose --profile airflow up -d     # Airflow UI at http://localhost:8080
```

| Service | Image | Profile | Purpose |
|---|---|---|---|
| `db` | `postgis/postgis:16-3.4` | always | PostgreSQL + PostGIS with a persistent volume |
| `api` | `geodata-ai` | always | FastAPI service on `API_PORT` (default 8000) |
| `pipeline` | `geodata-ai` | `pipeline` | One-shot `python main.py` |
| `scheduler` | `geodata-ai` | `scheduled` | `python scheduler.py` |
| `airflow` | `geodata-airflow` | `airflow` | Airflow standalone with the project DAG |

Put the FIRMS archives in `./raw_data` before running the pipeline. `raw_data`, `cleaned_data`, `logs`, and `modeling/artifacts` are mounted as volumes, so data and the trained model survive container rebuilds.

---

## ⏱️ Scheduling and Airflow

### Interval scheduler

`scheduler.py` reruns `main.py` in a subprocess on a fixed interval, so a failing run never takes the scheduler down. It logs to `logs/scheduler.log`.

```bash
PIPELINE_INTERVAL_HOURS=24 python scheduler.py
```

| Variable | Default | Purpose |
|---|---|---|
| `PIPELINE_INTERVAL_HOURS` | `24` | Hours between runs (fractions allowed) |
| `PIPELINE_RUN_ON_START` | `1` | Run immediately on start-up |
| `PIPELINE_MAX_RUNS` | unlimited | Stop after this many runs |

Because every stage is idempotent, a scheduled run is cheap when nothing has changed. You can also call `python main.py` from cron or Windows Task Scheduler.

### Airflow DAG

`orchestration/dags/geodata_pipeline.py` runs the stages as separate, retryable tasks (2 retries with exponential backoff, one active run at a time):

```text
download_weather ─┬─ transform_fires ───┬─ check_cleaned_outputs ─ load_database ─ train_model ─ refresh_api
                  └─ transform_weather ─┘
```

- `check_cleaned_outputs` fails fast before the database is touched if a transform produced nothing.
- `refresh_api` calls `POST /api/v1/refresh` on `GEODATA_API_URL` so new weather data and the extended date range are served immediately (a retrained model is picked up when the API restarts). It never fails the pipeline, because the API may simply not be running.
- Trigger the DAG with `{"retrain": true}` to retrain over an existing model.
- The task functions live in `orchestration/tasks.py` and do not import Airflow, so they are unit-testable and reusable from any scheduler.
- `GEODATA_SCHEDULE` sets the schedule (default `@daily`; `none` for manual only). With `docker compose --profile airflow up -d` the UI is at `http://localhost:8080` and the admin password is printed in the container log on first start. This Compose service is for a single machine; use the official multi-container Airflow setup with the same DAG folder in production.

---

## ⚙️ Configuration Reference

Everything is configured through environment variables (loaded from `.env`). `.env.example` is the complete template.

| Group | Variables |
|---|---|
| Database | `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_SCHEMA` |
| Data locations | `RAW_DATA_DIR`, `CLEANED_DATA_DIR` |
| Weather download | `WEATHER_COVERAGE`, `WEATHER_GRID_LAT_STEP`, `WEATHER_GRID_LON_STEP`, `WEATHER_REQUEST_PAUSE`, `WEATHER_START`, `WEATHER_END`, `WEATHER_LATITUDE`, `WEATHER_LONGITUDE` |
| Modeling | `HIGH_FRP_THRESHOLD`, `MAX_WEATHER_DISTANCE_KM`, `REQUIRE_WEATHER_MATCH`, `TRAINING_SOURCE`, `MAX_TRAINING_ROWS`, `MODEL_ARTIFACT_PATH`, `FORCE_RETRAIN` |
| API | `DATA_BACKEND`, `MODEL_PATH`, `DECISION_THRESHOLD`, `CORS_ORIGINS`, `API_MAX_GEOJSON_FEATURES`, `API_CACHE_TTL_SECONDS`, `CSV_MAX_ROWS`, `FIRES_SAMPLE_FILE`, `SERVE_FRONTEND`, `API_LOG_FILE`, `LOG_LEVEL` |
| Assistant | `ANTHROPIC_API_KEY`, `ASSISTANT_ENABLED`, `ASSISTANT_MODEL`, `ASSISTANT_EFFORT`, `ASSISTANT_MAX_ROUNDS`, `ASSISTANT_FALLBACKS` |
| Docker and scheduling | `API_PORT`, `DB_PORT_HOST`, `PIPELINE_INTERVAL_HOURS`, `PIPELINE_RUN_ON_START`, `GEODATA_SCHEDULE`, `GEODATA_API_URL`, `AIRFLOW_PORT`, `AIRFLOW_UID` |

Never commit `.env`; it is listed in `.gitignore` together with `raw_data/`, `cleaned_data/`, and `logs/`.

---

## 📝 Logging

| File | Written by | Content |
|---|---|---|
| `logs/pipeline.log` | the pipeline stages (via `config.py`) | Stage progress, row counts, warnings, errors |
| `logs/api.log` | the API (rotating, 5 MB × 5 files) | Startup, model and data events, uvicorn logs, and one line per request |
| `logs/scheduler.log` | `scheduler.py` | Run start, duration, success or failure |

Every API response carries `X-Request-ID` and `X-Response-Time-ms` headers, and unhandled errors are returned as JSON with the request id so failures can be correlated with the log. Set `LOG_LEVEL` to change verbosity.

---

## 🧪 Tests

```bash
pip install -r requirements-dev.txt
pytest
```

The suite runs against a tiny fire and weather dataset served through the CSV backend, so it does not need the large data files or an Anthropic key. Database tests use SQLite locally, and the CI test job also starts a temporary PostgreSQL/PostGIS service container so spatial and database queries can be exercised against PostGIS. The Airflow DAG test is skipped automatically when Airflow is not installed (Airflow itself runs in Docker).

| File | Covers |
|---|---|
| `tests/test_api.py` | Health, model info, fire filters, GeoJSON, stats, weather, predictions, headers, frontend |
| `tests/test_assistant.py` | The tool loop with a fake client, tool validation, documentation search, assistant endpoints |
| `tests/test_degraded.py` | Missing model or data backend, exact GeoJSON truncation, cache refresh, error responses |
| `tests/test_sql_repository.py` | The PostgreSQL repository's filters, pagination, statistics, and weather reads |
| `tests/test_load.py` | Staging-table loading, skip logic, reload on changed weather, crash safety |
| `tests/test_weather_download.py` | Grid footprint, tile alignment, year chunks, parameter validation |
| `tests/test_orchestration.py` | Task functions, API refresh behaviour, and the Airflow DAG structure (needs Airflow installed) |

---

## 🚦 CI/CD (GitHub Actions)

The workflow in `.github/workflows/ci.yml` (named **CI/CD**) checks every change and publishes a ready-to-run Docker image.

**Triggers**

| Event | When |
|---|---|
| `pull_request` | Pull requests targeting `main` (test and build only) |
| `push` | Every push to `main` (test, build, and publish) |
| `workflow_dispatch` | Manual run from the Actions tab (publishes only when run on `main`) |

**Jobs**

```text
 ┌────────┐
 │  Test  │──┐
 └────────┘  ├──▶ ┌──────────────────────────┐
 ┌────────┐  │    │ Publish image to GHCR    │   (push to main / manual run on main)
 │ Build  │──┘    └──────────────────────────┘
 └────────┘
```

| Job | What it does |
|---|---|
| **Test** | Sets up Python 3.12 with pip caching, starts a temporary **PostgreSQL/PostGIS service container**, installs `requirements-dev.txt`, and runs `python -m pytest`. The tests do not need the large data files, and the Airflow DAG test is skipped because Airflow is not installed in this job. |
| **Build Docker image** | Builds the `Dockerfile` with Docker Buildx without pushing it, to prove that the image still builds on every pull request. |
| **Publish image to GHCR** | Runs only after **Test** and **Build** both pass. Logs in to `ghcr.io` with the built-in `GITHUB_TOKEN`, builds the image, and pushes it with two tags: `latest` and the full commit SHA. Uses the GitHub Actions layer cache to speed up builds. |

**Safety details**

- The workflow has read-only repository permissions by default; only the publish job is granted `packages: write`.
- No extra secrets are needed. Publishing uses the automatic `GITHUB_TOKEN`.
- Concurrent runs for the same pull request or branch are grouped, and an older pull-request run is cancelled when a new commit is pushed.

**Using the published image**

```bash
docker pull ghcr.io/geodata-nasa/geodata-ai-forest-fires-climate-intelligence-pipeline:latest
```

Use the `sha-<commit>` tag to pin an exact version. New GHCR packages are private by default, so change the package visibility in the repository's package settings if you want others to pull the image without logging in.

> This pipeline covers continuous integration and continuous delivery of the image. It does not deploy to a server; deployment is done with Docker Compose or your own platform (see [Docker](#-docker)).

---

## ✅ Verify the Load

```sql
SELECT COUNT(*) FROM fire_events;
SELECT COUNT(*) FROM weather_data;

SELECT MIN(acq_date), MAX(acq_date) FROM fire_events;

-- The tables store plain latitude/longitude columns; build PostGIS geometries on demand
SELECT ST_AsText(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))
FROM fire_events
LIMIT 5;
```

Or ask the running API: `curl http://localhost:8000/health`.

---

## 🧯 Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| `psycopg2` connection error | Check the `.env` values and that PostgreSQL is running; in Docker the host is `db` |
| `type "geometry" does not exist` | Run `CREATE EXTENSION postgis;` in the target database |
| `Grid weather needs the fire data…` | Neither `cleaned_master_fires.csv` nor the raw FIRMS archives were found; place them in `raw_data/` using the names in [Getting Started](#3-add-the-firms-archives) |
| Weather download is slow or interrupted | It is resumable: rerun `python main.py` and cached tiles are reused. Raise `WEATHER_REQUEST_PAUSE` if POWER throttles you |
| Model finds no matching weather | Weather rows need `date`, `latitude`, `longitude`; rerun extraction, transformation, and loading, or increase `MAX_WEATHER_DISTANCE_KM` |
| A stage is skipped unexpectedly | Its output already exists; delete the file, table, or artifact to rerun it (or `FORCE_RETRAIN=1` for training) |
| Validation does not run again | Delete `cleaned_data/.fire_validated.flag` |
| API returns `503` on data endpoints | No data backend is available; check `/health`, run the pipeline, or use `DATA_BACKEND=csv` |
| Predictions return `503` | The model is not loaded; train it or check `MODEL_PATH` |
| New weather data or dates do not appear in the API | Call `POST /api/v1/refresh` or wait for `API_CACHE_TTL_SECONDS` |
| A retrained model or new CSV fire data is not served | Restart the API; the model and CSV fires are loaded at startup |
| Leftover `tmp*.csv` files in `cleaned_data/` | An earlier run was interrupted; they are safe to delete (final files are replaced only after a run completes) |
| `/api/v1/ask` returns `503` | `ANTHROPIC_API_KEY` is missing or `ASSISTANT_ENABLED=0`; see `/api/v1/ask/status` |
| Package install fails | Use Python 3.10 – 3.12 and a fresh virtual environment |
| Unclear failure | Check `logs/pipeline.log` (pipeline) or `logs/api.log` (API) |

---

## ⚠️ Known Limitations

Open items from an independent code review of commit `7315dcc` (6 November 2026). Fixes made since then, such as the canonical fire schema and atomic file writes, are not listed. These are scoped to local, trusted use today and are the main work needed before a public deployment.

| Area | Limitation | What to do for now |
|---|---|---|
| Security | The API has no authentication or rate limiting. `/api/v1/ask` spends Anthropic credit, `/api/v1/refresh` rebuilds caches, and CORS defaults to `*`. | Run locally or behind an authenticating reverse proxy, set `CORS_ORIGINS`, and do not expose the API port to the internet |
| Refresh | `POST /api/v1/refresh` rebuilds the weather index and date range only; the model and CSV fire data are loaded at startup | Restart the API after retraining or replacing CSV files |
| Settings consistency | Training stores its threshold and weather radius in the artifact, but the API takes its own values from the environment and does not compare them | Use the same `HIGH_FRP_THRESHOLD` and `MAX_WEATHER_DISTANCE_KM` for training and serving |
| Skip logic | Stages check that outputs exist, not that inputs changed; weather loading compares row counts only | Delete the stale output (file, table, or artifact) after changing inputs or settings |
| Database schema | The loader does not apply `DB_SCHEMA` (the API and trainer do) | Keep `DB_SCHEMA=public` |
| Health check | `/health` returns HTTP 200 even when `status` is `degraded`, so the Docker health check cannot detect it | Read the `status` field in the response |
| CSV backend | Without a sample file, the first `CSV_MAX_ROWS` rows are used (not a random sample), and the assistant may describe them as one | Create a sample with `python -m api.tools_make_sample` and avoid setting `CSV_MAX_ROWS` below the sample size |
| Model scope | All `type` values (vegetation fires, volcanoes, static sources, offshore) are used without filtering, and performance is reported overall, not per sensor or region | Treat scores as hot-spot severity, not as wildfire-only severity |
| Frontend | Map popups insert `satellite_source` into HTML unescaped | Safe with NASA data; sanitize before loading untrusted data |
| Logging | `pipeline.log` and `scheduler.log` are not rotated | Rotate or clear them on long-running deployments |
| Reproducibility | Dependencies are not locked | Load the model with the library versions used to train it, and retrain after upgrading |
| Tests | The ETL tests use already-standardized fixtures rather than raw multi-sensor files, and interrupted runs are not simulated | Treat raw-file handling as less tested than the API |

---

## 🗺️ Roadmap

**Completed**

- [x] Project structure, centralized configuration, and dependency management
- [x] ETL pipeline for NASA FIRMS (MODIS and VIIRS) and NASA POWER data
- [x] Global weather coverage with a resumable tile cache
- [x] PostgreSQL/PostGIS loading through staging tables, with skip logic
- [x] Data-quality validation with a flag file
- [x] High-FRP classifier with a chronological hold-out (CatBoost in production)
- [x] Model benchmarking script (Random Forest vs XGBoost vs CatBoost)
- [x] Canonical fire schema and atomic file writes in the ETL
- [x] Pipeline orchestrator (`main.py`), structured logging, and idempotent stages
- [x] FastAPI service with PostgreSQL and CSV backends, predictions, and request logging
- [x] Leaflet map frontend with click-to-predict
- [x] "Ask the data" assistant with read-only tools and documentation search
- [x] Docker and Docker Compose setup
- [x] Scheduling with `scheduler.py` and an Airflow DAG
- [x] Automated test suite
- [x] CI/CD with GitHub Actions: tests, Docker build, and image publishing to GHCR
- [x] Windows one-click launcher

**Next steps**

- [ ] Power BI dashboard on top of the stored data
- [ ] Evaluate the model per sensor and region, and against a no-weather baseline
- [ ] Address the open items listed under [Known Limitations](#️-known-limitations), starting with API authentication
- [ ] Automated deployment step (for example to a cloud host) after the image is published
- [ ] Authentication and rate limiting for the API, especially `/api/v1/ask`
- [ ] Model improvements: try gradient boosting and richer weather features, since weather currently contributes modestly to the score
- [ ] Train on a larger share of the data (raise `MAX_TRAINING_ROWS`) and track metrics across retrains

**Future ideas**

- [ ] A fire-occurrence model, which would need labelled no-fire observations
- [ ] Embedding-based retrieval for the assistant's documentation search

---

## 💼 Business Model (Concept)

> This section describes how GeoData AI could become a sustainable product. It is a set of hypotheses to validate with real users, not a description of a running business. Prices are intentionally left out until they are tested with customers.

### Where the project stands today

| Available today | Needed before it can be sold |
|---|---|
| Automated, resumable pipeline over global NASA FIRMS and POWER data (refreshed on a schedule, daily by default) | Near-real-time ingestion if customers need alerts within hours |
| Severity scoring API, interactive map, and natural-language assistant | API keys, authentication, rate limiting, and usage metering |
| Docker, Airflow, and CI/CD for repeatable deployment | Multi-tenant isolation, monitoring, and a service-level agreement |
| CatBoost severity model, benchmarked against Random Forest and XGBoost (cross-validated ROC-AUC about 0.90) | A fire-occurrence or risk model and validation against customer data |
| Roadmap item: Power BI dashboard | Power BI connectors and report templates |

### Value proposition

The raw satellite and weather data are free. The value is in turning them into something usable:

- **Fusion and scoring**: fire detections joined to same-day weather and scored for expected severity.
- **Ready-to-use access**: one REST API, a map, and plain-language questions, instead of raw CSV archives.
- **Automation and reproducibility**: a pipeline that refreshes itself and can run on the customer's own infrastructure with Docker.

### Customer segments (start narrow)

| Priority | Segment | Why |
|---|---|---|
| 1 | Developers, researchers, universities, and NGOs | Lowest cost to reach, fastest feedback, fits an open-core model |
| 2 | Agriculture, forestry, and utility operations teams monitoring land or assets | Clear operational use of severity and location data |
| 3 | Civil protection and environmental agencies | Strong fit, but long procurement cycles; often funded through tenders and grants |
| 4 | Insurance and reinsurance | Large market, but underwriting needs property-level risk models, validation, and compliance that the current severity model does not provide |

### Revenue streams

- **Open core + managed API**: the code stays open source; a hosted API offers a free rate-limited tier and paid usage-based tiers.
- **Subscriptions** for hosted dashboards, alerts, and scheduled reports (including Power BI connectors once built).
- **Enterprise and self-hosted support**: paid support, onboarding, and service-level agreements for organizations that run the Docker or Airflow deployment themselves.
- **Professional services**: custom data pipelines, regional deployments, and integrations.
- **Grants and sponsorship**: climate-tech and research funding as early, non-dilutive income.

### Cost structure

- Cloud hosting and storage (tens of millions of detections in PostgreSQL/PostGIS, plus compute for training and the API).
- Claude API usage for the assistant, which costs money per question and should be rate limited and capped.
- Engineering and maintenance, including model monitoring and retraining.
- Support, security, and compliance work.

### Key partnerships

- **NASA FIRMS and NASA POWER** as data providers (follow their attribution and usage terms).
- **Cloud providers** for startup credits and hosting.
- **Universities, forestry agencies, and civil protection bodies** as pilot partners and sources of ground-truth validation.
- **GIS and business-intelligence vendors** for connectors such as Power BI.

### Competition and defensibility

Free tools already show active fires (NASA's own FIRMS map is one), so selling the data itself is not defensible. Defensibility has to come from scoring quality, reliability, integration into customers' workflows (alerts, reports, APIs), local context, and the option to self-host.

### Risks and assumptions

- The model scores the severity of **detected** fires; it does not predict where a fire will start. It must not be marketed as a fire-risk or underwriting model.
- The contribution of weather data to the model has not been isolated yet. Compare against a no-weather baseline before claiming that climate data improves predictions, and base accuracy claims on measured metrics only.
- Data freshness depends on the pipeline schedule; the product is not real-time unless ingestion is extended.
- Commercial use of NASA open data should be checked against the providers' current terms.
- Dependence on public third-party APIs (for example NASA POWER rate limits).
- Predictions are decision support, not a sole basis for emergency decisions.
- Demand and willingness to pay are unvalidated.

### Validation plan

1. Interview 10 to 20 potential users in the top two segments.
2. Run a pilot with one forestry, agriculture, or civil-protection organization and agree on success metrics (for example precision on severe detections and alert lead time).
3. Add authentication, rate limiting, and usage metering to the API.
4. Only then set pricing, based on the value delivered and on what the pilot users say they would pay.

---

## 📄 License and Data Attribution

This project is licensed under the [MIT License](LICENSE).

**Data attribution:** fire detection data comes from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) (NASA LANCE), and weather data from the NASA POWER API. Please refer to each provider's terms of use and citation requirements when reusing the data.

---

## ☕ Contribution

Contributions, ideas, and discussions are welcome!

If you find it useful, please ⭐ the repository or buy us a coffee! 🙏

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/george_samer)

```
GEODATA
├─ .dockerignore
├─ api
│  ├─ assistant
│  │  ├─ knowledge.py
│  │  ├─ service.py
│  │  ├─ tools.py
│  │  └─ __init__.py
│  ├─ deps.py
│  ├─ filters.py
│  ├─ logging_config.py
│  ├─ main.py
│  ├─ predictor.py
│  ├─ repositories
│  │  ├─ base.py
│  │  ├─ csv_backend.py
│  │  ├─ postgres.py
│  │  └─ __init__.py
│  ├─ routers
│  │  ├─ assistant.py
│  │  ├─ fires.py
│  │  ├─ health.py
│  │  ├─ predict.py
│  │  ├─ weather.py
│  │  └─ __init__.py
│  ├─ runtime.py
│  ├─ schemas.py
│  ├─ serialization.py
│  ├─ settings.py
│  ├─ tools_create_indexes.py
│  ├─ tools_make_sample.py
│  ├─ version.py
│  ├─ weather_index.py
│  └─ __init__.py
├─ config.py
├─ docker-compose.yml
├─ Dockerfile
├─ frontend
│  ├─ app.js
│  ├─ index.html
│  └─ style.css
├─ geoflare
│  ├─ .dockerignore
│  ├─ api
│  │  ├─ air.py
│  │  ├─ analytics.py
│  │  ├─ live.py
│  │  ├─ main.py
│  │  ├─ store.py
│  │  └─ __init__.py
│  ├─ data
│  │  ├─ agg
│  │  │  ├─ modis
│  │  │  │  ├─ 2000.parquet
│  │  │  │  ├─ 2001.parquet
│  │  │  │  ├─ 2002.parquet
│  │  │  │  ├─ 2003.parquet
│  │  │  │  ├─ 2004.parquet
│  │  │  │  ├─ 2005.parquet
│  │  │  │  ├─ 2006.parquet
│  │  │  │  ├─ 2007.parquet
│  │  │  │  ├─ 2008.parquet
│  │  │  │  ├─ 2009.parquet
│  │  │  │  ├─ 2010.parquet
│  │  │  │  ├─ 2011.parquet
│  │  │  │  ├─ 2012.parquet
│  │  │  │  ├─ 2013.parquet
│  │  │  │  ├─ 2014.parquet
│  │  │  │  ├─ 2015.parquet
│  │  │  │  ├─ 2016.parquet
│  │  │  │  ├─ 2017.parquet
│  │  │  │  ├─ 2018.parquet
│  │  │  │  ├─ 2019.parquet
│  │  │  │  ├─ 2020.parquet
│  │  │  │  ├─ 2021.parquet
│  │  │  │  ├─ 2022.parquet
│  │  │  │  ├─ 2023.parquet
│  │  │  │  ├─ 2024.parquet
│  │  │  │  └─ 2025.parquet
│  │  │  ├─ viirs-jpss1
│  │  │  │  ├─ 2018.parquet
│  │  │  │  ├─ 2019.parquet
│  │  │  │  ├─ 2020.parquet
│  │  │  │  ├─ 2021.parquet
│  │  │  │  ├─ 2022.parquet
│  │  │  │  ├─ 2023.parquet
│  │  │  │  ├─ 2024.parquet
│  │  │  │  └─ 2025.parquet
│  │  │  └─ viirs-snpp
│  │  │     ├─ 2012.parquet
│  │  │     ├─ 2013.parquet
│  │  │     ├─ 2014.parquet
│  │  │     ├─ 2015.parquet
│  │  │     ├─ 2016.parquet
│  │  │     ├─ 2017.parquet
│  │  │     ├─ 2018.parquet
│  │  │     ├─ 2019.parquet
│  │  │     ├─ 2020.parquet
│  │  │     ├─ 2021.parquet
│  │  │     ├─ 2022.parquet
│  │  │     ├─ 2023.parquet
│  │  │     ├─ 2024.parquet
│  │  │     └─ 2025.parquet
│  │  ├─ live
│  │  │  └─ 24h.parquet
│  │  ├─ product
│  │  │  ├─ cells.parquet
│  │  │  ├─ cellweek.parquet
│  │  │  ├─ final_model.joblib
│  │  │  ├─ rankings.json
│  │  │  └─ report.json
│  │  ├─ ref
│  │  │  └─ countryInfo.txt
│  │  └─ weekly
│  │     └─ agg
│  │        ├─ modis.parquet
│  │        ├─ viirs-jpss1.parquet
│  │        └─ viirs-snpp.parquet
│  ├─ Dockerfile
│  ├─ pipeline
│  │  ├─ aggregate.py
│  │  ├─ build.py
│  │  ├─ config.py
│  │  ├─ dev_local.py
│  │  ├─ download.py
│  │  ├─ harmonize.py
│  │  ├─ rankings.py
│  │  ├─ run.py
│  │  ├─ weekly.py
│  │  └─ __init__.py
│  ├─ README.md
│  ├─ requirements.txt
│  ├─ start.cmd
│  └─ web
│     ├─ air.js
│     ├─ app.js
│     ├─ fires.css
│     ├─ fires.js
│     ├─ flick.js
│     ├─ index.html
│     ├─ intro.js
│     ├─ style.css
│     └─ ui.js
├─ GEOFLARE_GUIDE.md
├─ integration
│  └─ NASA_POWER.py
├─ LICENSE
├─ loadation
│  └─ load.py
├─ main.py
├─ modeling
│  ├─ artifacts
│  │  └─ high_frp_classifier.joblib
│  ├─ compare_models.py
│  ├─ features.py
│  ├─ risk.py
│  └─ train_model.py
├─ orchestration
│  ├─ airflow.Dockerfile
│  ├─ dags
│  │  └─ geodata_pipeline.py
│  ├─ tasks.py
│  └─ __init__.py
├─ README.md
├─ requirements-dev.txt
├─ requirements.txt
├─ run_pipeline_and_servers.cmd
├─ scheduler.py
├─ scripts
│  ├─ geodata.ico
│  └─ start_app.cmd
├─ start_all_master.cmd
├─ tests
│  ├─ conftest.py
│  ├─ test_api.py
│  ├─ test_assistant.py
│  ├─ test_blank_inputs.py
│  ├─ test_degraded.py
│  ├─ test_load.py
│  ├─ test_model_upgrades.py
│  ├─ test_orchestration.py
│  ├─ test_risk_score.py
│  ├─ test_sql_repository.py
│  ├─ test_weather_download.py
│  └─ __init__.py
├─ transformation
│  └─ transform.py
└─ utils
   └─ quality_checks.py

```