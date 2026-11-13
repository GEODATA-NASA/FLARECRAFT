"""Download the NASA FIRMS yearly country archives (MODIS C6.1/6.2, VIIRS S-NPP, VIIRS NOAA-20).

Resumable (HTTP Range) and parallel: the server streams ~0.3 MB/s per connection,
so several files download at once. Already-complete files are skipped.

    python -m pipeline.download            # everything, MODIS first
    python -m pipeline.download modis      # one sensor
"""

import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from pipeline.config import ARCHIVE_DIR, SENSOR_YEARS

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country/zips/{sensor}_{year}_all_countries.zip"
WORKERS = 10


def remote_size(session, url):
    response = session.head(url, timeout=60, allow_redirects=True)
    response.raise_for_status()
    return int(response.headers["content-length"])


def fetch(sensor, year):
    url = BASE.format(sensor=sensor, year=year)
    target = ARCHIVE_DIR / f"{sensor}_{year}_all_countries.zip"
    partial = target.with_suffix(".zip.part")
    session = requests.Session()
    total = remote_size(session, url)
    if target.exists() and target.stat().st_size == total:
        return f"skip  {target.name}"

    for attempt in range(1, 9):
        done = partial.stat().st_size if partial.exists() else 0
        if done == total:  # finished earlier but never renamed (process stopped)
            partial.replace(target)
            return f"done  {target.name} ({total / 1e6:.0f} MB, resumed)"
        if done > total:
            partial.unlink()
            done = 0
        headers = {"Range": f"bytes={done}-"} if done else {}
        try:
            with session.get(url, headers=headers, stream=True, timeout=120) as response:
                response.raise_for_status()
                if done and response.status_code != 206:
                    done = 0  # server ignored the range: start over
                with open(partial, "ab" if done else "wb") as handle:
                    for chunk in response.iter_content(1 << 20):
                        handle.write(chunk)
            if partial.stat().st_size == total:
                partial.replace(target)
                return f"done  {target.name} ({total / 1e6:.0f} MB)"
        except (requests.RequestException, OSError) as error:
            print(f"retry {target.name} #{attempt}: {error}", flush=True)
            time.sleep(min(60, 5 * attempt))
    raise RuntimeError(f"gave up on {target.name}")


def main(sensors):
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    jobs = [(s, y) for s in sensors for y in SENSOR_YEARS[s]]
    started = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(fetch, s, y): (s, y) for s, y in jobs}
        for future in as_completed(futures):
            try:
                print(future.result(), f"[{(time.time() - started) / 60:.0f} min]", flush=True)
            except Exception as error:  # keep the other downloads going
                print("FAILED", futures[future], error, flush=True)


if __name__ == "__main__":
    main(sys.argv[1:] or list(SENSOR_YEARS))
