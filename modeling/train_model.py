"""Train and save a model that classifies high-FRP fire events.

The label is based on observed FRP, so this predicts event severity for an
already detected fire; it does not predict fire occurrence. Weather observations
must include date, latitude, and longitude to prevent invalid spatial/temporal
joins.

Environment switches (see README):

* ``REQUIRE_WEATHER_MATCH`` (default 1): keep only fires matched to a same-day
  weather record. Set to 0 to train on every detection; CatBoost handles missing
  weather values natively. Use this when weather coverage is much smaller than
  fire coverage, otherwise the model only learns one region.
* ``TRAINING_SOURCE`` (default db): ``csv`` trains from ``cleaned_data/`` without
  PostgreSQL (``FIRES_SAMPLE_FILE`` is used when present).
* ``MODEL_ARTIFACT_PATH``: where to save the model.
* ``FORCE_RETRAIN`` (default 0): retrain even when the artifact already exists.
* ``CATBOOST_ITERATIONS`` / ``CATBOOST_DEPTH`` / ``CATBOOST_LEARNING_RATE``
  (500 / 6 / 0.05): boosting rounds, tree depth, and learning rate.
* ``CATBOOST_ITERATIONS`` (1000, a cap) with ``CATBOOST_EARLY_STOPPING_ROUNDS`` (50): training stops when
  validation AUC has not improved for that many rounds and keeps the best iteration. The validation slice is
  the last ``VALIDATION_SHARE`` (0.15) of the training dates; the test period is never used for stopping.
* ``CATBOOST_BORDER_COUNT`` (0 = default): number of feature-value bins.
* ``TARGET_RECALL`` (0.85): the saved decision threshold is the highest one that still catches this share of
  severe fires on the validation slice (a missed severe fire costs more than a false alarm).
* ``TUNE=1``: first try depth 4/6/8 x learning rate 0.05/0.1 with 3-fold spatial GroupKFold. A setting replaces the
  default only if it beats it by ``TUNE_MIN_GAIN`` AUC (default 0.005, the size of the spread between spatial folds).
* ``COMPARE_WITH``: path to an earlier artifact. Both models are then scored on the same validation slice and the same
  chronological test period, and the comparison is stored in ``metrics.comparison``.
* The artifact stores a calibrated Fire Risk Score scale (``risk_scale``, see modeling/risk.py).
* The artifact also stores ``metrics.spatial_cv`` (5-fold GroupKFold over 5-degree blocks, mean and std) and
  ``shap_importance`` (mean |SHAP| per feature, CatBoost's native TreeSHAP). Derived features come from
  ``modeling/features.py``, shared with the API.
* ``BLANK_AUGMENT_SHARE`` (default 0.5): extra training copies, as a share of the
  training rows, with groups of inputs blanked (see ``blank_augment``). This is
  how the model learns what a missing input means. 0 turns it off.

Missing inputs: CatBoost treats a blank as lower than every real value, and it
always considers the split that separates blanks from the rest. A model trained
only on complete rows never sees that split used, so a request with blank
brightness lands wherever the lowest brightness happened to land (in practice,
"severe"). Training on blanked copies teaches it the right answer for a blank:
the average risk for that place, date and time, given whatever is known.
"""

import logging
import os
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.metrics import average_precision_score
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.neighbors import BallTree
from sqlalchemy import URL, create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from config import CLEANED_DATA_DIR, DB_CONFIG
from modeling.features import DERIVED_FEATURES, add_derived_features
from modeling.risk import apply_risk, fit_risk, level_table

LOGGER = logging.getLogger("geodata.model")
MODEL_ARTIFACT_PATH = Path(
    os.getenv(
        "MODEL_ARTIFACT_PATH",
        Path(__file__).resolve().parent / "artifacts" / "high_frp_classifier.joblib",
    )
)
REQUIRE_WEATHER_MATCH = os.getenv("REQUIRE_WEATHER_MATCH", "1").lower() not in {"0", "false", "no"}
TRAINING_SOURCE = os.getenv("TRAINING_SOURCE", "db").strip().lower()
CATBOOST_ITERATIONS = int(os.getenv("CATBOOST_ITERATIONS", "1000"))  # a cap: early stopping decides
CATBOOST_DEPTH = int(os.getenv("CATBOOST_DEPTH", "6"))
CATBOOST_LEARNING_RATE = float(os.getenv("CATBOOST_LEARNING_RATE", "0.05"))
CATBOOST_L2_LEAF_REG = float(os.getenv("CATBOOST_L2_LEAF_REG", "3.0"))
CATBOOST_EARLY_STOPPING_ROUNDS = int(os.getenv("CATBOOST_EARLY_STOPPING_ROUNDS", "50"))
CATBOOST_BORDER_COUNT = int(os.getenv("CATBOOST_BORDER_COUNT", "0"))  # 0 = CatBoost's default (254)
VALIDATION_SHARE = float(os.getenv("VALIDATION_SHARE", "0.15"))  # last share of training dates: early stopping + threshold
TARGET_RECALL = float(os.getenv("TARGET_RECALL", "0.85"))
TUNE = os.getenv("TUNE", "0").lower() in {"1", "true", "yes"}
TUNE_MIN_GAIN = float(os.getenv("TUNE_MIN_GAIN", "0.005"))
# On by default. Spatial CV saw no difference (AUC 0.8949 either way), but with early stopping on, training without
# them scored lower on the chronological test period (AUC 0.8902 vs 0.8928) and on live fires. USE_DERIVED_FEATURES=0
# trains with the 12 raw inputs only.
USE_DERIVED_FEATURES = os.getenv("USE_DERIVED_FEATURES", "1").lower() in {"1", "true", "yes"}
COMPARE_WITH = os.getenv("COMPARE_WITH", "").strip()
MODEL_TYPE = "CatBoostClassifier"
# Retrain even when an artifact exists (scheduled retraining, new weather data).
FORCE_RETRAIN = os.getenv("FORCE_RETRAIN", "0").lower() in {"1", "true", "yes"}
EARTH_RADIUS_KM = 6371.0088
FIRE_CHUNK_SIZE = int(os.getenv("FIRE_CHUNK_SIZE", "100000"))
MAX_TRAINING_ROWS = int(os.getenv("MAX_TRAINING_ROWS", "500000"))
HIGH_FRP_THRESHOLD = float(os.getenv("HIGH_FRP_THRESHOLD", "10"))
MAX_WEATHER_DISTANCE_KM = float(os.getenv("MAX_WEATHER_DISTANCE_KM", "100"))
BLANK_AUGMENT_SHARE = float(os.getenv("BLANK_AUGMENT_SHARE", "0.5"))
# Bumped whenever the training recipe changes, so an older artifact is retrained.
TRAINING_SCHEME = "blank-augmented-v3" if BLANK_AUGMENT_SHARE > 0 else "complete-rows"
# Inputs that describe the detection itself. Callers that only know where and
# when (forecasts, the Ember outlook) leave all of these blank.
MEASUREMENT_FEATURES = ["brightness", "confidence", "scan", "track"]

