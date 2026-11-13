"""Shared paths and constants for the Ember Almanac pipeline."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_DIR = Path(os.getenv("FIRMS_ARCHIVE_DIR", ROOT.parent / "firms_archive" / "zips"))
DATA_DIR = Path(os.getenv("EMBER_DATA_DIR", ROOT / "data"))
PROJECT_ROOT = ROOT.parent
CLEANED_DATA_DIR = Path(os.getenv("CLEANED_DATA_DIR", PROJECT_ROOT / "cleaned_data"))

AGG_DIR = DATA_DIR / "agg"
WEEKLY_DIR = DATA_DIR / "weekly"
PRODUCT_DIR = DATA_DIR / "product"
REFERENCE_DIR = DATA_DIR / "ref"
MODEL_DIR = DATA_DIR / "models"
LIVE_DIR = DATA_DIR / "live"
WEB_DIR = ROOT / "web"
CLEANED_FIRES_FILE = CLEANED_DATA_DIR / "cleaned_master_fires.csv"
GEONAMES_FILE = REFERENCE_DIR / "countryInfo.txt"


def archive_file(sensor, year):
    return ARCHIVE_DIR / f"{sensor}_{year}_all_countries.zip"


def aggregate_dir(source="agg"):
    return AGG_DIR if source == "agg" else DATA_DIR / source


def aggregate_sensor_dir(sensor, source="agg"):
    return aggregate_dir(source) / sensor


def aggregate_file(sensor, year, source="agg"):
    return aggregate_sensor_dir(sensor, source) / f"{year}.parquet"


def weekly_cache_file(sensor, source="agg"):
    return WEEKLY_DIR / source / f"{sensor}.parquet"


def product_dir(source="agg"):
    return PRODUCT_DIR if source == "agg" else DATA_DIR / f"product-{source}"

# Years published in the FIRMS yearly country archive.
# MODIS starts Nov 2000 (Terra); VIIRS S-NPP Jan 2012; VIIRS NOAA-20 (JPSS-1) 2018.
SENSOR_YEARS = {
    "modis": range(2000, 2026),
    "viirs-snpp": range(2012, 2026),
    "viirs-jpss1": range(2018, 2026),
}

# Analysis grid: 0.25 degree cells (~28 km at the equator), 1440 x 720.
CELL_DEG = 0.25
N_COLS = int(360 / CELL_DEG)
N_ROWS = int(180 / CELL_DEG)

# FIRMS "type": 0 vegetation fire, 1 active volcano, 2 other static land source, 3 offshore.
TYPE_VEGETATION, TYPE_VOLCANO, TYPE_STATIC, TYPE_OFFSHORE = 0, 1, 2, 3


def cell_id(lat, lon):
    """Row-major 0.25 degree cell index (works on numpy arrays)."""
    import numpy as np

    row = np.clip(((lat + 90.0) / CELL_DEG).astype("int32"), 0, N_ROWS - 1)
    col = np.clip(((lon + 180.0) / CELL_DEG).astype("int32"), 0, N_COLS - 1)
    return row * N_COLS + col


def cell_center(cell):
    row, col = divmod(cell, N_COLS)
    return -90.0 + (row + 0.5) * CELL_DEG, -180.0 + (col + 0.5) * CELL_DEG
