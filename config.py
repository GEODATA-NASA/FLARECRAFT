import logging
import os

from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

DB_CONFIG = {
    "dbname": os.getenv("DB_NAME", "geodata_db"),
    "user": os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", ""),
    "host": os.getenv("DB_HOST", "localhost"),
    "port": os.getenv("DB_PORT", "5432")
}

# Data directories default to the repository layout but can be pointed
# elsewhere (for example a shared drive) through environment variables.
RAW_DATA_DIR = os.path.abspath(
    os.getenv("RAW_DATA_DIR", os.path.join(PROJECT_ROOT, "raw_data"))
)

CLEANED_DATA_DIR = os.path.abspath(
    os.getenv("CLEANED_DATA_DIR", os.path.join(PROJECT_ROOT, "cleaned_data"))
)

# One cleaned archive per year. For each satellite source, the science-quality "archive" file comes
# first; a near-real-time "nrt" file (no FIRMS `type` column) can continue it for the latest months.
FIRE_ARCHIVES = {
    2025: {
        "modis": ["fire_archive_M-C61_820251.csv"],
        "viirs_j1": ["fire_archive_J1V-C2_820252.csv"],
        "viirs_suomi": ["fire_archive_SV-C2_820253.csv"],
    },
    2026: {  # Suomi NPP had no 2026 data; NOAA-21 (JPSS-2) joined instead
        "modis": ["fire_archive_M-C61_844399.csv", "fire_nrt_M-C61_844399.csv"],
        "viirs_j1": ["fire_archive_J1V-C2_844400.csv", "fire_nrt_J1V-C2_844400.csv"],
        "viirs_j2": ["fire_archive_J2V-C2_844401.csv", "fire_nrt_J2V-C2_844401.csv"],
    },
}
FIRE_ARCHIVES = {
    year: {source: [os.path.join(RAW_DATA_DIR, name) for name in names] for source, names in sources.items()}
    for year, sources in FIRE_ARCHIVES.items()
}
# 2025 keeps its original file name, so existing setups and the database load keep working.
CLEANED_FIRE_FILES = {
    year: os.path.join(CLEANED_DATA_DIR, "cleaned_master_fires.csv" if year == 2025 else f"cleaned_master_fires_{year}.csv")
    for year in FIRE_ARCHIVES
}

WEATHER_FILE = os.path.join(RAW_DATA_DIR, "nasa_power_weather.csv")

os.makedirs(CLEANED_DATA_DIR, exist_ok=True)

LOGS_DIR = os.path.join(PROJECT_ROOT, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(LOGS_DIR, "pipeline.log"), encoding="utf-8"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("GeoDataAI")