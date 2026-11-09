# GeoFlare

**Three apps for our planet's fires and the air around them.** GeoFlare Dashboard: a fire calendar for any place on Earth since 2003, today's fires, and a country leaderboard. GeoFlare Fires: which fires could turn severe, and the archive map. GeoFlare Air: is the air safe where you live, near gas flares and factories, and what to do about it.

NASA Space Apps 2026 · Team FLARECRAFT (Assiut, Egypt): George Essam, Mathew Emad, Sondos Alsayed · Challenge: *Harmonization of MODIS and VIIRS Hot Spots*

> **Validation (full 2003-2025 record, leave one year out, 14 held-out years):** the median monthly error by region (MdAPE, the median absolute percentage error of 5°×5° region-months) is 33%, against 35% for a single global conversion factor, and the model wins in 12 of the 14 years. The year-level R² on log(1+count) is 0.94, against 0.91 for the single factor. 80% of true values fall inside the 80% uncertainty bands. The gain over one factor is real but modest. The bigger value is the per-place calendar with honest ranges.

## The problem

Satellites have logged active fires since 2000, but the record is split between two sensors.

- **MODIS** (Terra 2000–, Aqua 2002–) sees the ground in 1 km pixels.
- **VIIRS** (S-NPP 2012–, NOAA-20 2018–) sees it in 375 m pixels. For the same fires it records about **4.5×** more detections, and it finds small fires that MODIS misses.

Stitching the two records together makes burning appear to jump several-fold in 2012. Any trend computed on that stitched record measures the sensor change, not the fires. Fire managers are left without a consistent answer to *when and where has burning happened here, and is this year unusual?*

## What we built

1. **A harmonization model.** It learns, cell by cell (0.25°, about 28 km) and week by week, how many detections VIIRS S-NPP would have made, given only what MODIS saw. It is trained on the years when both sensors flew.
2. **A harmonized record from 2003 to today in VIIRS units.**
   - 2012 onward: observed by VIIRS.
   - 2003–2011: reconstructed from MODIS, with **empirical 80% uncertainty bands**.
