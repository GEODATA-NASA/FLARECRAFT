import os
import sys
from pathlib import Path
import tempfile

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from config import CLEANED_DATA_DIR, CLEANED_FIRE_FILES, FIRE_ARCHIVES, WEATHER_FILE
from utils.quality_checks import validate_fire_data

FIRE_CHUNK_SIZE = 100_000


# تعريف المخطط الموحد (Canonical Schema) لأعمدة الحرائق لضمان الترتيب والثبات
# The FIRMS archive names (MODIS and VIIRS downloads both use brightness / bright_t31), the same layout as
# the cleaned 2025 file, the tests, the API and the model.
CANONICAL_FIRE_COLUMNS = [
    "latitude", "longitude", "brightness", "scan", "track", "acq_date",
    "acq_time", "satellite", "instrument", "confidence", "version", "bright_t31", "frp",
    "daynight", "type", "satellite_source"
]

# Near-real-time files have no FIRMS `type`. A detection gets the static-source type (1 volcano, 2 other
# static land source, 3 offshore) of its ~2 km cell when that year's archive shows a static source there on
# at least 3 days, otherwise 0 (vegetation fire). Back-test on 2026 (cells from Jan-May, scored on Jun-Jul):
# 92% of static detections labelled, 0.6% of fires wrongly labelled static.
STATIC_CELL_DEG = 0.02
STATIC_MIN_DAYS = 3


def _flag_path(file_path):
    """.fire_validated.flag for the 2025 file (its original name), .fire_validated_<year>.flag for later years."""
    return Path(CLEANED_DATA_DIR) / ("." + Path(file_path).stem.replace("cleaned_master_fires", "fire_validated") + ".flag")


