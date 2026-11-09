"""Dev-only: aggregate the GeoData project's cleaned 2025 file into the archive schema.

Lets the harmonization code run before the FIRMS yearly archives finish downloading.
Output: data/agg-dev/<sensor>/2025.parquet (country unknown -> "?").
"""

import sys

import pandas as pd

from pipeline.aggregate import aggregate_frame
from pipeline.config import CLEANED_FIRES_FILE, aggregate_file

SOURCE = CLEANED_FIRES_FILE
SENSORS = {"modis": "modis", "viirs_suomi": "viirs-snpp", "viirs_j1": "viirs-jpss1"}


def main(path=SOURCE):
    parts = {sensor: [] for sensor in SENSORS.values()}
    columns = ["latitude", "longitude", "acq_date", "satellite", "confidence", "frp", "daynight", "type", "satellite_source"]
    for i, chunk in enumerate(pd.read_csv(path, usecols=columns, chunksize=2_000_000,
                                          dtype={"confidence": str, "satellite": str})):
        for source, sensor in SENSORS.items():
            subset = chunk[chunk["satellite_source"] == source]
            if len(subset):
                parts[sensor].append(aggregate_frame(subset, sensor.split("-")[0], "?"))
        print("chunk", i, flush=True)
    for sensor, frames in parts.items():
        frame = pd.concat(frames, ignore_index=True)
        frame = frame.groupby(["date", "cell", "type", "sat", "country"], observed=True, sort=False).agg(
            n=("n", "sum"), n_conf=("n_conf", "sum"), n_night=("n_night", "sum"),
            frp_sum=("frp_sum", "sum"), frp_max=("frp_max", "max")).reset_index()
        target = aggregate_file(sensor, 2025, source="agg-dev")
        target.parent.mkdir(parents=True, exist_ok=True)
        frame.to_parquet(target, index=False, compression="zstd")
        print(sensor, len(frame), flush=True)


if __name__ == "__main__":
    sys.exit(main())
