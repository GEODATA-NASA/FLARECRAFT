"""Present and future: live NASA FIRMS fires, severity from the GeoData AI model, and a 4-week outlook.

Live data: the public FIRMS active-fire CSVs (VIIRS S-NPP + NOAA-20, last 24 hours), refreshed
every 30 minutes. They carry no hotspot "type", so persistent industrial sources are recognised
from the 23-year archive: a cell that showed static heat sources in many weeks is a factory or flare.
Severity: the GeoData AI CatBoost model (POST /api/v1/predict/batch on the sibling service).
"""

import datetime as dt
import io
import os
import threading
import time

import numpy as np
import pandas as pd
import requests
from sklearn.metrics import roc_auc_score

from pipeline.config import CELL_DEG, LIVE_DIR, N_COLS, cell_id

# One VIIRS satellite at a time: adding two satellites would count the same fire twice. "auto" takes the first feed
# that has data, in this order (NASA stopped filling the Suomi NPP near-real-time files in November 2026).
SATELLITES = {
    "noaa20": ("NOAA-20", "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_{window}.csv"),
    "noaa21": ("NOAA-21", "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_{window}.csv"),
    "snpp": ("Suomi NPP", "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_{window}.csv"),
}
AUTO_ORDER = ["noaa20", "noaa21", "snpp"]
BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/"
GEODATA_API = os.getenv("GEODATA_API", "http://127.0.0.1:8000").rstrip("/")
TTL = 30 * 60
CONFIDENCE = {"l": 25, "n": 50, "h": 100}  # same encoding the GeoData model was trained with


class GeoDataUnavailable(RuntimeError):
    pass


class LiveFeedEmpty(RuntimeError):
    """NASA's file for this satellite and window has no rows right now."""


def confident(d):
    """Nominal and high confidence only: the rule the archive uses."""
    return d[d.confidence.astype(str).str.lower().str[0].isin(["n", "h"])]