def _static_cells(paths):
    """Series {(row, col): type} for the cells where the typed archive files show a static source on enough days."""
    frames = []
    for path in paths:
        if not os.path.exists(path) or "type" not in pd.read_csv(path, nrows=0).columns:
            continue
        for chunk in pd.read_csv(path, usecols=["latitude", "longitude", "acq_date", "type"], chunksize=1_000_000):
            chunk = chunk[pd.to_numeric(chunk["type"], errors="coerce").isin([1, 2, 3])]
            frames.append(pd.DataFrame({
                "r": (chunk["latitude"] // STATIC_CELL_DEG).astype("int64"),
                "c": (chunk["longitude"] // STATIC_CELL_DEG).astype("int64"),
                "d": chunk["acq_date"].astype(str), "t": chunk["type"].astype(int),
            }).drop_duplicates())
    if not frames:
        return pd.Series(dtype="int64")
    data = pd.concat(frames, ignore_index=True).drop_duplicates()
    days = data.drop_duplicates(["r", "c", "d"]).groupby(["r", "c"]).size()
    best = (data.groupby(["r", "c", "t"]).size().rename("n").reset_index()
            .sort_values("n").drop_duplicates(["r", "c"], keep="last").set_index(["r", "c"])["t"])
    return best[days.reindex(best.index).to_numpy() >= STATIC_MIN_DAYS]


def _infer_type(df, static_cells):
    keys = pd.MultiIndex.from_arrays([(df["latitude"] // STATIC_CELL_DEG).astype("int64"),
                                      (df["longitude"] // STATIC_CELL_DEG).astype("int64")])
    return pd.Series(static_cells.reindex(keys).fillna(0).astype(int).to_numpy(), index=df.index).astype("Int64")

def _ensure_canonical_schema(df):
    """إعادة ترتيب الأعمدة وضمان وجود المخطط الموحد (Canonical Schema)"""
    df = df.copy()
    # التأكد من وجود الأعمدة الأساسية، وإضافة الناقصة منها بقيم فارغة لتفادي انهيار الدمج
    for col in CANONICAL_FIRE_COLUMNS:
        if col not in df.columns:
            df[col] = None
    # الاحتفاظ بالترتيب الموحد للأعمدة وأي أعمدة إضافية أخرى إن وجدت
    other_cols = [c for c in df.columns if c not in CANONICAL_FIRE_COLUMNS]
    return df[CANONICAL_FIRE_COLUMNS + other_cols]


def _validate_existing_fire_file(file_path, collect_data):
    """Validate a cleaned fire CSV only if it hasn't been validated before."""
    
    flag = _flag_path(file_path)
    if flag.is_file() and flag.stat().st_mtime >= Path(file_path).stat().st_mtime:
        print(f"Skipping quality checks: Cleaned fire data is already validated and unchanged: {file_path}")
        if collect_data:
            pass
        return None

    print("Running initial quality checks on existing cleaned fire file...")
    cleaned_frames = []
    input_rows = 0
    valid_rows = 0
    temp_path = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".csv",
            dir=Path(file_path).parent,
            delete=False,
            encoding="utf-8",
            newline="",
        ) as temp_file:
            temp_path = temp_file.name
            wrote_rows = False
            for chunk in pd.read_csv(
                file_path, chunksize=FIRE_CHUNK_SIZE, low_memory=False
            ):
                input_rows += len(chunk)
                validated = validate_fire_data(chunk, raise_if_empty=False)
                if not validated.empty:
                    validated = _ensure_canonical_schema(validated)
                valid_rows += len(validated)
                if collect_data and not validated.empty:
                    cleaned_frames.append(validated)
                if not validated.empty:
                    validated.to_csv(
                        temp_file,
                        index=False,
                        header=not wrote_rows,
                    )
                    wrote_rows = True

        if input_rows == 0 or valid_rows == 0:
            raise ValueError(f"Cleaned fire data contains no valid rows: {file_path}")

        if valid_rows < input_rows:
            if not wrote_rows:
                raise ValueError(f"Cleaned fire data contains no valid rows: {file_path}")
            os.replace(temp_path, file_path)
            temp_path = None
        else:
            os.remove(temp_path)
            temp_path = None
    except Exception:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        raise

    flag.touch()

    print(
        f"Existing cleaned fire data validated: {valid_rows} valid rows "
        f"({input_rows - valid_rows} removed)."
    )
    if cleaned_frames:
        return pd.concat(cleaned_frames, ignore_index=True)
    return None


def normalize_fire_dataframe(df, source_name):
    df = df.copy()
    df.columns = [col.strip().lower() for col in df.columns]
    df["satellite_source"] = source_name

    if "acq_date" in df.columns:
        df["acq_date"] = pd.to_datetime(df["acq_date"], errors="coerce")

    if "latitude" in df.columns and "longitude" in df.columns:
        df = df.dropna(subset=["latitude", "longitude"])

    if "confidence" in df.columns:
        df["confidence"] = (
            df["confidence"].astype(str).str.strip().str.lower().replace({"h": 100, "n": 50, "l": 25})
            .apply(lambda value: pd.to_numeric(value, errors="coerce"))
        )
        df["confidence"] = pd.to_numeric(df["confidence"], errors="coerce").astype("Int64")

    for column in ["type", "acq_time"]:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce").astype("Int64")

    # تطبيق المخطط الموحد للأعمدة هنا أيضاً
    df = _ensure_canonical_schema(df)
    return df


def transform_fire_data(collect_data=True):
    """Clean each year in FIRE_ARCHIVES into its own file; a year already cleaned is only validated.

    A year whose raw files are all missing is skipped, so a setup with only the 2025 archives still runs."""
    frames, produced = [], 0
    for year, sources in FIRE_ARCHIVES.items():
        output_path = CLEANED_FIRE_FILES[year]
        if os.path.isfile(output_path):
            print(f"Using existing cleaned fire data for {year}: {output_path}")
            frame = _validate_existing_fire_file(output_path, collect_data)
        elif any(os.path.exists(path) for paths in sources.values() for path in paths):
            frame = _clean_year(year, sources, output_path, collect_data)
        else:
            print(f"No raw fire files for {year}; skipping it.")
            continue
        produced += 1
        if frame is not None:
            frames.append(frame)
    if not produced:
        raise ValueError("No valid fire rows were found in the configured raw files.")
    return pd.concat(frames, ignore_index=True) if frames else None


def _clean_year(year, sources, output_path, collect_data):
    print(f"Processing and cleaning NASA fire data for {year}...")
    os.makedirs(CLEANED_DATA_DIR, exist_ok=True)
    cleaned_frames = []
    static_cells = None
    
    # تطبيق الحفظ الذري (Atomic Replace) لملف الحرائق عبر ملف مؤقت
    temp_output_path = output_path + ".tmp"

    try:
        with open(temp_output_path, "w", encoding="utf-8", newline="") as temp_file:
            output_written = False

            for source_name, file_path in ((s, path) for s, paths in sources.items() for path in paths):
                if not os.path.exists(file_path):
                    print(f"File not found: {file_path}")
                    continue
                typed = "type" in pd.read_csv(file_path, nrows=0).columns
                if not typed and static_cells is None:
                    static_cells = _static_cells([path for paths in sources.values() for path in paths])
                    print(f"Static-source cells from the {year} archive: {len(static_cells):,}")

                for df in pd.read_csv(file_path, chunksize=FIRE_CHUNK_SIZE, low_memory=False):
                    df = normalize_fire_dataframe(df, source_name)
                    if not typed:
                        df["type"] = _infer_type(df, static_cells)
                    df = validate_fire_data(df, raise_if_empty=False)
                    if df.empty:
                        continue

                    df.to_csv(
                        temp_file,
                        mode="w" if not output_written else "a",
                        header=not output_written,
                        index=False
                    )
                    output_written = True
                    if collect_data:
                        cleaned_frames.append(df)

                print(f"{os.path.basename(file_path)} ({source_name}) cleaned successfully.")

        if output_written:
            # استبدال ذري للملف النهائي دفعة واحدة بعد التأكد من نجاح الكتابة بالكامل
            os.replace(temp_output_path, output_path)
            print(f"Cleaned fire data saved atomically to: {output_path}")
            _flag_path(output_path).touch()
        else:
            if os.path.exists(temp_output_path):
                os.remove(temp_output_path)
            raise ValueError(f"No valid fire rows were found in the raw files for {year}.")

    except Exception:
        if os.path.exists(temp_output_path):
            os.remove(temp_output_path)
        raise

    if cleaned_frames:
        return pd.concat(cleaned_frames, ignore_index=True)
    return None


def transform_weather_data():
    output_path = os.path.join(CLEANED_DATA_DIR, "cleaned_weather.csv")
    raw_is_newer = (
        os.path.isfile(output_path)
        and os.path.isfile(WEATHER_FILE)
        and os.path.getmtime(WEATHER_FILE) > os.path.getmtime(output_path)
    )
    if os.path.isfile(output_path) and not raw_is_newer:
        print(f"Using existing cleaned weather data: {output_path}")
        weather_df = pd.read_csv(output_path)
        if weather_df.empty:
            raise ValueError(f"Cleaned weather data contains no rows: {output_path}")
        return weather_df
    if raw_is_newer:
        print("The raw NASA POWER file changed since it was cleaned; cleaning it again.")

    print("Processing and cleaning weather and climate data (NASA POWER)...")
    if not os.path.exists(WEATHER_FILE):
        raise FileNotFoundError(f"Weather file not found at: {WEATHER_FILE}")

    weather_df = pd.read_csv(WEATHER_FILE)

    weather_df = weather_df.dropna(subset=[c for c in ("date", "latitude", "longitude") if c in weather_df.columns])
    climate = [c for c in ("RH2M", "PRECTOTCORR", "GWETTOP") if c in weather_df.columns]
    weather_df[climate] = weather_df[climate].mask(weather_df[climate] <= -999)
    weather_df = weather_df.dropna(subset=climate, how="all")
    if weather_df.empty:
        raise ValueError(f"NASA POWER weather data contains no usable rows: {WEATHER_FILE}")

    os.makedirs(CLEANED_DATA_DIR, exist_ok=True)
    temp_path = output_path + ".tmp"
    weather_df.to_csv(temp_path, index=False)
    os.replace(temp_path, output_path)
    print(f"Weather data cleaned and saved to: {output_path} ({len(weather_df):,} rows)")
    return weather_df


if __name__ == "__main__":
    transform_fire_data(collect_data=False)
    transform_weather_data()
    print("The Transform stage completed successfully and the data is ready for Load!")