WEATHER_ALIASES = {
    "rh2m": "rh2m",
    "relative_humidity": "rh2m",
    "humidity": "rh2m",
    "prectotcorr": "prectotcorr",
    "precipitation": "prectotcorr",
    "precip": "prectotcorr",
    "gwettop": "gwettop",
    "soil_moisture": "gwettop",
}
FIRE_FEATURES = [
    "latitude",
    "longitude",
    "brightness",
    "confidence",
    "scan",
    "track",
    "type",
    "acq_time",
    "day_of_year",
]


def get_database_engine():
    """Create an SQLAlchemy engine using the project's existing DB settings."""
    url = URL.create(
        "postgresql+psycopg2",
        username=DB_CONFIG["user"],
        password=DB_CONFIG["password"],
        host=DB_CONFIG["host"],
        port=int(DB_CONFIG["port"]),
        database=DB_CONFIG["dbname"],
    )
    return create_engine(url, pool_pre_ping=True)


def quote_identifier(engine, identifier):
    return engine.dialect.identifier_preparer.quote(identifier)


def table_columns(engine, table_name, schema):
    columns = inspect(engine).get_columns(table_name, schema=schema)
    if not columns:
        raise ValueError(f"Table {schema}.{table_name} was not found or has no columns.")
    return {column["name"].lower(): column["name"] for column in columns}


def canonical_date(values):
    """Parse SQL dates and NASA POWER YYYYMMDD values consistently.

    Date columns repeat a handful of values (one per day), so each distinct
    value is parsed once and mapped back: millions of rows cost the same as
    a few hundred.
    """
    values = pd.Series(values)
    codes, uniques = pd.factorize(values, use_na_sentinel=True)
    if len(uniques) < len(values):
        parsed_uniques = _canonical_date_unique(pd.Series(uniques)).to_numpy()
        parsed = np.full(len(values), np.datetime64("NaT", "ns"), dtype="datetime64[ns]")
        known = codes >= 0
        parsed[known] = parsed_uniques[codes[known]]
        return pd.Series(parsed, index=values.index)
    return _canonical_date_unique(values)


def _canonical_date_unique(values):
    values = values.astype("string").str.strip().str.replace(r"\.0$", "", regex=True)
    compact_dates = values.str.fullmatch(r"\d{8}", na=False)
    parsed = pd.to_datetime(values.where(compact_dates), format="%Y%m%d", errors="coerce")
    parsed.loc[~compact_dates] = pd.to_datetime(values.loc[~compact_dates], errors="coerce", format="mixed")
    return parsed.dt.normalize()


def load_weather(engine, schema):
    """Load weather data and build per-day spatial nearest-neighbor indexes."""
    columns = table_columns(engine, "weather_data", schema)
    date_name = next(
        (columns[name] for name in ("date", "acq_date", "time", "date_key") if name in columns),
        None,
    )
    latitude_name = next(
        (columns[name] for name in ("latitude", "lat") if name in columns),
        None,
    )
    longitude_name = next(
        (columns[name] for name in ("longitude", "lon", "lng") if name in columns),
        None,
    )
    feature_names = {
        WEATHER_ALIASES[name]: actual_name
        for name, actual_name in columns.items()
        if name in WEATHER_ALIASES
    }

    missing_keys = [
        name
        for name, actual in (
            ("date", date_name),
            ("latitude", latitude_name),
            ("longitude", longitude_name),
        )
        if actual is None
    ]
    if missing_keys:
        raise ValueError(
            "weather_data is missing spatial/temporal join columns: "
            f"{', '.join(missing_keys)}. Store a date, latitude, and longitude "
            "with each NASA POWER observation before training. The current ETL "
            "drops the date index and does not store the requested coordinates."
        )
    if not feature_names:
        raise ValueError(
            "weather_data has no recognized climate columns. Expected one or more "
            "of RH2M, PRECTOTCORR, or GWETTOP."
        )

    selection = [
        (date_name, "weather_date"),
        (latitude_name, "weather_latitude"),
        (longitude_name, "weather_longitude"),
        *[(name, canonical) for canonical, name in feature_names.items()],
    ]
    selected_sql = ", ".join(
        f"{quote_identifier(engine, actual)} AS {quote_identifier(engine, canonical)}"
        for actual, canonical in selection
    )
    query = text(
        f"SELECT {selected_sql} FROM "
        f"{quote_identifier(engine, schema)}.{quote_identifier(engine, 'weather_data')}"
    )
    weather = pd.read_sql_query(query, engine)
    return build_weather_indexes(weather, list(feature_names.keys()))


def load_weather_csv(path):
    """CSV counterpart of ``load_weather`` for training without a database."""
    raw = pd.read_csv(path)
    columns = {str(name).strip().lower(): name for name in raw.columns}
    date_name = next((columns[n] for n in ("date", "acq_date", "time", "date_key") if n in columns), None)
    latitude_name = next((columns[n] for n in ("latitude", "lat") if n in columns), None)
    longitude_name = next((columns[n] for n in ("longitude", "lon", "lng") if n in columns), None)
    if None in (date_name, latitude_name, longitude_name):
        raise ValueError(f"{path} needs date, latitude and longitude columns.")
    weather = pd.DataFrame(
        {
            "weather_date": raw[date_name],
            "weather_latitude": raw[latitude_name],
            "weather_longitude": raw[longitude_name],
        }
    )
    features = []
    for lower, original in columns.items():
        canonical = WEATHER_ALIASES.get(lower)
        if canonical and canonical not in weather.columns:
            weather[canonical] = raw[original]
            features.append(canonical)
    if not features:
        raise ValueError(f"{path} has no recognized climate columns (RH2M, PRECTOTCORR, GWETTOP).")
    return build_weather_indexes(weather, features)


