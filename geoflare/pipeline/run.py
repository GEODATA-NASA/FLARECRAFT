"""Unattended pipeline: aggregate each archive zip as it finishes downloading, then build.

    python -m pipeline.run          # waits for all zips in config.SENSOR_YEARS, then builds
"""

import time
import traceback
import zipfile

from pipeline import aggregate, build
from pipeline.config import ARCHIVE_DIR, DATA_DIR, SENSOR_YEARS


def expected():
    return [(s, y) for s, years in SENSOR_YEARS.items() for y in years]


def main(poll=60):
    while True:
        done = 0
        for sensor, year in expected():
            path = ARCHIVE_DIR / f"{sensor}_{year}_all_countries.zip"
            target = DATA_DIR / "agg" / sensor / f"{year}.parquet"
            if target.exists():
                done += 1
                continue
            if not path.exists():
                continue
            try:
                print(aggregate.aggregate_zip(path, sensor, year), flush=True)
                done += 1
            except zipfile.BadZipFile:
                print(f"corrupt {path.name}: deleting so it can be downloaded again", flush=True)
                path.unlink()
        print(f"{time.strftime('%H:%M')} aggregated {done}/{len(expected())}", flush=True)
        if done == len(expected()):
            break
        time.sleep(poll)
    try:
        build.main("agg", loyo=True)
    except Exception:
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
