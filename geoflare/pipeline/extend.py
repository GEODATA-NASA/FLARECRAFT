"""Add the latest, still-running year to the published record without retraining.

    python -m pipeline.extend [year]        # default: the newest GeoData cleaned file, cleaned_master_fires_<year>.csv

The FIRMS yearly archive only exists for finished years, and Suomi NPP (the record's VIIRS unit) delivered no 2026
data. So for such a year:
1. daily MODIS and VIIRS NOAA-20 aggregates come from GeoData's cleaned file (the archive months plus the
   near-real-time months, whose FIRMS type was labelled from static-source spots) -> data/agg/<sensor>/<year>.parquet;
2. the record's VIIRS columns are NOAA-20 times its ratio to Suomi NPP in the years both flew (2019-2025, about 1.0);
3. the MODIS-only reconstruction comes from the published final model, as for every other year;
4. only complete weeks are kept, and report.json["partial"] marks the year, so climatology, trends and the 2012 jump
   keep using complete years.
The validated harmonization model and its numbers (leave-one-year-out MdAPE etc.) are unchanged.
"""

import json
import os
import sys

import duckdb
import joblib
import numpy as np
import pandas as pd

from pipeline.config import CELL_DEG, CLEANED_DATA_DIR, N_COLS, N_ROWS, PRODUCT_DIR, aggregate_file, cell_center
from pipeline.weekly import weekly

RATIO_YEARS = (2019, 2025)   # full years with both Suomi NPP and NOAA-20 (NOAA-20 started mid-2018)
COLS = ["modis", "modis_frp", "modis_ind", "modis_volc", "viirs", "viirs_frp", "viirs_ind", "viirs_j1", "recon"]


def latest_cleaned_year():
    years = [int(p.stem.rsplit("_", 1)[1]) for p in CLEANED_DATA_DIR.glob("cleaned_master_fires_*.csv") if p.stem.rsplit("_", 1)[1].isdigit()]
    return max(years) if years else None


def aggregate_cleaned(year, cells):
    """Daily 0.25 degree aggregates for MODIS and NOAA-20 from the cleaned yearly file, in the aggregate.py format."""
    source = (CLEANED_DATA_DIR / f"cleaned_master_fires_{year}.csv").as_posix()
    con = duckdb.connect()
    con.register("cell_country", cells[["cell", "country"]])
    for sensor, src, high in (("modis", "modis", "confidence >= 30"), ("viirs-jpss1", "viirs_j1", "confidence >= 50")):
        frame = con.sql(f"""
            WITH f AS (
                SELECT CAST(acq_date AS DATE) AS date,
                       (LEAST(GREATEST(CAST(floor((latitude + 90) / {CELL_DEG}) AS INTEGER), 0), {N_ROWS - 1}) * {N_COLS}
                        + LEAST(GREATEST(CAST(floor((longitude + 180) / {CELL_DEG}) AS INTEGER), 0), {N_COLS - 1}))::INTEGER AS cell,
                       COALESCE(type, 0)::TINYINT AS type,
                       CASE satellite WHEN 'Terra' THEN 'T' WHEN 'Aqua' THEN 'A' WHEN 'N20' THEN '1' ELSE '?' END AS sat,
                       ({high})::INTEGER AS conf, (daynight = 'N')::INTEGER AS night, COALESCE(frp, 0)::FLOAT AS frp
                FROM read_csv('{source}', header = true, columns = {{'latitude': 'DOUBLE', 'longitude': 'DOUBLE', 'brightness': 'DOUBLE',
                     'scan': 'DOUBLE', 'track': 'DOUBLE', 'acq_date': 'DATE', 'acq_time': 'INTEGER', 'satellite': 'VARCHAR',
                     'instrument': 'VARCHAR', 'confidence': 'INTEGER', 'version': 'VARCHAR', 'bright_t31': 'DOUBLE', 'frp': 'DOUBLE',
                     'daynight': 'VARCHAR', 'type': 'INTEGER', 'satellite_source': 'VARCHAR'}})
                WHERE satellite_source = '{src}' AND year(acq_date) = {int(year)})
            SELECT f.date, f.cell, f.type, f.sat, COUNT(*)::INTEGER AS n, SUM(conf)::INTEGER AS n_conf, SUM(night)::INTEGER AS n_night,
                   SUM(frp)::FLOAT AS frp_sum, MAX(frp)::FLOAT AS frp_max, COALESCE(c.country, '?') AS country
            FROM f LEFT JOIN cell_country c USING (cell) GROUP BY ALL""").df()
        frame["date"] = pd.to_datetime(frame["date"]).astype("datetime64[ms]")
        frame = frame.astype({"cell": "int32", "type": "int8", "n": "int32", "n_conf": "int32", "n_night": "int32",
                              "frp_sum": "float32", "frp_max": "float32", "sat": "category", "country": "category"})
        target = aggregate_file(sensor, year)
        target.parent.mkdir(parents=True, exist_ok=True)
        frame.to_parquet(target, index=False, compression="zstd")
        print(f"{sensor} {year}: {int(frame.n.sum()):,} detections -> {target}", flush=True)
    return con.sql(f"SELECT MAX(acq_date) FROM read_csv('{source}', header = true)").fetchall()[0][0]