def build_weather_indexes(weather, feature_names):
    """Validate a canonical weather frame and build per-day BallTree indexes."""
    weather = weather.copy()
    weather["weather_date"] = canonical_date(weather["weather_date"])

    numeric_columns = ["weather_latitude", "weather_longitude", *feature_names]
    for column in numeric_columns:
        weather[column] = pd.to_numeric(weather[column], errors="coerce")
    weather[numeric_columns] = weather[numeric_columns].replace(-999, np.nan)
    feature_names = [
        feature for feature in feature_names if weather[feature].notna().any()
    ]
    if not feature_names:
        raise ValueError("weather_data has no valid numeric climate observations.")
    valid_coordinates = (
        weather["weather_latitude"].between(-90, 90)
        & weather["weather_longitude"].between(-180, 180)
    )
    weather = weather.dropna(
        subset=["weather_date", "weather_latitude", "weather_longitude"]
    )
    weather = weather.loc[valid_coordinates].reset_index(drop=True)
    if weather.empty:
        raise ValueError("weather_data has no valid, dated weather locations.")

    # BallTree uses radians and haversine distance. Each event is matched only
    # to a weather observation from the same date.
    indexes = {}
    for date, daily_weather in weather.groupby("weather_date", sort=False):
        coordinates = np.radians(
            daily_weather[["weather_latitude", "weather_longitude"]].to_numpy()
        )
        indexes[date] = (
            BallTree(coordinates, metric="haversine"),
            daily_weather[list(feature_names)].to_numpy(dtype=float),
        )
    LOGGER.info(
        "Loaded %s weather observations across %s dates with features: %s",
        len(weather),
        len(indexes),
        ", ".join(feature_names),
    )
    return indexes, list(feature_names)


def load_fire_chunks(engine, schema):
    """Stream only the fire columns required for labels and predictors."""
    columns = table_columns(engine, "fire_events", schema)
    required = ("latitude", "longitude", "acq_date", "frp")
    missing = [name for name in required if name not in columns]
    if missing:
        raise ValueError(
            f"fire_events is missing required columns: {', '.join(missing)}."
        )

    selected = list(required) + [
        name
        for name in ("brightness", "confidence", "scan", "track", "type", "acq_time")
        if name in columns
    ]
    selected_sql = ", ".join(
        f"{quote_identifier(engine, columns[name])} AS {quote_identifier(engine, name)}"
        for name in selected
    )
    query = text(
        f"SELECT {selected_sql} FROM "
        f"{quote_identifier(engine, schema)}.{quote_identifier(engine, 'fire_events')}"
    )
    return pd.read_sql_query(query, engine, chunksize=FIRE_CHUNK_SIZE)


def csv_fire_columns():
    """Column map for the CSV training source (mirrors ``table_columns``)."""
    header = pd.read_csv(csv_fire_path(), nrows=0).columns
    return {str(name).strip().lower(): name for name in header}


def csv_fire_path():
    sample = Path(os.getenv("FIRES_SAMPLE_FILE", Path(CLEANED_DATA_DIR) / "fires_sample.csv"))
    full = Path(os.getenv("FIRES_CSV_FILE", Path(CLEANED_DATA_DIR) / "cleaned_master_fires.csv"))
    path = sample if sample.is_file() else full
    if not path.is_file():
        raise FileNotFoundError(f"No cleaned fire CSV found: {sample} or {full}")
    return path


def load_fire_chunks_csv():
    columns = csv_fire_columns()
    required = ("latitude", "longitude", "acq_date", "frp")
    missing = [name for name in required if name not in columns]
    if missing:
        raise ValueError(f"Fire CSV is missing required columns: {', '.join(missing)}.")
    selected = [columns[n] for n in required] + [
        columns[n] for n in ("brightness", "confidence", "scan", "track", "type", "acq_time") if n in columns
    ]
    for chunk in pd.read_csv(csv_fire_path(), usecols=selected, chunksize=FIRE_CHUNK_SIZE, low_memory=False):
        chunk.columns = [str(c).strip().lower() for c in chunk.columns]
        yield chunk


def match_weather(fires, weather_indexes, weather_features):
    """Attach nearest same-day weather values within the configured radius."""
    fires = fires.copy().reset_index(drop=True)
    fires["_date"] = canonical_date(fires["acq_date"])
    fires["latitude"] = pd.to_numeric(fires["latitude"], errors="coerce")
    fires["longitude"] = pd.to_numeric(fires["longitude"], errors="coerce")
    fires["frp"] = pd.to_numeric(fires["frp"], errors="coerce")
    fires = fires.dropna(
        subset=["_date", "latitude", "longitude", "frp"]
    ).reset_index(drop=True)
    fires = fires.loc[
        fires["latitude"].between(-90, 90)
        & fires["longitude"].between(-180, 180)
    ].reset_index(drop=True)
    if fires.empty:
        return fires

    weather_values = np.full((len(fires), len(weather_features)), np.nan)
    distance_km = np.full(len(fires), np.inf)
    max_distance_radians = MAX_WEATHER_DISTANCE_KM / EARTH_RADIUS_KM

    for date, positions in fires.groupby("_date", sort=False).groups.items():
        if date not in weather_indexes:
            continue
        tree, daily_values = weather_indexes[date]
        coordinates = np.radians(
            fires.loc[positions, ["latitude", "longitude"]].to_numpy()
        )
        distances, nearest = tree.query(coordinates, k=1)
        distances = distances[:, 0]
        nearest = nearest[:, 0]
        valid = distances <= max_distance_radians
        row_positions = np.asarray(list(positions), dtype=np.intp)[valid]
        weather_values[row_positions] = daily_values[nearest[valid]]
        distance_km[row_positions] = distances[valid] * EARTH_RADIUS_KM

    fires[weather_features] = weather_values
    fires["_weather_distance_km"] = distance_km
    if REQUIRE_WEATHER_MATCH:
        return fires.loc[np.isfinite(distance_km)].copy()
    return fires


