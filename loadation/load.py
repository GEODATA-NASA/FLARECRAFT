import logging
import os
import sys
from pathlib import Path

import pandas as pd
from sqlalchemy import URL, create_engine, inspect, text

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from config import CLEANED_DATA_DIR, CLEANED_FIRE_FILES, DB_CONFIG

LOGGER = logging.getLogger("geodata.load")


def normalize_fire_chunk(chunk):
    chunk = chunk.copy()

    if "confidence" in chunk.columns:
        chunk["confidence"] = (
            chunk["confidence"].astype(str).str.strip().str.lower().replace({"h": 100, "n": 50, "l": 25})
            .apply(lambda value: pd.to_numeric(value, errors="coerce"))
        )
        chunk["confidence"] = pd.to_numeric(chunk["confidence"], errors="coerce").astype("Int64")

    for column in ["type", "acq_time"]:
        if column in chunk.columns:
            chunk[column] = pd.to_numeric(chunk[column], errors="coerce").astype("Int64")

    return chunk


def get_connection_url():
    """Build the PostgreSQL connection URL from the project's configuration."""
    return URL.create(
        "postgresql+psycopg2",
        username=DB_CONFIG["user"],
        password=DB_CONFIG["password"],
        host=DB_CONFIG["host"],
        port=int(DB_CONFIG["port"]),
        database=DB_CONFIG["dbname"],
    )


def table_contains_rows(connection, table_name):
    """Return whether a table in the active schema exists and contains rows."""
    inspector = inspect(connection)
    if not inspector.has_table(table_name):
        return False

    preparer = connection.dialect.identifier_preparer
    quoted_table = preparer.quote(table_name)
    row_count = connection.execute(
        text(f"SELECT COUNT(*) FROM {quoted_table}")
    ).scalar_one()
    return row_count > 0


def table_row_count(connection, table_name):
    """Row count of a table, or None when it does not exist."""
    if not inspect(connection).has_table(table_name):
        return None
    quoted_table = connection.dialect.identifier_preparer.quote(table_name)
    return connection.execute(text(f"SELECT COUNT(*) FROM {quoted_table}")).scalar_one()


def csv_row_count(path):
    """Data rows in a CSV file (lines minus the header), counted without parsing."""
    lines = 0
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(16 * 1024 * 1024), b""):
            lines += block.count(b"\n")
    return max(lines - 1, 0)


def swap_in_table(engine, staging, target, index_columns=()):
    """Replace ``target`` with the fully loaded ``staging`` table in one transaction.

    Loading into a staging table first means a crash mid-upload never leaves a
    half-filled ``target`` that later runs would mistake for a complete load.
    """
    preparer = engine.dialect.identifier_preparer
    with engine.begin() as connection:
        connection.execute(text(f"DROP TABLE IF EXISTS {preparer.quote(target)}"))
        connection.execute(text(f"ALTER TABLE {preparer.quote(staging)} RENAME TO {preparer.quote(target)}"))
        for column in index_columns:
            index_name = f"ix_{target}_{column}"
            connection.execute(text(
                f"CREATE INDEX IF NOT EXISTS {preparer.quote(index_name)} ON {preparer.quote(target)} ({preparer.quote(column)})"
            ))


def load_data_to_postgres():
    """Upload cleaned datasets.

    Every cleaned yearly fire file (2025, 2026, ...) goes into ``fire_events``. Fires and weather are each
    reloaded whenever the cleaned files' row count differs from the table, so a new year or an extended
    NASA POWER download reaches the database; otherwise the upload is skipped.
    """
    engine = create_engine(get_connection_url(), pool_pre_ping=True)
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
            fire_rows_in_db = table_row_count(connection, "fire_events")
            weather_rows_in_db = table_row_count(connection, "weather_data")

        names = [os.path.basename(path) for path in CLEANED_FIRE_FILES.values()]
        fire_files = [os.path.join(CLEANED_DATA_DIR, name) for name in names if os.path.isfile(os.path.join(CLEANED_DATA_DIR, name))]
        fire_rows_in_files = sum(csv_row_count(path) for path in fire_files)
        if fire_rows_in_db and fire_rows_in_db == fire_rows_in_files:
            LOGGER.info("Table fire_events already holds the %s cleaned fire rows; skipping upload.", f"{fire_rows_in_db:,}")
        elif fire_files:
            if fire_rows_in_db:
                LOGGER.info("fire_events has %s rows but the cleaned files have %s; reloading it.",
                            f"{fire_rows_in_db:,}", f"{fire_rows_in_files:,}")
            LOGGER.info("Uploading cleaned fire data (%s) to fire_events (via a staging table).",
                        ", ".join(os.path.basename(path) for path in fire_files))
            first_chunk = True
            uploaded_rows = 0

            chunks = (chunk for path in fire_files for chunk in pd.read_csv(path, chunksize=50_000, low_memory=False))
            for chunk in chunks:
                chunk = normalize_fire_chunk(chunk)
                chunk.to_sql(
                    "fire_events_staging",
                    engine,
                    if_exists="replace" if first_chunk else "append",
                    index=False,
                )
                first_chunk = False
                uploaded_rows += len(chunk)
                if uploaded_rows % 1_000_000 < 50_000:
                    LOGGER.info("Uploaded %s fire rows so far.", f"{uploaded_rows:,}")

            if first_chunk:
                raise ValueError(f"Cleaned fire files contain no rows: {', '.join(fire_files)}")
            swap_in_table(engine, "fire_events_staging", "fire_events", index_columns=("acq_date",))
            LOGGER.info("Uploaded %s rows to fire_events.", f"{uploaded_rows:,}")
        else:
            raise FileNotFoundError(f"No cleaned fire file ({', '.join(names)}) found in {CLEANED_DATA_DIR}")

        weather_file = os.path.join(CLEANED_DATA_DIR, "cleaned_weather.csv")
        if not os.path.isfile(weather_file):
            raise FileNotFoundError(f"Cleaned weather file not found: {weather_file}")
        weather_rows_in_file = csv_row_count(weather_file)
        if weather_rows_in_db == weather_rows_in_file and weather_rows_in_db:
            LOGGER.info("Table weather_data already holds the %s cleaned weather rows; skipping upload.", f"{weather_rows_in_db:,}")
        else:
            if weather_rows_in_db:
                LOGGER.info(
                    "weather_data has %s rows but the cleaned file has %s; reloading it.",
                    f"{weather_rows_in_db:,}", f"{weather_rows_in_file:,}",
                )
            LOGGER.info("Uploading cleaned weather data to weather_data (via a staging table).")
            uploaded_rows = 0
            first_chunk = True
            for chunk in pd.read_csv(weather_file, chunksize=200_000):
                chunk.to_sql("weather_data_staging", engine, if_exists="replace" if first_chunk else "append", index=False)
                first_chunk = False
                uploaded_rows += len(chunk)
            if first_chunk:
                raise ValueError(f"Cleaned weather file contains no rows: {weather_file}")
            swap_in_table(engine, "weather_data_staging", "weather_data", index_columns=("date",))
            LOGGER.info("Uploaded %s rows to weather_data.", f"{uploaded_rows:,}")

        LOGGER.info("Load stage completed successfully.")
    finally:
        engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    load_data_to_postgres()
