"""Cell x week tables per sensor, built with DuckDB from the daily aggregates.

Week index: w = min((day_of_year - 1) // 7, 51), so every year has 52 weeks and the
last one absorbs day 365/366. t = year * 52 + w is a continuous week counter.

Columns per sensor (vegetation fires = FIRMS type 0, confidence-filtered):
  veg      detections            frp      summed fire radiative power (MW)
  frp_max  strongest pixel       night    night-time detections
  ind      industrial/offshore static sources (type 2, 3), all confidence
  volc     volcano detections (type 1)
MODIS adds veg_t / veg_a (Terra / Aqua split), because the two overpass at different times.
"""

import duckdb

from pipeline.config import aggregate_sensor_dir, weekly_cache_file

WEEK = "LEAST(CAST((dayofyear(date) - 1) // 7 AS INTEGER), 51)"


def weekly(sensor, years=None, source="agg", by_country=False):
    """Return a pandas frame of (year, week, cell[, country]) rows for one sensor."""
    path = aggregate_sensor_dir(sensor, source) / "*.parquet"
    keys = "country, year, week" if by_country else "year, week, cell"
    where = f"WHERE year(date) BETWEEN {years[0]} AND {years[1]}" if years else ""
    modis_split = (
        ", SUM(n_conf) FILTER (WHERE type = 0 AND sat = 'T')::INTEGER AS veg_t"
        ", SUM(n_conf) FILTER (WHERE type = 0 AND sat = 'A')::INTEGER AS veg_a"
        if sensor == "modis" else ""
    )
    query = f"""
        SELECT {'country' if by_country else 'cell'}, year(date)::SMALLINT AS year, {WEEK}::SMALLINT AS week,
               COALESCE(SUM(n_conf) FILTER (WHERE type = 0), 0)::INTEGER AS veg,
               COALESCE(SUM(frp_sum) FILTER (WHERE type = 0), 0)::FLOAT AS frp,
               COALESCE(MAX(frp_max) FILTER (WHERE type = 0), 0)::FLOAT AS frp_max,
               COALESCE(SUM(n_night) FILTER (WHERE type = 0), 0)::INTEGER AS night,
               COALESCE(SUM(n) FILTER (WHERE type IN (2, 3)), 0)::INTEGER AS ind,
               COALESCE(SUM(n) FILTER (WHERE type = 1), 0)::INTEGER AS volc
               {modis_split}
        FROM read_parquet('{path.as_posix()}')
        {where}
        GROUP BY ALL
        ORDER BY {keys}
    """
    frame = duckdb.sql(query).df()
    if sensor == "modis":
        frame[["veg_t", "veg_a"]] = frame[["veg_t", "veg_a"]].fillna(0).astype("int32")
    return frame


def weekly_cached(sensor, source="agg"):
    """All years for one sensor, cached as data/weekly/<source>/<sensor>.parquet."""
    import pandas as pd

    cache = weekly_cache_file(sensor, source)
    inputs = list(aggregate_sensor_dir(sensor, source).glob("*.parquet"))
    if cache.exists() and all(p.stat().st_mtime < cache.stat().st_mtime for p in inputs):
        return pd.read_parquet(cache)
    frame = weekly(sensor, source=source)
    cache.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(cache, index=False, compression="zstd")
    return frame