def make_training_sample(engine, schema, weather_indexes, weather_features):
    """Stream fires, merge weather, and keep a uniform bounded random sample."""
    rng = np.random.default_rng(42)
    sample = pd.DataFrame()
    matched_rows = 0
    total_rows = 0
    if engine is None:
        fire_columns = csv_fire_columns()
        chunks = load_fire_chunks_csv()
    else:
        fire_columns = table_columns(engine, "fire_events", schema)
        chunks = load_fire_chunks(engine, schema)
    feature_columns = [
        column
        for column in FIRE_FEATURES
        if column == "day_of_year" or column in fire_columns
    ]
    for chunk in chunks:
        total_rows += len(chunk)
        merged = match_weather(chunk, weather_indexes, weather_features)
        matched_rows += int(np.isfinite(merged["_weather_distance_km"]).sum()) if len(merged) else 0
        if merged.empty:
            continue

        merged["day_of_year"] = merged["_date"].dt.dayofyear.astype(float)
        for column in feature_columns:
            merged[column] = pd.to_numeric(merged[column], errors="coerce")
        feature_columns.extend(
            feature for feature in weather_features if feature not in feature_columns
        )

        selected = merged[feature_columns + ["_date", "frp", "_weather_distance_km"]].copy()
        selected = selected.replace([np.inf, -np.inf], np.nan)
        selected = selected.dropna(subset=["_date", "frp"])
        if selected.empty:
            continue
        selected["target"] = (selected["frp"] >= HIGH_FRP_THRESHOLD).astype("int8")
        selected = selected.drop(columns="frp")
        selected["_priority"] = rng.random(len(selected))
        sample = pd.concat([sample, selected], ignore_index=True)
        if len(sample) > MAX_TRAINING_ROWS:
            sample = sample.nsmallest(MAX_TRAINING_ROWS, "_priority")

    if total_rows == 0:
        raise ValueError("fire_events contains no rows.")
    match_rate = matched_rows / total_rows
    LOGGER.info(
        "Matched %s of %s fire rows to same-day weather within %.1f km (%.1f%%).",
        matched_rows,
        total_rows,
        MAX_WEATHER_DISTANCE_KM,
        match_rate * 100,
    )
    if sample.empty:
        raise ValueError(
            "No usable fire/weather rows were matched. Check weather dates and "
            "coordinates, then increase MAX_WEATHER_DISTANCE_KM if appropriate."
        )
    LOGGER.info(
        "Using %s rows for training (%s with matched weather); high-FRP threshold is %.2f MW.",
        len(sample),
        int(np.isfinite(sample["_weather_distance_km"]).sum()),
        HIGH_FRP_THRESHOLD,
    )
    return sample.drop(columns="_priority"), feature_columns


def training_extent(data):
    """Where and when the training rows come from; saved with the model so the
    API can warn when a prediction falls outside what the model has seen."""
    matched = np.isfinite(data["_weather_distance_km"])
    return {
        "rows": int(len(data)),
        "rows_with_weather": int(matched.sum()),
        "require_weather_match": REQUIRE_WEATHER_MATCH,
        "latitude_min": float(data["latitude"].min()),
        "latitude_max": float(data["latitude"].max()),
        "longitude_min": float(data["longitude"].min()),
        "longitude_max": float(data["longitude"].max()),
        "start_date": str(pd.Timestamp(data["_date"].min()).date()),
        "end_date": str(pd.Timestamp(data["_date"].max()).date()),
        "high_frp_share": float(data["target"].mean()),
    }


def temporal_split(data):
    """Split chronologically so later events are held out from training."""
    dates = np.sort(data["_date"].dropna().unique())
    if len(dates) < 2:
        raise ValueError("At least two distinct event dates are needed for a temporal split.")
    split_at = max(1, int(len(dates) * 0.8))
    if split_at >= len(dates):
        split_at = len(dates) - 1
    cutoff = dates[split_at]
    train = data.loc[data["_date"] < cutoff]
    test = data.loc[data["_date"] >= cutoff]
    if train.empty or test.empty:
        raise ValueError("The chronological train/test split produced an empty partition.")
    if train["target"].nunique() < 2 or test["target"].nunique() < 2:
        raise ValueError(
            "Both classes must be present in the chronological train and test sets. "
            "Use more dates or a broader data period; do not randomly split these "
            "events because that can leak temporal patterns."
        )
    return train, test, cutoff


BLANK_PATTERNS = {
    # name: (columns to blank, share of the augmented copies)
    "place_and_time_only": ("measurements+weather", 0.35),
    "no_measurements": ("measurements", 0.25),
    "no_weather": ("weather", 0.15),
    "random_single": ("one", 0.25),
}


def blank_columns(pattern, feature_columns, weather_features):
    measurements = [c for c in MEASUREMENT_FEATURES if c in feature_columns]
    weather = [c for c in weather_features if c in feature_columns]
    if pattern == "measurements+weather":
        return measurements + weather
    if pattern == "measurements":
        return measurements
    if pattern == "weather":
        return weather
    raise ValueError(f"Unknown blank pattern: {pattern}")


def blank_augment(train, feature_columns, weather_features, share=BLANK_AUGMENT_SHARE, seed=7):
    """Append copies of training rows with groups of inputs set to NaN.

    The original rows stay as they are, so complete requests are learned exactly
    as before; the copies teach the model what each kind of blank means.
    """
    if share <= 0 or train.empty:
        return train
    rng = np.random.default_rng(seed)
    total = int(len(train) * share)
    copies = []
    for pattern, part in BLANK_PATTERNS.values():
        rows = train.sample(n=max(1, int(total * part)), random_state=int(rng.integers(1 << 31)), replace=False)
        rows = rows.copy()
        if pattern == "one":
            # A different single column for each row.
            candidates = [c for c in MEASUREMENT_FEATURES + list(weather_features) + ["acq_time", "type"] if c in feature_columns]
            picks = rng.integers(len(candidates), size=len(rows))
            for index, column in enumerate(candidates):
                rows.loc[picks == index, column] = np.nan
        else:
            rows[blank_columns(pattern, feature_columns, weather_features)] = np.nan
        if DERIVED_FEATURES[0] in rows.columns:   # derived features follow their (now blank) inputs
            rows = add_derived_features(rows)
        copies.append(rows)
    augmented = pd.concat([train, *copies], ignore_index=True)
    LOGGER.info("Blank-input augmentation: %s complete rows + %s blanked copies.", len(train), len(augmented) - len(train))
    return augmented


