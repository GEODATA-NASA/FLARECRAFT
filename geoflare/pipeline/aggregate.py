"""Aggregate FIRMS yearly zips into daily 0.25 degree cell counts.

One output row = (date, cell, country, type, satellite) with detection counts and FRP.
Output: data/agg/<sensor>/<year>.parquet  (about 20x smaller than the raw CSVs).

    python -m pipeline.aggregate            # every downloaded zip not yet aggregated
"""

import re
import sys
import time
import zipfile

import numpy as np
import pandas as pd

from pipeline.config import ARCHIVE_DIR, DATA_DIR, cell_id

USECOLS = ["latitude", "longitude", "acq_date", "satellite", "confidence", "frp", "daynight", "type"]
NAME = re.compile(r"(?P<sensor>modis|viirs-snpp|viirs-jpss1)_(?P<year>\d{4})_all_countries\.zip$")
COUNTRY = re.compile(r"_\d{4}_(?P<country>.+)\.csv$")
# Normalise satellite labels across products: Terra/Aqua for MODIS, N (S-NPP) / 1 (NOAA-20) for VIIRS.
SATELLITES = {"Terra": "T", "Aqua": "A", "T": "T", "A": "A",
              "N": "N", "SNPP": "N", "1": "1", "N20": "1", "J1": "1", "NOAA-20": "1"}


def high_confidence(conf, sensor):
    """MODIS: confidence >= 30 (nominal+high). VIIRS: nominal or high."""
    if sensor == "modis":
        return pd.to_numeric(conf, errors="coerce").fillna(0).to_numpy() >= 30
    # Archive uses l/n/h letters; some re-exports encode them as 25/50/100.
    text = conf.astype(str).str.lower()
    return (text.str[0].isin(["n", "h"]) | (pd.to_numeric(conf, errors="coerce").fillna(0) >= 50)).to_numpy()


def aggregate_frame(frame, sensor, country):
    frame = frame.dropna(subset=["latitude", "longitude", "acq_date"])
    if frame.empty:
        return None
    lat = frame["latitude"].to_numpy("float64")
    lon = frame["longitude"].to_numpy("float64")
    frp = pd.to_numeric(frame["frp"], errors="coerce").fillna(0).to_numpy("float32")
    out = pd.DataFrame({
        "date": pd.to_datetime(frame["acq_date"]).dt.date.astype("datetime64[s]").to_numpy(),
        "cell": cell_id(lat, lon),
        "type": pd.to_numeric(frame["type"], errors="coerce").fillna(0).astype("int8").to_numpy(),
        "sat": frame["satellite"].astype(str).map(SATELLITES).fillna("?").to_numpy(),
        "n": np.ones(len(frame), "int32"),
        "n_conf": high_confidence(frame["confidence"], sensor).astype("int32"),
        "n_night": (frame["daynight"].astype(str) == "N").to_numpy().astype("int32"),
        "frp_sum": frp,
        "frp_max": frp,
    })
    grouped = out.groupby(["date", "cell", "type", "sat"], sort=False).agg(
        n=("n", "sum"), n_conf=("n_conf", "sum"), n_night=("n_night", "sum"),
        frp_sum=("frp_sum", "sum"), frp_max=("frp_max", "max"),
    ).reset_index()
    grouped["country"] = country
    return grouped


def aggregate_zip(path, sensor, year):
    target = DATA_DIR / "agg" / sensor / f"{year}.parquet"
    if target.exists():
        return f"skip {target}"
    started = time.time()
    parts, rows = [], 0
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            match = COUNTRY.search(name)
            if not match:
                continue
            with archive.open(name) as handle:
                frame = pd.read_csv(handle, usecols=lambda c: c in USECOLS, dtype={"confidence": str, "satellite": str})
            rows += len(frame)
            part = aggregate_frame(frame, sensor, match["country"].replace("_", " "))
            if part is not None:
                parts.append(part)
    result = pd.concat(parts, ignore_index=True)
    for column in ("sat", "country"):
        result[column] = result[column].astype("category")
    result = result.astype({"n": "int32", "n_conf": "int32", "n_night": "int32",
                            "frp_sum": "float32", "frp_max": "float32"})
    target.parent.mkdir(parents=True, exist_ok=True)
    result.to_parquet(target, index=False, compression="zstd")
    return f"{sensor} {year}: {rows:,} detections -> {len(result):,} rows in {time.time() - started:.0f}s"


def main():
    pending = sorted(ARCHIVE_DIR.glob("*_all_countries.zip"))
    for path in pending:
        match = NAME.search(path.name)
        if match:
            print(aggregate_zip(path, match["sensor"], int(match["year"])), flush=True)


if __name__ == "__main__":
    sys.exit(main())