class Live:
    def __init__(self, store):
        self.store = store
        self.cache, self.lock, self.gates = {}, threading.Lock(), {}
        self._industrial = None

    # ------------------------------------------------------------ helpers
    def cached(self, key, build, ttl=TTL):
        """Single-flight, stale-while-revalidate cache.

        A fresh value is returned at once. An expired value is still returned at once while one
        background thread rebuilds it, so a slow NASA download never makes a visitor wait.
        Only the very first request for a key waits for the build."""
        with self.lock:
            gate = self.gates.setdefault(key, threading.Lock())
            hit = self.cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        if hit:
            def refresh():
                if gate.acquire(blocking=False):
                    try:
                        self.cache[key] = (time.time(), build())
                    except Exception as error:
                        print(f"[live] refresh of {key} failed: {error}", flush=True)
                    finally:
                        gate.release()
            threading.Thread(target=refresh, daemon=True).start()
            return hit[1]
        with gate:
            hit = self.cache.get(key)
            if hit:
                return hit[1]
            value = build()
            self.cache[key] = (time.time(), value)
            return value

    def industrial_cells(self):
        """Cells with static heat sources in at least 12 weeks of the archive (flares, refineries, plants)."""
        if self._industrial is None:
            frame = self.store.db.sql(f"""
                SELECT cell FROM '{self.store.cellweek}'
                WHERE COALESCE(viirs_ind, modis_ind) > 0
                GROUP BY cell HAVING COUNT(*) >= 12""").df()
            self._industrial = set(frame.cell.astype(int))
        return self._industrial

    def country_of(self, cells):
        names = self.store.cells.country.reindex(list(cells))
        return [c if isinstance(c, str) and c != "?" else None for c in names]

    # ------------------------------------------------------------ live fires
    def detections(self, window="24h", sat="auto"):
        """Live detections from one satellite. sat="auto" uses the first satellite whose feed has data."""
        if sat == "auto":
            last = None
            for key in AUTO_ORDER:
                try:
                    return self.detections(window, key)
                except LiveFeedEmpty as error:
                    last = error
            raise last

        def build():
            disk = LIVE_DIR / f"{window}-{sat}.parquet"
            if disk.exists() and time.time() - disk.stat().st_mtime < (TTL if self.cache.get(f"det-{window}-{sat}") else 3 * 3600):
                frame = pd.read_parquet(disk)
                if len(frame):
                    return frame
            label, pattern = SATELLITES[sat]
            content, error = None, None
            for attempt in range(3):          # NASA's server sometimes drops long downloads; try again before giving up
                try:
                    response = requests.get(BASE + pattern.format(window=window), timeout=(20, 180 if window == "24h" else 900))   # the 7-day file is ~5x larger
                    response.raise_for_status()
                    content = response.content
                    break
                except requests.RequestException as exc:
                    error = exc
                    time.sleep(3 * (attempt + 1))
            if content is None:
                if disk.exists():             # keep showing the last good copy; its "fetched" time says how old it is
                    stale = pd.read_parquet(disk)
                    if len(stale):
                        print(f"[live] {label} {window}: NASA unreachable ({error}); serving copy fetched {stale.fetched.iloc[0]}", flush=True)
                        return stale
                raise error
            frame = pd.read_csv(io.BytesIO(content))
            if frame.empty:
                raise LiveFeedEmpty(f"NASA's {label} feed for the last {window} is empty right now")
            frame["sat"] = sat
            frame["satellite"] = label
            frame["cell"] = cell_id(frame.latitude.to_numpy(), frame.longitude.to_numpy())
            frame["industrial"] = frame.cell.isin(self.industrial_cells())
            frame["fetched"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes")
            LIVE_DIR.mkdir(parents=True, exist_ok=True)
            frame.astype({"confidence": str, "acq_date": str}).to_parquet(disk, index=False)
            return frame
        return self.cached(f"det-{window}-{sat}", build)

    def summary(self, window="24h", sat="auto", conf="nh", daynight="", min_frp=0.0):
        """Live fires with the same switches as the archive map: satellite, confidence, time of day, minimum strength.

        conf="nh" keeps nominal and high confidence only, the same rule the 2025 archive uses; conf="all" adds low."""
        def build():
            d = self.detections(window, sat)
            raw = len(d)
            if conf == "nh":
                d = confident(d)
            if daynight in ("D", "N"):
                d = d[d.daynight == daynight]
            if min_frp:
                d = d[d.frp >= min_frp]
            if d.empty:
                raise LiveFeedEmpty("No live fires match these switches. Loosen a filter.")
            fires, ind = d[~d.industrial], d[d.industrial]
            g = d.groupby("cell").agg(n=("frp", "size"), frp=("frp", "sum"), frp_max=("frp", "max"), industrial=("industrial", "max")).reset_index()
            row, col = np.divmod(g.cell.to_numpy(), N_COLS)
            g["lat"], g["lon"] = -90 + (row + 0.5) * CELL_DEG, -180 + (col + 0.5) * CELL_DEG
            fire_cells = g[~g.industrial].sort_values("n", ascending=False)
            countries = pd.Series(self.country_of(fires.cell), index=fires.index).value_counts().head(8)
            stamp = pd.to_datetime(d.acq_date.astype(str) + d.acq_time.astype(int).astype(str).str.zfill(4), format="%Y-%m-%d%H%M")
            return {
                "window": window, "fetched": d.fetched.iloc[0], "satellite": d.satellite.iloc[0], "sat": d.sat.iloc[0],
                "filters": {"conf": conf, "daynight": daynight, "min_frp": min_frp}, "raw_detections": int(raw), "shown_detections": int(len(d)),
                "newest": stamp.max().strftime("%d %b %Y %H:%M UTC"), "oldest": stamp.min().strftime("%d %b %Y %H:%M UTC"),
                "fires": int(len(fires)), "industrial": int(len(ind)),
                "severe": int((fires.frp >= 10).sum()), "frp_total": float(fires.frp.sum()),
                "countries": [{"country": c, "fires": int(n)} for c, n in countries.items()],
                "cells": g[["lat", "lon", "n", "frp_max", "industrial"]].round(3).values.tolist(),
                "biggest": self.biggest_by_country(fire_cells),
                "globe": self.globe_points(g),
            }
        return self.cached(f"sum-{window}-{sat}-{conf}-{daynight}-{min_frp}", build)

    def biggest_by_country(self, fire_cells, top=8):
        """The fiercest fire square in each country, so one burning region cannot fill the whole list."""
        ranked = fire_cells.sort_values("frp_max", ascending=False).head(400).copy()
        ranked["country"] = self.country_of(ranked.cell)
        ranked["key"] = ranked.country.fillna(ranked.cell.astype(str))
        ranked = ranked.drop_duplicates("key").head(top)
        return [{"lat": round(r.lat, 2), "lon": round(r.lon, 2), "frp": round(float(r.frp_max), 1), "n": int(r.n), "country": r.country}
                for r in ranked.itertuples()]

    @staticmethod
    def globe_points(g, limit=3500):
        """Collapse to 1 degree for the story globe: [lat, lon, detections, industrial]."""
        frame = g.assign(r=np.floor(g.lat).astype(int), c=np.floor(g.lon).astype(int))
        agg = frame.groupby(["r", "c"]).agg(n=("n", "sum"), ind=("industrial", "max")).reset_index().sort_values("n", ascending=False).head(limit)
        return [[r + 0.5, c + 0.5, int(n), bool(i)] for r, c, n, i in agg.itertuples(index=False)]

    # ------------------------------------------------------------ GeoData model
    def predict_rows(self, observations):
        try:
            response = requests.post(f"{GEODATA_API}/api/v1/predict/batch", json={"observations": observations}, timeout=120)
        except requests.RequestException as error:
            raise GeoDataUnavailable(f"GeoData AI is not reachable at {GEODATA_API}") from error
        if response.status_code != 200:
            raise GeoDataUnavailable(f"GeoData AI answered {response.status_code}: {response.text[:200]}")
        return response.json()["predictions"]

    def predict(self, observations):
        return np.array([p["high_frp_probability"] for p in self.predict_rows(observations)])

    @staticmethod
    def observation(r):
        return {"latitude": float(r.latitude), "longitude": float(r.longitude), "acq_date": str(r.acq_date),
                "acq_time": int(r.acq_time), "brightness": float(r.bright_ti4), "scan": float(r.scan), "track": float(r.track),
                "confidence": CONFIDENCE.get(str(r.confidence).lower()[:1], 50), "type": 0}

    def features(self, window="24h", sat="auto", conf="nh", daynight="", min_frp=0.0, bbox=None, limit=5000):
        """Live fires as GeoJSON with severity scores, plus totals, in the shape the classic GeoData map reads."""
        d = self.detections(window, sat)
        d = d[~d.industrial & d.frp.notna()]
        if conf == "nh":
            d = confident(d)
        if daynight in ("D", "N"):
            d = d[d.daynight == daynight]
        if min_frp:
            d = d[d.frp >= min_frp]
        if bbox:
            west, south, east, north = bbox
            d = d[d.latitude.between(south, north) & d.longitude.between(west, east)]
        if d.empty:
            raise LiveFeedEmpty("No live fires match these filters.")
        source = {"noaa20": "viirs_j1", "noaa21": "viirs_j2", "snpp": "viirs_suomi"}[d.sat.iloc[0]]
        shown = d.sample(n=min(int(limit), 5000, len(d)), random_state=0)
        rows = self.predict_rows([self.observation(r) for r in shown.itertuples()])
        features = [{
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [float(r.longitude), float(r.latitude)]},
            "properties": {"acq_date": str(r.acq_date), "acq_time": int(r.acq_time), "frp": float(r.frp), "brightness": float(r.bright_ti4),
                           "confidence": CONFIDENCE.get(str(r.confidence).lower()[:1], 50), "scan": float(r.scan), "track": float(r.track), "type": 0,
                           "daynight": r.daynight, "satellite_source": source, "high_frp_probability": p["high_frp_probability"],
                           "is_high_frp": p["is_high_frp"], "predicted_label": p["predicted_label"], "risk_score": p.get("risk_score"),
                           "risk_level": p.get("risk_level"), "weather_matched": p["weather"]["matched"]},
        } for r, p in zip(shown.itertuples(), rows)]
        by_date = d.assign(severe=d.frp >= 10).groupby(d.acq_date.astype(str)).agg(count=("frp", "size"), high=("severe", "sum"))
        stamp = pd.to_datetime(d.acq_date.astype(str) + d.acq_time.astype(int).astype(str).str.zfill(4), format="%Y-%m-%d%H%M")
        return {
            "satellite": d.satellite.iloc[0], "window": window, "fetched": d.fetched.iloc[0], "newest": stamp.max().strftime("%d %b %Y %H:%M UTC"),
            "geojson": {"type": "FeatureCollection", "features": features,
                        "metadata": {"count": len(features), "truncated": len(features) < len(d), "predicted_high_frp": int(sum(f["properties"]["is_high_frp"] for f in features))}},
            "stats": {"total": int(len(d)), "avg_frp": float(d.frp.mean()), "max_frp": float(d.frp.max()), "high_frp_count": int((d.frp >= 10).sum()),
                      "high_frp_share": float((d.frp >= 10).mean()), "high_frp_threshold_mw": 10.0,
                      "by_source": [{"source": source, "count": int(len(d))}],
                      "by_date": [{"date": day, "count": int(r["count"]), "high_frp_count": int(r.high)} for day, r in by_date.iterrows()]},
        }

    def model_threshold(self):
        """The decision threshold saved with the GeoData model (recall-first), or 0.5 for older models."""
        try:
            return float(requests.get(f"{GEODATA_API}/api/v1/model", timeout=20).json().get("decision_threshold") or 0.5)
        except (requests.RequestException, ValueError, TypeError):
            return 0.5

    def place_time_scale(self):
        """The model is trained with balanced class weights, so its raw chance runs high. For place-and-time-only
        requests the artifact records the mean chance and the true severe share on the hold-out; their ratio turns
        the outlook's expected severe counts honest (about 0.26 / 0.46 for the current model)."""
        try:
            blank = requests.get(f"{GEODATA_API}/api/v1/model", timeout=20).json()["metrics"]["blank_inputs"]
            return min(1.0, blank["observed_high_frp_share"] / blank["place_and_time_only"]["mean_probability"])
        except (requests.RequestException, KeyError, TypeError, ZeroDivisionError):
            return 1.0

    def severity(self, window="24h", sample=4000):
        """Score live fires with the GeoData model, then grade it against the fire power the satellites measured."""
        def build():
            d = self.detections(window)
            fires = confident(d[~d.industrial & d.frp.notna()])
            fires = fires.sample(n=min(sample, len(fires)), random_state=0)
            obs = [self.observation(r) for r in fires.itertuples()]
            p = self.predict(obs)
            actual = (fires.frp.to_numpy() >= 10)
            threshold = self.model_threshold()
            flagged = p >= threshold
            bins = np.clip((p * 5).astype(int), 0, 4)
            calibration = [{"range": f"{i * 20}-{i * 20 + 20}%", "fires": int((bins == i).sum()),
                            "actually_severe": float(actual[bins == i].mean()) if (bins == i).any() else None} for i in range(5)]
            cells = fires.assign(p=p).groupby("cell").agg(p=("p", "mean"), frp=("frp", "max"), n=("p", "size")).reset_index()
            row, col = np.divmod(cells.cell.to_numpy(), N_COLS)
            cells["lat"], cells["lon"] = -90 + (row + 0.5) * CELL_DEG, -180 + (col + 0.5) * CELL_DEG
            top = fires.assign(p=p).sort_values("p", ascending=False).head(6)
            return {
                "window": window, "scored": int(len(fires)),
                "auc": float(roc_auc_score(actual, p)) if 0 < actual.sum() < len(actual) else None,
                "flagged": int(flagged.sum()), "flagged_right": float(actual[flagged].mean()) if flagged.any() else None,
                "severe_caught": float(flagged[actual].mean()) if actual.any() else None,
                "severe_share": float(actual.mean()), "calibration": calibration, "threshold": threshold,
                "points": [[*row, c] for row, c in zip(cells[["lat", "lon", "p", "frp", "n"]].round(3).values.tolist(), self.country_of(cells.cell))],
                "watchlist": [{"lat": round(r.latitude, 2), "lon": round(r.longitude, 2), "p": round(float(r.p), 2),
                               "frp": round(float(r.frp), 1), "country": self.country_of([r.cell])[0]} for r in top.itertuples()],
            }
        return self.cached(f"sev-{window}", build)

    def outlook(self, weeks=4, top=2500):
        """Next weeks: where fires usually burn (23-year calendar) x how likely each is to be severe (GeoData model)."""
        today = dt.date.today()
        week_now = min((today.timetuple().tm_yday - 1) // 7, 51)
        span = [(week_now + i) % 52 for i in range(weeks)]

        def build():
            s = self.store
            years = s.db.execute(f"SELECT COUNT(DISTINCT year) FROM '{s.cellweek}' WHERE year >= 2003").fetchall()[0][0] or 1
            frame = s.db.sql(f"""
                SELECT cell, SUM(CASE WHEN year >= {s.viirs_start} THEN viirs ELSE recon END)::DOUBLE / {years} AS usual
                FROM '{s.cellweek}' WHERE year >= 2003 AND week IN ({",".join(map(str, span))})
                GROUP BY cell HAVING usual >= 1 ORDER BY usual DESC LIMIT {int(top)}""").df()
            frame = frame[~frame.cell.isin(self.industrial_cells())]
            row, col = np.divmod(frame.cell.to_numpy(), N_COLS)
            frame["lat"], frame["lon"] = -90 + (row + 0.5) * CELL_DEG, -180 + (col + 0.5) * CELL_DEG
            # Same calendar day in 2025, the model's training year, so last year's weather can be matched.
            day = dt.date(2025, 1, 1) + dt.timedelta(days=span[len(span) // 2] * 7 + 3)
            obs = [{"latitude": float(r.lat), "longitude": float(r.lon), "acq_date": day.isoformat(), "acq_time": 1330, "type": 0}
                   for r in frame.itertuples()]
            frame["p"] = self.predict(obs)                          # raw chance: ranks and colours places
            frame["severe"] = frame.usual * frame.p * self.place_time_scale()   # honest expected count
            frame["country"] = self.country_of(frame.cell)
            by_country = frame.groupby("country").agg(usual=("usual", "sum"), severe=("severe", "sum")).sort_values("severe", ascending=False).head(8)
            label = lambda w: (dt.date(2001, 1, 1) + dt.timedelta(days=w * 7)).strftime("%d %b")
            return {
                "weeks": span, "label": f"{label(span[0])} - {label((span[-1] + 1) % 52)}",
                "usual_total": float(frame.usual.sum()), "severe_total": float(frame.severe.sum()),
                "points": frame[["lat", "lon", "usual", "p"]].round(3).values.tolist(),
                "countries": [{"country": c, "usual": round(float(r.usual)), "severe": round(float(r.severe))} for c, r in by_country.iterrows()],
            }
        return self.cached(f"outlook-{week_now}-{weeks}", build, ttl=6 * 3600)

    def warm(self, every=25 * 60):
        """Keep live data, severity and the outlook fresh in the background so the story never waits."""
        while True:
            for job in (lambda: self.summary("24h"), lambda: self.severity("24h"), self.outlook, self.industry, lambda: self.summary("7d")):
                try:
                    job()
                except Exception as error:  # an outage must not kill the warmer
                    print(f"[live] prefetch failed: {error}", flush=True)
            time.sleep(every)

    # ------------------------------------------------------------ industry
    def industry(self):
        def build():
            s = self.store
            col = "viirs_ind"
            years = s.db.sql(f"SELECT year, SUM({col})::DOUBLE AS n FROM '{s.cellweek}' WHERE {col} IS NOT NULL GROUP BY year ORDER BY year").df()
            per = s.db.sql(f"""SELECT c.country, w.year, SUM(w.{col})::DOUBLE AS n FROM '{s.cellweek}' w JOIN cells_df c USING (cell)
                               WHERE w.{col} IS NOT NULL GROUP BY ALL""").df()
            last = int(years.year.max())
            ranking = per[(per.year == last) & (per.country != "?")].sort_values("n", ascending=False).head(12)
            series = {c: per[per.country == c].sort_values("year")[["year", "n"]].values.tolist() for c in ranking.country}
            return {"year": last, "global": years.values.tolist(), "ranking": ranking[["country", "n"]].values.tolist(),
                    "series": series, "sites": s.industrial_sites(last, limit=1500),
                    # every cell with industrial heat that year; "sites" holds only the brightest 1,500 for the map
                    "site_count": int(s.db.execute(f"SELECT COUNT(*) FROM (SELECT cell FROM '{s.cellweek}' WHERE year = {last} AND {col} > 0 GROUP BY cell)").fetchall()[0][0])}
        return self.cached("industry", build, ttl=24 * 3600)