def evaluate_blank_inputs(model, test_df, feature_columns, weather_features):
    """Score the hold-out period again with groups of inputs blanked."""
    results = {}
    y_test = test_df["target"]
    for name, (pattern, _) in BLANK_PATTERNS.items():
        if pattern == "one":
            continue
        X = test_df[feature_columns].copy()
        X[blank_columns(pattern, feature_columns, weather_features)] = np.nan
        if DERIVED_FEATURES[0] in X.columns:
            X = add_derived_features(X)
        p = model.predict_proba(X)[:, 1]
        results[name] = {
            "roc_auc": float(roc_auc_score(y_test, p)),
            "brier_score": float(brier_score_loss(y_test, p)),
            "mean_probability": float(p.mean()),
        }
        LOGGER.info("Blank inputs (%s): ROC-AUC %.4f, mean p %.3f", name, results[name]["roc_auc"], p.mean())
    results["observed_high_frp_share"] = float(y_test.mean())
    return results


def evaluate_generalization_and_calibration(model, test_df, feature_columns):
    """Measure probability calibration and latitude-based holdout performance."""
    X_test = test_df[feature_columns]
    y_test = test_df["target"]
    probabilities = model.predict_proba(X_test)[:, 1]
    brier = float(brier_score_loss(y_test, probabilities))
    fraction_of_positives, mean_predicted_probability = calibration_curve(
        y_test, probabilities
    )

    spatial_eval = {}
    if "latitude" in test_df.columns:
        latitude = pd.to_numeric(test_df["latitude"], errors="coerce")
        valid_latitude = latitude.notna()
        if valid_latitude.any():
            median_latitude = latitude.loc[valid_latitude].median()
            spatial_groups = {
                "north": valid_latitude & latitude.ge(median_latitude),
                "south": valid_latitude & latitude.lt(median_latitude),
            }
            for name, mask in spatial_groups.items():
                subset = test_df.loc[mask]
                if not subset.empty and subset["target"].nunique() > 1:
                    subset_probabilities = model.predict_proba(
                        subset[feature_columns]
                    )[:, 1]
                    spatial_eval[f"roc_auc_{name}"] = float(
                        roc_auc_score(subset["target"], subset_probabilities)
                    )

    LOGGER.info("Model Calibration Brier Score: %.4f (lower is better)", brier)
    return {
        "brier_score": brier,
        "calibration_curve": {
            "mean_predicted_probability": mean_predicted_probability.tolist(),
            "fraction_of_positives": fraction_of_positives.tolist(),
        },
        "spatial_generalization": spatial_eval,
    }


def scores(y_true, probabilities, threshold):
    """The comparison metrics at one threshold: ROC-AUC, PR-AUC, precision, recall, F1 and the confusion counts."""
    y = np.asarray(y_true).astype(int)
    p = np.asarray(probabilities, dtype=float)
    flagged = p >= threshold
    return {
        "threshold": float(threshold),
        "roc_auc": float(roc_auc_score(y, p)), "pr_auc": float(average_precision_score(y, p)),
        "precision": float(precision_score(y, flagged, zero_division=0)), "recall": float(recall_score(y, flagged, zero_division=0)),
        "f1": float(f1_score(y, flagged, zero_division=0)),
        "false_negatives": int(((~flagged) & (y == 1)).sum()), "false_positives": int((flagged & (y == 0)).sum()),
        "true_positives": int((flagged & (y == 1)).sum()), "positives": int(y.sum()), "rows": int(len(y)),
    }


def compare_with_previous(path, val_rows, test, new_val_p, new_test_p, new_threshold):
    """Score an earlier artifact on exactly the same validation slice and test period as the new model.

    Each model gets a threshold picked the same way on the validation slice (never on the test period). The earlier
    model trained on dates that now form the validation slice, so its validation numbers are optimistic; its test
    numbers are fair, because both models trained only on dates before the test period.
    """
    previous = joblib.load(path)
    columns = list(previous["feature_columns"])
    old_val_p = previous["model"].predict_proba(val_rows[columns])[:, 1]
    old_test_p = previous["model"].predict_proba(test[columns])[:, 1]
    old_threshold, _ = pick_threshold(val_rows["target"], old_val_p)
    result = {"previous_artifact": str(path), "previous_scheme": previous.get("training_scheme"),
              "test_period_start": str(pd.Timestamp(test["_date"].min()).date()), "test_rows": int(len(test))}
    for name, val_p, test_p, threshold in (("previous", old_val_p, old_test_p, old_threshold), ("new", new_val_p, new_test_p, new_threshold)):
        result[name] = {"test_at_0.5": scores(test["target"], test_p, 0.5),
                        "test_at_own_threshold": scores(test["target"], test_p, threshold),
                        "validation_at_own_threshold": scores(val_rows["target"], val_p, threshold)}
    for label in ("test_at_0.5", "test_at_own_threshold"):
        a, b = result["previous"][label], result["new"][label]
        LOGGER.info("Comparison, %s: ROC-AUC %.4f -> %.4f | PR-AUC %.4f -> %.4f | recall %.3f -> %.3f | precision %.3f -> %.3f | F1 %.3f -> %.3f | FN %s -> %s",
                    label, a["roc_auc"], b["roc_auc"], a["pr_auc"], b["pr_auc"], a["recall"], b["recall"], a["precision"], b["precision"], a["f1"], b["f1"], a["false_negatives"], b["false_negatives"])
    return result


def spatial_groups(df, block_deg=5):
    """Group id of the block_deg x block_deg lat/lon block each row falls in (for GroupKFold)."""
    lat = pd.to_numeric(df["latitude"], errors="coerce").fillna(0)
    lon = pd.to_numeric(df["longitude"], errors="coerce").fillna(0)
    return (np.floor((lat + 90) / block_deg) * 1000 + np.floor((lon + 180) / block_deg)).astype(int).to_numpy()


