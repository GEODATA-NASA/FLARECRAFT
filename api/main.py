"""Ember Almanac API: harmonized MODIS + VIIRS burning-activity calendar."""

import io
import os
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
import requests
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from api.analytics import analyse
from api.live import GeoDataUnavailable, Live
from api.store import Store
from pipeline.config import DATA_DIR, ROOT

PRODUCT = Path(os.getenv("EMBER_PRODUCT", DATA_DIR / "product"))
WEB = ROOT / "web"

app = FastAPI(title="Ember Almanac", version="1.0",
              description="A harmonized MODIS + VIIRS burning-activity calendar for any area on Earth.")
app.add_middleware(GZipMiddleware, minimum_size=1000)
store = Store(PRODUCT)


def parse_bbox(bbox):
    if not bbox:
        return None
    try:
        west, south, east, north = (float(x) for x in bbox.split(","))
    except ValueError:
        raise HTTPException(422, "bbox must be west,south,east,north")
    if not (-90 <= south < north <= 90 and -180 <= west <= 180 and -180 <= east <= 180):
        raise HTTPException(422, "bbox out of range")
    return (round(west, 2), round(south, 2), round(east, 2), round(north, 2))


def area(bbox, country):
    if country and country not in store.countries:
        raise HTTPException(404, f"unknown country: {country}")
    return parse_bbox(bbox), country


@app.get("/api/meta")
def meta():
    r = store.report
    return {
        "first_year": store.first_year, "last_year": store.last_year, "viirs_start": store.viirs_start,
        "global_ratio": r.get("global_ratio"), "overlap_years": r.get("overlap_years"),
        "band_coverage": r.get("band_coverage"), "countries": len(store.countries),
        "validation": summarize_validation(r),
    }


def summarize_validation(report):
    loyo = report.get("loyo") or {}
    rows = []
    for year, m in sorted(loyo.items()):
        rows.append({"year": int(year),
                     "model_month_mdape": m["pred_model"]["month"]["median_abs_pct_err"],
                     "global_month_mdape": m["pred_global"]["month"]["median_abs_pct_err"],
                     "model_year_r2": m["pred_model"]["year"]["r2_log"],
                     "global_year_r2": m["pred_global"]["year"]["r2_log"]})
    return rows


@app.get("/api/countries")
def countries():
    return store.countries


@app.get("/api/calendar")
def calendar(bbox: str | None = Query(None, description="west,south,east,north"), country: str | None = None):
    box, name = area(bbox, country)
    frame, bg, n_cells = store.weekly(box, name)
    if n_cells == 0:
        raise HTTPException(404, "no fire activity recorded in this area")
    result = analyse(frame, store.report, store.viirs_start)
    result["area"] = {"bbox": box, "country": name, "cells": n_cells, "background_per_week": bg}
    return result


@app.get("/api/map")
def map_layer(year: int, week_from: int = 0, week_to: int = 51, bbox: str | None = None):
    if not (store.first_year <= year <= store.last_year):
        raise HTTPException(422, "year out of range")
    frame = store.cell_values(year, max(0, week_from), min(51, week_to), parse_bbox(bbox))
    return {"year": year, "observed": year >= store.viirs_start,
            "points": frame[["lat", "lon", "value", "ind"]].round(3).values.tolist()}


@app.get("/api/export.csv")
def export(bbox: str | None = None, country: str | None = None):
    box, name = area(bbox, country)
    frame, _, _ = store.weekly(box, name)
    frame = frame.assign(harmonized=frame.viirs.where(frame.year >= store.viirs_start, frame.recon),
                         source=(frame.year >= store.viirs_start).map({True: "observed VIIRS S-NPP", False: "reconstructed from MODIS"}))
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False, float_format="%.2f")
    label = (name or "bbox").replace(" ", "_")
    return StreamingResponse(iter([buffer.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="ember_almanac_{label}.csv"'})


@app.get("/api/intro")
def intro():
    """Everything the opening story needs, computed once: a year of weekly fire frames on a 1 degree
    grid, the global raw-vs-harmonized record, and the brightest industrial heat sources."""
    if store.intro_cache is None:
        frame, _, _ = store.weekly()
        record = analyse(frame, store.report, store.viirs_start)
        year = max(record["climatology_years"] or [store.last_year])
        store.intro_cache = {
            "year": year,
            "frames": store.intro_frames(year),
            "industrial": store.industrial_sites(year),
            "annual": {"years": record["years"], **{k: record["annual"][k] for k in ("naive", "harmonized", "lo", "hi", "modis", "viirs")}},
            "jump": record["jump"], "trends": record["trends"],
            "calendar": {"years": record["years"], "values": record["calendar"]["values"], "observed": record["calendar"]["observed"]},
            "global_ratio": store.report.get("global_ratio"),
            "validation": summarize_validation(store.report),
            "viirs_start": store.viirs_start,
        }
    return store.intro_cache


live = Live(store)
if os.getenv("EMBER_PREFETCH", "1") == "1":
    threading.Thread(target=live.warm, name="live-warmer", daemon=True).start()


def guarded(build):
    """Run a live/model call, turning upstream outages into clear 503s for the UI."""
    try:
        return build()
    except GeoDataUnavailable as error:
        raise HTTPException(503, f"The GeoData AI severity model is offline: {error}")
    except requests.RequestException as error:
        raise HTTPException(503, f"NASA's live fire feed could not be reached: {error}")


@app.get("/api/live")
def live_fires(window: str = Query("24h", pattern="^(24h|7d)$")):
    """Fires detected by VIIRS in the last 24 hours (or 7 days), with factories and flares recognised from the archive."""
    return guarded(lambda: live.summary(window))


@app.get("/api/live/severity")
def live_severity(window: str = Query("24h", pattern="^(24h|7d)$")):
    """Today's fires scored by the GeoData AI model, graded against the fire power the satellites measured."""
    return guarded(lambda: live.severity(window))


@app.get("/api/outlook")
def outlook():
    """The next four weeks: usual activity from the calendar x severity probability from the GeoData model."""
    return guarded(live.outlook)


@app.get("/api/industry")
def industry():
    """Gas flares, refineries and other persistent industrial heat sources seen by VIIRS."""
    return live.industry()


@app.get("/health")
def health():
    return {"status": "ok", "years": [store.first_year, store.last_year]}


if WEB.exists():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
