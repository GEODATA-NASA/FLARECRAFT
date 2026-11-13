# Ember Almanac

**The story of our planet's fires: a burning-activity calendar for any place on Earth, the fires burning right now, which could turn severe, and the industry satellites see too.**

NASA Space Apps 2026 · Team FLARECRAFT (Assiut, Egypt): George Essam, Mathew Emad, Sondos Alsayed · Challenge: *Harmonization of MODIS and VIIRS Hot Spots*

> **Status:** work in progress. The app and pipeline run end to end, but the full 2003-2025 record is still being built, so the validation numbers for the harmonization model are not final. The only result so far is a dev check on 2025 alone.

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
3. **A web application with four chapters**, guided by Flick, our mascot.

   **History.** Pick a country, a preset region or any box you draw, and get:
   - a **burning-activity calendar**: years × 52 weeks, with reconstructed weeks hatched and unusual weeks circled;
   - **the fire season**: start, peak, end and critical window. Seasons that cross New Year are handled correctly;
   - **unusual months and years**, scored against that area's own climatology;
   - **long-term trend**: harmonized against the naive stitched record, with Theil–Sen slopes and Mann–Kendall significance;
   - **a 4-week outlook**: the share of a typical year's burning expected in the coming weeks;
   - a **map** of any week, with **industrial heat sources** (gas flares, refineries, offshore platforms) shown separately and kept out of the fire calendar;
   - a **CSV export** and a **printable report**.

   **Right now.** Live fires from NASA's public FIRMS feed (VIIRS, last 24 hours or 7 days). The feed has no source type, so factories and gas flares are recognised from the archive.

   **Severity.** The [GeoData AI](https://github.com/GEODATA-NASA/GeoData-AI-Forest-Fires-Climate-Intelligence-Pipeline) random forest scores live fires, and the app grades it against the fire power the satellites measured. A 4-week outlook multiplies usual activity from the calendar by the model's severity probability. It is a planning guide, not a forecast of individual fires.

   **Industry.** Gas flares, refineries and other persistent industrial heat, by site and by country. These are counts of hot pixels, not volumes of gas.
4. **An opening story** that walks through the past, present, future and industry chapters before the app opens.

## Method

| Step | What happens |
|---|---|
| Data | NASA FIRMS yearly archives: MODIS, VIIRS S-NPP and VIIRS NOAA-20 (375 m), about 25 years. |
| Cleaning | Vegetation fires only (FIRMS `type` = 0). Nominal or high confidence only (MODIS ≥ 30, VIIRS n/h). Static industrial sources (type 2/3) and volcanoes (type 1) are tracked separately. |
| Grid | Daily detections aggregated to 0.25° cells, then to 52 weeks per year. |
| Features (MODIS only) | Terra and Aqua counts kept separate (different overpass times); FRP sum and maximum; night share; 8 neighbouring cells; the same cell ±1 week; per-cell fire regime (mean FRP per detection, burn frequency); the cell's VIIRS/MODIS ratio and VIIRS-only background from the overlap years, shrunk toward the global ratio when data is thin; latitude; season. |
| Model | Gradient boosting on log(1+count), plus a binned smearing correction so totals are unbiased. Scikit-learn's Poisson boosting diverged on this data: one tree's Newton step overshot by several orders of magnitude. |
| Validation | **Leave one year out**: for each overlap year, train on all the other years, rebuild that year from MODIS alone, and compare with what VIIRS actually measured. Scored on 5°×5° region-weeks, region-months and region-years, against a **single global conversion factor** as baseline. |
| Uncertainty | Empirical quantiles of actual ÷ predicted on the held-out years, by magnitude and time scale. The app reports how often the truth fell inside the 80% band. Observed weeks are bracketed by the two VIIRS instruments (S-NPP and NOAA-20). |

Known limits, stated plainly:

- Years before 2003 are left out, because Aqua (the afternoon MODIS overpass) launched in mid-2002.
- Terra's orbit drifted after 2020 and Aqua's after 2022, which changes MODIS overpass times. The held-out years after 2020 show how much this matters.
- A cell's fire regime is assumed stable between 2003–2011 and the overlap years.
- Counts are detections, not burned area or emissions.

## Run it

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
python -m pipeline.download          # ~9.6 GB FIRMS yearly archives (resumable)
python -m pipeline.aggregate         # daily 0.25° aggregates (data/agg)
python -m pipeline.build             # leave-one-year-out validation, final model, products (data/product)
uvicorn api.main:app --port 8010     # app + API at http://127.0.0.1:8010
```

Generated data is not in this repository, so a fresh clone needs the pipeline steps above first. The Severity chapter also needs the GeoData AI service running on port 8000 (`GEODATA_API` overrides the address). On Windows, `start.cmd` starts both apps if GeoData AI is cloned next to this folder as `repo`.

`python -m pipeline.run` does the aggregate and build steps without supervision, picking up each archive as it finishes downloading. Add `?app` to the URL to skip the story.

### API

| Endpoint | Returns |
|---|---|
| `GET /api/calendar?country=Brazil` or `?bbox=w,s,e,n` | Calendar, climatology, season, anomalies, trends, outlook, insights |
| `GET /api/map?year=2010&week_from=30&week_to=32&bbox=…` | Harmonized activity and industrial heat per cell |
| `GET /api/export.csv?…` | Weekly raw MODIS, raw VIIRS (both satellites), reconstruction and harmonized series |
| `GET /api/live?window=24h` | Live fires, strongest fires, busiest countries |
| `GET /api/live/severity`, `/api/outlook` | Live fires scored and graded by the GeoData AI model; 4-week outlook |
| `GET /api/industry` | Industrial heat sites, country ranking, yearly trend |
| `GET /api/meta`, `/api/countries`, `/api/intro` | Validation summary, country list, story data |

## Data

- NASA FIRMS, MODIS Active Fire product (MCD14ML): https://firms.modaps.eosdis.nasa.gov/
- NASA FIRMS, VIIRS 375 m Active Fire product, S-NPP (VNP14IMGML) and NOAA-20 (VJ114IMGML)
- Basemap: Esri World Dark Gray. Coastlines: Natural Earth via world-atlas.

## Use of AI ("SI") tools

Claude (Anthropic) designed and wrote most of the pipeline, the model, the API and the front end, working from the team's direction and the challenge statement. That includes proposing the method (unit of analysis, validation protocol, uncertainty approach). Numbers in the app are computed from NASA data by the code in this repository.