def catboost_params(iterations=None, depth=None, learning_rate=None, early_stopping=False):
    params = dict(
        iterations=iterations or CATBOOST_ITERATIONS, depth=depth or CATBOOST_DEPTH,
        learning_rate=learning_rate or CATBOOST_LEARNING_RATE, l2_leaf_reg=CATBOOST_L2_LEAF_REG,
        loss_function="Logloss", eval_metric="AUC", auto_class_weights="Balanced", random_seed=42,
        thread_count=-1, verbose=False, allow_writing_files=False,
    )
    if CATBOOST_BORDER_COUNT:
        params["border_count"] = CATBOOST_BORDER_COUNT
    if early_stopping:
        params.update(early_stopping_rounds=CATBOOST_EARLY_STOPPING_ROUNDS, use_best_model=True)
    return params


def validation_split(train):
    """Last VALIDATION_SHARE of the training dates, so early stopping and the threshold never see the test period."""
    dates = np.sort(train["_date"].dropna().unique())
    cutoff = dates[max(1, int(len(dates) * (1 - VALIDATION_SHARE)))]
    fit, val = train.loc[train["_date"] < cutoff], train.loc[train["_date"] >= cutoff]
    if fit.empty or val.empty or val["target"].nunique() < 2:
        raise ValueError("The validation slice is empty or has one class; use more dates.")
    return fit, val


def pick_threshold(y_true, probabilities):
    """Highest threshold whose recall on the validation slice is at least TARGET_RECALL (false negatives cost most)."""
    from sklearn.metrics import precision_recall_curve
    precision, recall, thresholds = precision_recall_curve(y_true, probabilities)
    ok = np.where(recall[:-1] >= TARGET_RECALL)[0]
    index = ok[-1] if len(ok) else 0
    threshold = float(np.clip(thresholds[index], 0.01, 0.99))
    return threshold, {"target_recall": TARGET_RECALL, "validation_precision": float(precision[index]), "validation_recall": float(recall[index])}


def spatial_cv(data, feature_columns, iterations, depth, learning_rate, threshold, n_splits=5):
    """GroupKFold over 5 degree blocks: every fold is scored on places the model never trained on."""
    from catboost import CatBoostClassifier
    from sklearn.model_selection import GroupKFold
    groups = spatial_groups(data)
    rows = []
    for fold, (tr, te) in enumerate(GroupKFold(n_splits=n_splits).split(data, data["target"], groups)):
        model = CatBoostClassifier(**catboost_params(iterations, depth, learning_rate))
        model.fit(data.iloc[tr][feature_columns], data.iloc[tr]["target"])
        y = data.iloc[te]["target"].to_numpy()
        p = model.predict_proba(data.iloc[te][feature_columns])[:, 1]
        flagged = p >= threshold
        rows.append({"roc_auc": roc_auc_score(y, p), "pr_auc": average_precision_score(y, p), "brier": brier_score_loss(y, p),
                     "recall": recall_score(y, flagged, zero_division=0), "precision": precision_score(y, flagged, zero_division=0)})
        LOGGER.info("Spatial CV fold %s/%s: AUC %.4f, recall %.3f, precision %.3f", fold + 1, n_splits, rows[-1]["roc_auc"], rows[-1]["recall"], rows[-1]["precision"])
    frame = pd.DataFrame(rows)
    result = {"folds": n_splits, "block_degrees": 5, "threshold": threshold}
    for column in frame:
        result[column] = {"mean": float(frame[column].mean()), "std": float(frame[column].std(ddof=0))}
    return result


def tune_hyperparameters(data, feature_columns):
    """TUNE=1: a small grid scored by 3-fold spatial GroupKFold AUC on a sample. Returns (depth, learning_rate)."""
    from catboost import CatBoostClassifier
    from sklearn.model_selection import GroupKFold
    sample = data.sample(n=min(len(data), 150_000), random_state=3)
    groups = spatial_groups(sample)
    best = (CATBOOST_DEPTH, CATBOOST_LEARNING_RATE, -1.0)
    default_auc = None
    for depth in (4, 6, 8):
        for rate in (0.05, 0.1):
            aucs = []
            for tr, te in GroupKFold(n_splits=3).split(sample, sample["target"], groups):
                model = CatBoostClassifier(**catboost_params(300, depth, rate))
                model.fit(sample.iloc[tr][feature_columns], sample.iloc[tr]["target"])
                aucs.append(roc_auc_score(sample.iloc[te]["target"], model.predict_proba(sample.iloc[te][feature_columns])[:, 1]))
            LOGGER.info("Tuning depth=%s lr=%s: spatial CV AUC %.4f", depth, rate, np.mean(aucs))
            if depth == CATBOOST_DEPTH and abs(rate - CATBOOST_LEARNING_RATE) < 1e-9:
                default_auc = float(np.mean(aucs))
            if np.mean(aucs) > best[2]:
                best = (depth, rate, float(np.mean(aucs)))
    if default_auc is not None and best[2] - default_auc < TUNE_MIN_GAIN:
        LOGGER.info("Tuning: best depth=%s lr=%s gains only %.4f AUC over the default (< %.3f); keeping the default.",
                    best[0], best[1], best[2] - default_auc, TUNE_MIN_GAIN)
        return CATBOOST_DEPTH, CATBOOST_LEARNING_RATE
    LOGGER.info("Tuning picked depth=%s lr=%s", best[0], best[1])
    return best[0], best[1]


def shap_summary(model, X, n=5000):
    """Mean |SHAP value| per feature (CatBoost's native TreeSHAP) on a sample, as shares of the total."""
    from catboost import Pool
    sample = X.sample(n=min(n, len(X)), random_state=5)
    values = model.get_feature_importance(Pool(sample), type="ShapValues")[:, :-1]
    mean_abs = np.abs(values).mean(axis=0)
    total = float(mean_abs.sum()) or 1.0
    ranked = sorted(zip(X.columns, mean_abs / total), key=lambda kv: -kv[1])
    LOGGER.info("SHAP importance (mean |value|, share of total) on %s rows:", len(sample))
    for name, share in ranked:
        LOGGER.info("  %-20s %5.1f%%  %s", name, share * 100, "#" * int(share * 100 / 2))
    return {name: float(share) for name, share in ranked}