3. **Three apps in one site**, with an opening story and Flick, our mascot, as narrator and guide. Each app has its own address and can be opened on its own: `/dashboard`, `/fires`, `/air`.

   **GeoFlare Dashboard: the past.** Pick a country, a preset region or any box you draw, and get:
   - a **burning-activity calendar**: years × 52 weeks, with reconstructed weeks hatched and unusual weeks circled;
   - **the fire season**: start, peak, end and critical window. Seasons that cross New Year are handled correctly;
   - **unusual months and years**, scored against that area's own climatology;
   - **long-term trend**: harmonized against the naive stitched record, with Theil–Sen slopes and Mann–Kendall significance;
   - **a 4-week outlook**: the share of a typical year's burning expected in the coming weeks;
   - a **map** of any week, with **industrial heat sources** (gas flares, refineries, offshore platforms) shown separately and kept out of the fire calendar;
   - a **CSV export** and a **printable report**.

   - a **leaderboard**: countries with the fewest severe fires (10 MW or more) and the least factory and flare heat per 1,000 km², in 2025. The country you pick shows its own rank.

   **GeoFlare Dashboard: right now.** Live fires from NASA's public FIRMS feed (VIIRS, last 24 hours or 7 days). The feed has no source type, so factories and gas flares are recognised from the archive.

   **GeoFlare Fires.** The [GeoData AI](https://github.com/GEODATA-NASA/GeoData-AI-Forest-Fires-Climate-Intelligence-Pipeline) CatBoost model (ROC-AUC 0.893 on its chronological hold-out, 0.895 ± 0.005 in spatial cross-validation) scores today's fires, and the app grades it against the fire power the satellites measured. A 4-week outlook combines usual activity from the calendar with the model's severity chance. It is a planning guide, not a forecast of individual fires. "Explore the archive" is the GeoData map rebuilt inside GeoFlare: filters, a day-by-day chart, scoring any spot on the map (blank inputs allowed), and the data assistant. Scores show as a calibrated Fire Risk Score (0-100, Low/Medium/High/Extreme) from the GeoData model. "Open the classic map view" opens the original GeoData map on port 8000, with a button back to GeoFlare Fires.

   **GeoFlare Air.** Type your town or share your location. GeoFlare joins three sources at that point:
   - industrial heat sites within 100 km, from the archive, with distance, direction, how many weeks each glowed, the trend since 2012, and whether each glowed in the last 24 hours;
   - live air quality (US AQI, PM2.5, PM10, NO2, SO2, CO, ozone) and a 36-hour forecast, compared with the WHO 24-hour guidelines;
   - the wind, which tells you whether the brightest site within 50 km is upwind of you right now.

   It gives a verdict, the good and the bad facts behind it, and animated step-by-step precautions for that level of air. The world map of industrial heat sits below; tap any site to check the air there. Air values are CAMS model estimates (10-45 km grid), not a sensor at your door.
4. **An opening story**: a year of fire, the 2012 mystery, the sharper satellite, the fix, today's fires and which could turn severe, the flares that never move, and the air people breathe next to them. Flick narrates and points at what he is talking about; Next steps through his lines and the last one opens the apps.

## Method

| Step | What happens |
|---|---|
| Data | NASA FIRMS yearly archives: MODIS, VIIRS S-NPP and VIIRS NOAA-20 (375 m), about 25 years. |
| Cleaning | Vegetation fires only (FIRMS `type` = 0). Nominal or high confidence only (MODIS ≥ 30, VIIRS n/h). Static industrial sources (type 2/3) and volcanoes (type 1) are tracked separately. |
| Grid | Daily detections aggregated to 0.25° cells, then to 52 weeks per year. |
| Features (MODIS only) | Terra and Aqua counts kept separate (different overpass times); FRP sum and maximum; night share; 8 neighbouring cells; the same cell ±1 week; per-cell fire regime (mean FRP per detection, burn frequency); the cell's VIIRS/MODIS ratio and VIIRS-only background from the overlap years, shrunk toward the global ratio when data is thin; latitude; season. |
| Model | Gradient boosting on log(1+count), plus a binned smearing correction so totals are unbiased. Scikit-learn's Poisson boosting diverged on this data: one tree's Newton step overshot by several orders of magnitude. |
| Validation | **Leave one year out**: for each overlap year, train on all the other years, rebuild that year from MODIS alone, and compare with what VIIRS actually measured. Scored on 5°×5° region-weeks, region-months and region-years, against a **single global conversion factor** as baseline. |
| Leaderboard | `python -m pipeline.rankings`: VIIRS S-NPP vegetation fires with FRP ≥ 10 MW in 2025 (GeoData cleaned file) and industrial hot pixels in 2025, per 1,000 km² of land (GeoNames areas). Countries under 10,000 km² or 100,000 people are listed but not ranked. |
| Air verdict | The higher of the US AQI band and an industry level (closest site within 10 km, or within 30 km with the wind blowing from the brightest site toward you). Precautions follow US EPA AirNow advice for each AQI band. |
| Uncertainty | Empirical quantiles of actual ÷ predicted on the held-out years, by magnitude and time scale. The app reports how often the truth fell inside the 80% band. Observed weeks are bracketed by the two VIIRS instruments (S-NPP and NOAA-20). |

Known limits, stated plainly:

- Years before 2003 are left out, because Aqua (the afternoon MODIS overpass) launched in mid-2002.
- Terra's orbit drifted after 2020 and Aqua's after 2022, which changes MODIS overpass times. The held-out years after 2020 show how much this matters.
- A cell's fire regime is assumed stable between 2003–2011 and the overlap years.
- Counts are detections, not burned area or emissions.

## Run it

GeoFlare is a folder inside the GeoData AI repository. The commands below assume that layout, with this folder as `geoflare/` and GeoData AI as its parent.

### Windows (one click)

The scripts create each virtual environment, install the requirements (including `duckdb`) and start the servers, so there is nothing to set up by hand.

| Run | What happens |
|---|---|
| `..\start_all_master.cmd` | Runs the GeoData AI pipeline (`main.py`), then the GeoFlare pipeline, then starts both servers. For a fresh clone. |
| `..\run_pipeline_and_servers.cmd` | Runs the GeoFlare pipeline (download, aggregate, build, rankings). If every step succeeds it starts both servers; if one fails it stops and starts nothing. |
| `start.cmd` | Starts GeoData AI on port 8000 and GeoFlare on port 8010, then opens the browser. Use it once the data is built. |

`start.cmd dashboard`, `start.cmd fires` or `start.cmd air` opens one app directly; plain `start.cmd` plays the story first. Keep the window open while you use the apps.

### macOS and Linux

```bash
# once
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pipeline.download && .venv/bin/python -m pipeline.aggregate \
  && .venv/bin/python -m pipeline.build && .venv/bin/python -m pipeline.rankings

# every time: GeoFlare on http://127.0.0.1:8010 (GeoData AI runs from the repository root on port 8000)
.venv/bin/python -m uvicorn api.main:app --port 8010
```

### Step by step (any system)

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # on macOS and Linux: .venv/bin/pip
python -m pipeline.download          # ~9.6 GB FIRMS yearly archives (resumable)
python -m pipeline.aggregate         # daily 0.25° aggregates (data/agg)
python -m pipeline.build             # leave-one-year-out validation, final model, products (data/product)
python -m pipeline.rankings          # country leaderboard (needs the GeoData cleaned fire CSV and data/ref/countryInfo.txt from GeoNames)
.venv/Scripts/python -m uvicorn api.main:app --port 8010  # app + API at http://127.0.0.1:8010
```

Generated data is not in this repository, so a fresh clone needs the pipeline steps first. Until `data/product/report.json` exists, `start.cmd` serves a small 2025 preview from `data/product-agg-dev` if you built one (`python -m pipeline.dev_local`, then `python -m pipeline.build --source agg-dev --no-loyo`).

The Severity chapter also needs the GeoData AI service running on port 8000 (`GEODATA_API` overrides the address). `start.cmd` starts it from the parent folder using that folder's `.venv`; in a side-by-side setup, where GeoData AI is a sibling folder called `repo`, it uses that instead. If GeoData AI is not running, the Fires app, the severity scores and the 4-week outlook say the service is offline.

`python -m pipeline.run` does the aggregate and build steps without supervision, picking up each archive as it finishes downloading. Open `/dashboard`, `/fires` or `/air` (or add `?app`) to skip the story.

Pipeline data paths are centralized in `pipeline/config.py`. Defaults are `../firms_archive/zips` for downloads, `data/` for generated data, and `../cleaned_data/` for the cleaned fires CSV. Override them with `FIRMS_ARCHIVE_DIR`, `EMBER_DATA_DIR`, and `CLEANED_DATA_DIR`; `EMBER_PRODUCT` can point the API at a separately located product directory. For Docker, the full endpoint list and every setting, see [GEOFLARE_GUIDE.md](../GEOFLARE_GUIDE.md).

### API

| Endpoint | Returns |
|---|---|
| `GET /api/calendar?country=Brazil` or `?bbox=w,s,e,n` | Calendar, climatology, season, anomalies, trends, outlook, insights |
| `GET /api/map?year=2010&week_from=30&week_to=32&bbox=…` | Harmonized activity and industrial heat per cell |
| `GET /api/export.csv?…` | Weekly raw MODIS, raw VIIRS (both satellites), reconstruction and harmonized series |
| `GET /api/live?window=24h` | Live fires, strongest fires, busiest countries |
| `GET /api/live/severity`, `/api/outlook` | Live fires scored and graded by the GeoData AI model; 4-week outlook |
| `GET /api/industry` | Industrial heat sites, country ranking, yearly trend |
| `GET /api/air?lat=&lon=` | Air verdict, nearby industrial sites, air quality and wind, facts, precautions |
| `GET /api/places?q=` | Place search for the Air check |
| `GET /api/rankings` | Country leaderboard |
| `/geodata/…` | Same-origin pass-through to the GeoData AI service (`health`, `api/v1/*`) |
| `GET /api/meta`, `/api/countries`, `/api/intro` | Validation summary, country list, story data |

## Data

- NASA FIRMS, MODIS Active Fire product (MCD14ML): https://firms.modaps.eosdis.nasa.gov/
- NASA FIRMS, VIIRS 375 m Active Fire product, S-NPP (VNP14IMGML) and NOAA-20 (VJ114IMGML)
- Air quality and wind: Open-Meteo (Copernicus Atmosphere Monitoring Service model data; weather forecast API). Place search: Open-Meteo geocoding.
- Country areas and populations: GeoNames countryInfo.txt.
- Basemap: Esri World Light and Dark Gray. Coastlines: Natural Earth via world-atlas.

## Use of AI ("SI") tools

Claude (Anthropic) designed and wrote most of the pipeline, the model, the API and the front end, working from the team's direction and the challenge statement. That includes proposing the method (unit of analysis, validation protocol, uncertainty approach). Numbers in the app are computed from NASA data by the code in this repository.