def last_complete_week(last_day):
    """Week w covers days 7w+1 .. 7w+7 of the year; it is complete when its last day has data."""
    doy = pd.Timestamp(last_day).day_of_year
    return min(doy // 7 - 1, 51)


def noaa20_ratios(product):
    """Suomi NPP / NOAA-20 for vegetation fires, FRP and industrial heat, pooled over RATIO_YEARS (weekly caches)."""
    from pipeline.config import weekly_cache_file
    lo, hi = RATIO_YEARS
    s = pd.read_parquet(weekly_cache_file("viirs-snpp"), columns=["year", "veg", "frp", "ind"])
    j = pd.read_parquet(weekly_cache_file("viirs-jpss1"), columns=["year", "veg", "frp", "ind"])
    s, j = s[s.year.between(lo, hi)].sum(), j[j.year.between(lo, hi)].sum()
    return {"veg": float(s.veg / j.veg), "frp": float(s.frp / j.frp), "ind": float(s.ind / j.ind)}


def main(year=None):
    year = int(year or latest_cleaned_year() or 0)
    if not year:
        raise SystemExit(f"No cleaned yearly file (cleaned_master_fires_<year>.csv) in {CLEANED_DATA_DIR}")
    cells = pd.read_parquet(PRODUCT_DIR / "cells.parquet")
    report = json.loads((PRODUCT_DIR / "report.json").read_text())
    last_day = aggregate_cleaned(year, cells)
    last_week = last_complete_week(last_day)
    through = (pd.Timestamp(year, 1, 1) + pd.Timedelta(days=7 * last_week + 6)).date()

    m = weekly("modis", years=(year, year))
    j = weekly("viirs-jpss1", years=(year, year))
    m, j = m[m.week <= last_week], j[j.week <= last_week]
    ratios = noaa20_ratios(PRODUCT_DIR)

    from pipeline.build import predict_years
    final = joblib.load(PRODUCT_DIR / "final_model.joblib")
    recon = predict_years(final["model"], final["static"], m, [year])
    recon["year"], recon["week"] = (recon.t // 52).astype("int16"), (recon.t % 52).astype("int16")
    recon = recon[recon.week <= last_week]

    key = ["cell", "year", "week"]
    rows = m[key + ["veg", "frp", "ind", "volc"]].rename(columns={"veg": "modis", "frp": "modis_frp", "ind": "modis_ind", "volc": "modis_volc"})
    jj = j[key + ["veg", "frp", "ind"]].assign(viirs=lambda d: d.veg * ratios["veg"], viirs_frp=lambda d: d.frp * ratios["frp"],
                                               viirs_ind=lambda d: d.ind * ratios["ind"]).rename(columns={"veg": "viirs_j1"})
    rows = rows.merge(jj[key + ["viirs", "viirs_frp", "viirs_ind", "viirs_j1"]], on=key, how="outer")
    rows = rows.merge(recon[key + ["recon"]], on=key, how="outer")
    rows[COLS] = rows[COLS].fillna(0).astype("float32")   # missing means zero inside the covered weeks
    rows = rows.astype({"cell": "int32", "year": "int16", "week": "int16"})[key + COLS]

    cellweek = (PRODUCT_DIR / "cellweek.parquet").as_posix()
    tmp = PRODUCT_DIR / "cellweek.parquet.tmp"
    con = duckdb.connect()
    con.register("new_rows", rows)
    con.execute(f"""COPY (SELECT * FROM (SELECT {', '.join(key + COLS)} FROM '{cellweek}' WHERE year <> {year}
                                       UNION ALL SELECT * FROM new_rows) ORDER BY cell, year, week)
                    TO '{tmp.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 200000)""")
    new_cells = pd.DataFrame({"cell": np.setdiff1d(rows.cell.unique(), cells.cell.to_numpy())}).astype({"cell": "int32"})
    if len(new_cells):
        new_cells["lat"], new_cells["lon"] = cell_center(new_cells.cell.to_numpy())
        new_cells["country"], new_cells["s_bg"] = "?", np.float32(0)
        pd.concat([cells, new_cells], ignore_index=True).to_parquet(PRODUCT_DIR / "cells.parquet", index=False)
    os.replace(tmp, PRODUCT_DIR / "cellweek.parquet")

    report["partial"] = {"year": year, "last_week": int(last_week), "through": through.isoformat(), "data_until": str(last_day),
                         "viirs_from": "VIIRS NOAA-20 x its Suomi NPP ratio", "ratio_years": list(RATIO_YEARS), "ratios": ratios}
    (PRODUCT_DIR / "report.json").write_text(json.dumps(report, indent=2, default=float))
    assert rows.week.max() <= last_week and (rows[COLS] >= 0).all().all()
    print(f"{year}: {len(rows):,} cell-weeks for weeks 0-{last_week} (through {through}); NOAA-20 -> Suomi NPP ratios "
          + ", ".join(f"{k} {v:.3f}" for k, v in ratios.items()) + f"; {len(new_cells)} new cells", flush=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