def train_and_evaluate(data, feature_columns):
    """Train CatBoost with early stopping, pick a recall-first threshold, run spatial CV and SHAP, save the artifact."""
    try:
        from catboost import CatBoostClassifier
    except ModuleNotFoundError as error:
        raise ModuleNotFoundError(
            "CatBoost is required to train the production model. "
            "Install it with: pip install -r requirements.txt"
        ) from error

    data = add_derived_features(data)   # always computed, so the comparison below can use them
    if USE_DERIVED_FEATURES:
        feature_columns = list(feature_columns) + [f for f in DERIVED_FEATURES if f not in feature_columns]
    weather_features = [feature for feature in feature_columns if feature in WEATHER_ALIASES.values()]
    train, test, cutoff = temporal_split(data)
    fit_rows, val_rows = validation_split(train)

    depth, rate = (tune_hyperparameters(train, feature_columns) if TUNE else (CATBOOST_DEPTH, CATBOOST_LEARNING_RATE))
    augmented = blank_augment(fit_rows, feature_columns, weather_features)
    model = CatBoostClassifier(**catboost_params(CATBOOST_ITERATIONS, depth, rate, early_stopping=True))
    model.fit(augmented[feature_columns], augmented["target"], eval_set=(val_rows[feature_columns], val_rows["target"]))
    best_iteration = int(model.get_best_iteration())
    LOGGER.info("Early stopping: best iteration %s of at most %s.", best_iteration, CATBOOST_ITERATIONS)

    val_p = model.predict_proba(val_rows[feature_columns])[:, 1]
    threshold, selection = pick_threshold(val_rows["target"], val_p)
    LOGGER.info("Decision threshold %.3f (validation recall %.3f, precision %.3f; target recall %.2f).",
                threshold, selection["validation_recall"], selection["validation_precision"], TARGET_RECALL)

    risk_scale = fit_risk(val_rows["target"], val_p, threshold)
    LOGGER.info("Fire Risk Score cut-offs (calibrated on the validation slice): %s", risk_scale["cutoffs"])

    predictions = model.predict(test[feature_columns])
    probabilities = model.predict_proba(test[feature_columns])[:, 1]
    at_threshold = probabilities >= threshold
    metrics = {
        "accuracy": float(accuracy_score(test["target"], predictions)),
        "precision": float(precision_score(test["target"], predictions, zero_division=0)),
        "recall": float(recall_score(test["target"], predictions, zero_division=0)),
        "f1": float(f1_score(test["target"], predictions, zero_division=0)),
        "roc_auc": float(roc_auc_score(test["target"], probabilities)),
        "pr_auc": float(average_precision_score(test["target"], probabilities)),
        "test_rows": int(len(test)),
        "train_rows": int(len(train)),
        "test_period_start": str(pd.Timestamp(cutoff).date()),
        "best_iteration": best_iteration,
        "at_decision_threshold": {
            "threshold": threshold,
            "precision": float(precision_score(test["target"], at_threshold, zero_division=0)),
            "recall": float(recall_score(test["target"], at_threshold, zero_division=0)),
            "f1": float(f1_score(test["target"], at_threshold, zero_division=0)),
            "false_negatives": int((~at_threshold & (test["target"].to_numpy() == 1)).sum()),
        },
    }
    calibrated, _, _ = apply_risk(risk_scale, probabilities)
    metrics["risk"] = {
        "cutoffs": risk_scale["cutoffs"],
        "brier_raw": float(brier_score_loss(test["target"], probabilities)),
        "brier_calibrated": float(brier_score_loss(test["target"], calibrated)),
        "mean_raw": float(probabilities.mean()), "mean_calibrated": float(calibrated.mean()), "observed_share": float(test["target"].mean()),
        "levels_on_test": level_table(risk_scale, test["target"], probabilities),
    }
    LOGGER.info("Calibration on the test period: Brier %.4f raw -> %.4f calibrated; mean %.3f raw, %.3f calibrated, %.3f observed.",
                metrics["risk"]["brier_raw"], metrics["risk"]["brier_calibrated"], metrics["risk"]["mean_raw"], metrics["risk"]["mean_calibrated"], metrics["risk"]["observed_share"])
    for name, row in metrics["risk"]["levels_on_test"].items():
        LOGGER.info("  %-8s %6s fires (%4.1f%%), %s really severe", name, row["fires"], row["share"] * 100,
                    "-" if row["actually_severe"] is None else f"{row['actually_severe'] * 100:.0f}%")
    if COMPARE_WITH:
        metrics["comparison"] = compare_with_previous(COMPARE_WITH, val_rows, test, val_p, probabilities, threshold)
    metrics.update(evaluate_generalization_and_calibration(model, test, feature_columns))
    metrics["blank_inputs"] = evaluate_blank_inputs(model, test, feature_columns, weather_features)
    metrics["spatial_cv"] = spatial_cv(train, feature_columns, max(50, best_iteration + 1), depth, rate, threshold)
    # The other variant on the same folds, so the derived features are always judged on identical splits.
    if USE_DERIVED_FEATURES:
        other = [c for c in feature_columns if c not in DERIVED_FEATURES]
        metrics["spatial_cv_raw_features"] = spatial_cv(train, other, max(50, best_iteration + 1), depth, rate, threshold)
        a, b = metrics["spatial_cv_raw_features"], metrics["spatial_cv"]
    else:
        other = feature_columns + [f for f in DERIVED_FEATURES if f not in feature_columns]
        metrics["spatial_cv_with_derived_features"] = spatial_cv(train, other, max(50, best_iteration + 1), depth, rate, threshold)
        a, b = metrics["spatial_cv"], metrics["spatial_cv_with_derived_features"]
    LOGGER.info("Spatial CV, raw 12 inputs vs with derived features: AUC %.4f -> %.4f, PR-AUC %.4f -> %.4f",
                a["roc_auc"]["mean"], b["roc_auc"]["mean"], a["pr_auc"]["mean"], b["pr_auc"]["mean"])

    LOGGER.info("Chronological test period begins %s.", pd.Timestamp(cutoff).date())
    LOGGER.info(
        "Accuracy: %.4f | Precision: %.4f | Recall: %.4f | F1: %.4f | ROC-AUC: %.4f",
        metrics["accuracy"], metrics["precision"], metrics["recall"], metrics["f1"], metrics["roc_auc"],
    )
    LOGGER.info("At the decision threshold %.3f: precision %.4f, recall %.4f.", threshold,
                metrics["at_decision_threshold"]["precision"], metrics["at_decision_threshold"]["recall"])
    cv = metrics["spatial_cv"]
    LOGGER.info("Spatial CV (%s folds of 5-degree blocks): AUC %.4f +/- %.4f, recall %.3f +/- %.3f, Brier %.4f +/- %.4f.",
                cv["folds"], cv["roc_auc"]["mean"], cv["roc_auc"]["std"], cv["recall"]["mean"], cv["recall"]["std"], cv["brier"]["mean"], cv["brier"]["std"])
    LOGGER.info("Classification report:\n%s", classification_report(
        test["target"], predictions, labels=[0, 1], target_names=["normal_frp", "high_frp"], zero_division=0))
    LOGGER.info("Confusion matrix [normal_frp, high_frp]:\n%s", confusion_matrix(test["target"], predictions, labels=[0, 1]))
    importances = np.asarray(model.feature_importances_, dtype=float)
    importance_total = float(importances.sum())
    if not np.isfinite(importances).all() or importance_total <= 0:
        raise ValueError("CatBoost returned invalid or zero-sum feature importances.")
    importances /= importance_total
    importance_report = sorted(zip(feature_columns, importances), key=lambda item: item[1], reverse=True)
    LOGGER.info("Feature importance:")
    for feature, importance in importance_report:
        LOGGER.info("  %s: %.4f", feature, importance)
    shap = shap_summary(model, test[feature_columns])

    output_path = MODEL_ARTIFACT_PATH
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Write to a temporary file and swap it in, so a running API never reads a
    # half-written artifact and a failed save keeps the previous model.
    temp_path = output_path.with_name(output_path.name + ".tmp")
    joblib.dump(
        {
            "model": model,
            "model_type": MODEL_TYPE,
            "training_scheme": TRAINING_SCHEME,
            "feature_columns": feature_columns,
            "derived_features": [f for f in DERIVED_FEATURES if f in feature_columns],
            "target": f"frp >= {HIGH_FRP_THRESHOLD} MW",
            "weather_features": weather_features,
            "feature_importances": {feature: float(value) for feature, value in importance_report},
            "shap_importance": shap,
            "decision_threshold": threshold,
            "threshold_selection": selection,
            "risk_scale": risk_scale,
            "metrics": metrics,
            "training_extent": training_extent(data),
            "high_frp_threshold_mw": HIGH_FRP_THRESHOLD,
            "max_weather_distance_km": MAX_WEATHER_DISTANCE_KM,
            "hyperparameters": {
                "iterations_cap": CATBOOST_ITERATIONS,
                "best_iteration": best_iteration,
                "early_stopping_rounds": CATBOOST_EARLY_STOPPING_ROUNDS,
                "depth": depth,
                "learning_rate": rate,
                "l2_leaf_reg": CATBOOST_L2_LEAF_REG,
                "auto_class_weights": "Balanced",
                "blank_augment_share": BLANK_AUGMENT_SHARE,
                "tuned": TUNE,
            },
        },
        temp_path,
        compress=3,
    )
    os.replace(temp_path, output_path)
    LOGGER.info("Saved trained model to %s", output_path)


def main():
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if MODEL_ARTIFACT_PATH.is_file() and not FORCE_RETRAIN:
        artifact = joblib.load(MODEL_ARTIFACT_PATH)
        if artifact.get("model_type") == MODEL_TYPE and artifact.get("training_scheme", "complete-rows") == TRAINING_SCHEME:
            LOGGER.info("Loaded existing %s model; ready at %s.", MODEL_TYPE, MODEL_ARTIFACT_PATH)
            return 0
        LOGGER.info("Existing model artifact is not %s (%s); retraining.", MODEL_TYPE, TRAINING_SCHEME)

    if FIRE_CHUNK_SIZE <= 0 or MAX_TRAINING_ROWS <= 0:
        LOGGER.error("FIRE_CHUNK_SIZE and MAX_TRAINING_ROWS must be positive integers.")
        return 2
    if (
        HIGH_FRP_THRESHOLD < 0
        or MAX_WEATHER_DISTANCE_KM <= 0
        or CATBOOST_ITERATIONS <= 0
        or not 1 <= CATBOOST_DEPTH <= 16
        or CATBOOST_LEARNING_RATE <= 0
        or CATBOOST_L2_LEAF_REG <= 0
    ):
        LOGGER.error(
            "FRP threshold must be non-negative, weather distance and CatBoost "
            "parameters must be positive, and CATBOOST_DEPTH must be between 1 and 16."
        )
        return 2

    schema = os.getenv("DB_SCHEMA", "public")
    engine = None
    try:
        if TRAINING_SOURCE == "csv":
            LOGGER.info("Training from the cleaned CSV files (TRAINING_SOURCE=csv).")
            weather_csv = Path(os.getenv("WEATHER_CSV_FILE", Path(CLEANED_DATA_DIR) / "cleaned_weather.csv"))
            weather_indexes, weather_features = load_weather_csv(weather_csv)
        else:
            engine = get_database_engine()
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            weather_indexes, weather_features = load_weather(engine, schema)
        sample, feature_columns = make_training_sample(
            engine, schema, weather_indexes, weather_features
        )
        if sample["target"].nunique() < 2:
            raise ValueError(
                "The matched training sample contains only one target class. "
                "Check the FRP threshold or use a broader dataset."
            )
        train_and_evaluate(sample, feature_columns)
    except SQLAlchemyError:
        LOGGER.exception(
            "Database operation failed. Check PostgreSQL availability, credentials, "
            "DB_SCHEMA, and table names."
        )
        return 1
    except (ValueError, KeyError, TypeError, FileNotFoundError) as error:
        LOGGER.error("%s", error)
        return 1
    except ModuleNotFoundError as error:
        LOGGER.error("%s", error)
        return 1
    finally:
        if engine is not None:
            engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())