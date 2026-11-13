"""Compare tree-based classifiers for high-FRP fire detection events.

By default, the target is derived as ``frp >= 10 MW`` from the cleaned fire
CSV. This evaluates already-detected fires; it does not predict fire occurrence.
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    f1_score,
    make_scorer,
    mean_absolute_error,
    precision_score,
    recall_score,
)
from sklearn.model_selection import KFold, StratifiedKFold, cross_validate
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder, OneHotEncoder

LOGGER = logging.getLogger("geodata.model_comparison")
ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATA = ROOT_DIR / "cleaned_data" / "cleaned_master_fires.csv"
DEFAULT_FEATURES = (
    "latitude",
    "longitude",
    "brightness",
    "confidence",
    "scan",
    "track",
    "type",
    "acq_time",
    "day_of_year",
    "rh2m",
    "prectotcorr",
    "gwettop",
)
DATE_COLUMN = "acq_date"
FRP_COLUMN = "frp"
SAMPLE_PRIORITY_COLUMN = "__sample_priority__"


def parse_args() -> argparse.Namespace:
    """Parse command-line options for data, target, sampling, and CV."""
    parser = argparse.ArgumentParser(
        description=(
            "Compare Random Forest, XGBoost, and CatBoost with cross-validation. "
            "The default target is high_frp (FRP >= 10 MW)."
        )
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="Input CSV path.")
    parser.add_argument(
        "--task",
        choices=("classification", "regression"),
        default="classification",
        help="Evaluation task. Regression can use --target-column frp.",
    )
    parser.add_argument(
        "--target-column",
        default="high_frp",
        help=(
            "Target column. If high_frp is absent for classification and frp exists, "
            "it is derived from the FRP threshold."
        ),
    )
    parser.add_argument(
        "--frp-threshold",
        type=float,
        default=10.0,
        help="Threshold in MW for the derived high_frp classification target.",
    )
    parser.add_argument(
        "--feature-columns",
        help=(
            "Optional comma-separated feature list. Defaults to available project "
            "fire/weather features; FRP and the target are never used as predictors."
        ),
    )
    parser.add_argument(
        "--folds",
        type=int,
        default=5,
        help="Number of cross-validation folds (default: 5).",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=500_000,
        help="Uniform random row cap for large CSVs; use 0 to process every row.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=100_000,
        help="CSV rows read at a time.",
    )
    parser.add_argument("--random-state", type=int, default=42, help="Random seed.")
    return parser.parse_args()


def _resolve_features(
    columns: list[str], requested_features: str | None, target_column: str
) -> list[str]:
    if requested_features:
        features = [name.strip() for name in requested_features.split(",") if name.strip()]
        missing = sorted(
            set(features)
            - set(columns)
            - {DATE_COLUMN}
            - ({"day_of_year"} if DATE_COLUMN in columns else set())
        )
        if missing:
            raise ValueError(f"Requested feature columns are missing from the CSV: {missing}")
    else:
        features = [name for name in DEFAULT_FEATURES if name in columns]

    features = [
        name for name in features if name not in {target_column, FRP_COLUMN, DATE_COLUMN}
    ]
    if DATE_COLUMN in columns and "day_of_year" in (
        features if requested_features else DEFAULT_FEATURES
    ):
        features.append("day_of_year")
    if not features:
        raise ValueError(
            "No usable feature columns were found. Pass --feature-columns to select "
            "columns available in the input CSV."
        )
    return list(dict.fromkeys(features))


def load_dataset(
    data_path: Path,
    target_column: str,
    task: str,
    frp_threshold: float,
    feature_columns: str | None,
    max_rows: int,
    chunk_size: int,
    random_state: int,
) -> tuple[pd.DataFrame, pd.Series, bool]:
    """Load selected columns in chunks and optionally keep a uniform random sample."""
    if not data_path.is_file():
        raise FileNotFoundError(f"Input CSV does not exist: {data_path}")

    columns = [str(column).strip() for column in pd.read_csv(data_path, nrows=0).columns]
    has_target = target_column in columns
    derive_high_frp = (
        not has_target
        and task == "classification"
        and target_column in {"high_frp", "target"}
        and FRP_COLUMN in columns
    )
    if not has_target and not derive_high_frp:
        raise ValueError(
            f"Target column {target_column!r} is not present. For this fire dataset, "
            "use --target-column high_frp to derive it from frp, or choose an "
            "existing target column."
        )

    features = _resolve_features(columns, feature_columns, target_column)
    if "day_of_year" in features and "day_of_year" not in columns and DATE_COLUMN not in columns:
        raise ValueError(
            "day_of_year is selected as a feature, but neither day_of_year nor "
            f"{DATE_COLUMN} exists in the CSV."
        )

    read_columns = [name for name in features if name in columns]
    if has_target:
        read_columns.append(target_column)
    if derive_high_frp:
        read_columns.append(FRP_COLUMN)
    if DATE_COLUMN in columns and "day_of_year" in features:
        read_columns.append(DATE_COLUMN)
    read_columns = list(dict.fromkeys(read_columns))

    rng = np.random.default_rng(random_state)
    sampled = pd.DataFrame()
    rows_seen = 0
    for chunk in pd.read_csv(
        data_path,
        usecols=read_columns,
        chunksize=chunk_size,
        low_memory=False,
    ):
        chunk.columns = [str(name).strip() for name in chunk.columns]
        if "day_of_year" in features and "day_of_year" not in chunk:
            chunk["day_of_year"] = pd.to_datetime(
                chunk[DATE_COLUMN], errors="coerce"
            ).dt.dayofyear

        if derive_high_frp:
            frp = pd.to_numeric(chunk[FRP_COLUMN], errors="coerce")
            chunk[target_column] = (frp >= frp_threshold).where(frp.notna())

        labels = chunk[target_column]
        valid_labels = labels.notna()
        chunk = chunk.loc[valid_labels, features + [target_column]].copy()
        if chunk.empty:
            continue

        rows_seen += len(chunk)
        if max_rows:
            chunk[SAMPLE_PRIORITY_COLUMN] = rng.random(len(chunk))
            sampled = pd.concat([sampled, chunk], ignore_index=True)
            if len(sampled) > max_rows:
                sampled = sampled.nsmallest(max_rows, SAMPLE_PRIORITY_COLUMN)
        else:
            sampled = pd.concat([sampled, chunk], ignore_index=True)

    if sampled.empty:
        raise ValueError("No rows with a valid target were found in the input CSV.")
    if max_rows:
        sampled = sampled.drop(columns=SAMPLE_PRIORITY_COLUMN)

    labels = sampled.pop(target_column)
    if task == "classification":
        encoder = LabelEncoder()
        encoded_labels = np.asarray(encoder.fit_transform(labels), dtype=np.int8)
        y = pd.Series(
            encoded_labels,
            name=target_column,
            dtype="int8",
        )
        if len(encoder.classes_) != 2:
            raise ValueError(
                "Classification currently requires exactly two target classes; "
                f"found {len(encoder.classes_)}: {encoder.classes_.tolist()}."
            )
        LOGGER.info(
            "Positive class for ROC-AUC/precision/recall/F1: %r",
            encoder.classes_[1],
        )
    else:
        y = pd.to_numeric(labels, errors="coerce")
        valid = y.notna()
        sampled = sampled.loc[valid].copy()
        y = y.loc[valid]
        if y.empty:
            raise ValueError("The regression target has no valid numeric values.")

    sampled = sampled.replace([np.inf, -np.inf], np.nan)
    for column in sampled.select_dtypes(include="number").columns:
        sampled[column] = pd.to_numeric(sampled[column], errors="coerce")

    LOGGER.info(
        "Loaded %s valid rows from %s (read %s valid target rows); features: %s",
        len(sampled),
        data_path,
        rows_seen,
        ", ".join(sampled.columns),
    )
    return sampled, y.reset_index(drop=True), derive_high_frp


def make_preprocessor(X: pd.DataFrame) -> ColumnTransformer:
    """Impute missing values and one-hot encode categorical inputs."""
    categorical_pipeline = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="constant", fill_value="__missing__")),
            ("encoder", OneHotEncoder(handle_unknown="ignore")),
        ]
    )
    numeric_features = list(X.select_dtypes(include="number").columns)
    categorical_features = list(X.select_dtypes(exclude="number").columns)
    transformers: list[tuple[str, Any, list[str]]] = []
    if numeric_features:
        transformers.append(
            (
                "numeric",
                SimpleImputer(strategy="median", keep_empty_features=True),
                numeric_features,
            )
        )
    if categorical_features:
        transformers.append(
            ("categorical", categorical_pipeline, categorical_features)
        )
    return ColumnTransformer(
        transformers=transformers,
        remainder="drop",
    )


def make_models(task: str, random_state: int) -> dict[str, Any]:
    """Create standard baseline estimators; adjust these settings when tuning."""
    try:
        from catboost import CatBoostClassifier, CatBoostRegressor
        from xgboost import XGBClassifier, XGBRegressor
    except ModuleNotFoundError as error:
        raise ModuleNotFoundError(
            "Model comparison requires xgboost and catboost. Install project "
            "dependencies with: pip install -r requirements.txt"
        ) from error

    if task == "classification":
        # Increase n_estimators for more trees; lower min_samples_leaf to let the
        # forest learn finer patterns. max_depth caps tree complexity.
        random_forest = RandomForestClassifier(
            n_estimators=300,
            max_features="sqrt",
            min_samples_leaf=2,
            max_depth=None,
            class_weight="balanced_subsample",
            random_state=random_state,
            n_jobs=-1,
        )
        # Tune max_depth, learning_rate, and n_estimators together; subsample and
        # colsample_bytree can reduce overfitting. Keep tree_method="hist" for speed.
        xgboost = XGBClassifier(
            n_estimators=400,
            max_depth=6,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="binary:logistic",
            eval_metric="logloss",
            tree_method="hist",
            random_state=random_state,
            n_jobs=-1,
        )
        # Tune depth, iterations, and learning_rate; CatBoost's automatic class
        # weights provide a sensible baseline for an imbalanced binary target.
        catboost = CatBoostClassifier(
            iterations=500,
            depth=6,
            learning_rate=0.05,
            loss_function="Logloss",
            eval_metric="AUC",
            auto_class_weights="Balanced",
            random_seed=random_state,
            thread_count=-1,
            verbose=False,
            allow_writing_files=False,
        )
    else:
        # For regression, max_depth and min_samples_leaf control forest variance.
        random_forest = RandomForestRegressor(
            n_estimators=300,
            max_features=1.0,
            min_samples_leaf=2,
            max_depth=None,
            random_state=random_state,
            n_jobs=-1,
        )
        # Reduce learning_rate and raise n_estimators to trade training time for
        # a more gradual boosting fit; regularization can be added if needed.
        xgboost = XGBRegressor(
            n_estimators=400,
            max_depth=6,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="reg:squarederror",
            eval_metric="rmse",
            tree_method="hist",
            random_state=random_state,
            n_jobs=-1,
        )
        # Tune depth, iterations, and learning_rate; a smaller learning rate
        # usually benefits from more iterations.
        catboost = CatBoostRegressor(
            iterations=500,
            depth=6,
            learning_rate=0.05,
            loss_function="RMSE",
            random_seed=random_state,
            thread_count=-1,
            verbose=False,
            allow_writing_files=False,
        )

    return {
        "Random Forest": random_forest,
        "XGBoost": xgboost,
        "CatBoost": catboost,
    }


def evaluate_models(
    X: pd.DataFrame,
    y: pd.Series,
    task: str,
    folds: int,
    random_state: int,
) -> tuple[dict[str, dict[str, tuple[float, float]]], str, bool]:
    """Run fold-level evaluation and return mean/std metrics for every model."""
    if len(X) != len(y):
        raise ValueError("Feature and target row counts do not match.")
    if len(X) < folds:
        raise ValueError(f"Need at least {folds} rows for {folds}-fold CV.")

    if task == "classification":
        class_counts = y.value_counts()
        if len(class_counts) != 2 or int(class_counts.min()) < folds:
            raise ValueError(
                "Each binary class must have at least one row per CV fold; "
                f"class counts are {class_counts.to_dict()}."
            )
        splitter = StratifiedKFold(
            n_splits=folds, shuffle=True, random_state=random_state
        )
        scoring = {
            "accuracy": "accuracy",
            "precision": make_scorer(precision_score, zero_division=0),
            "recall": make_scorer(recall_score, zero_division=0),
            "f1": make_scorer(f1_score, zero_division=0),
            "roc_auc": "roc_auc",
        }
        best_metric = "f1"
        lower_is_better = False
    else:
        splitter = KFold(n_splits=folds, shuffle=True, random_state=random_state)
        scoring = {
            "mae": make_scorer(mean_absolute_error, greater_is_better=False),
            "rmse": "neg_root_mean_squared_error",
            "r2": "r2",
        }
        best_metric = "rmse"
        lower_is_better = True

    preprocessor = make_preprocessor(X)
    results: dict[str, dict[str, tuple[float, float]]] = {}
    models = make_models(task, random_state)
    for model_name, model in models.items():
        LOGGER.info("Evaluating %s with %s-fold CV.", model_name, folds)
        scores = cross_validate(
            Pipeline(
                steps=[
                    ("preprocessor", preprocessor),
                    ("model", model),
                ]
            ),
            X,
            y,
            cv=splitter,
            scoring=scoring,
            n_jobs=1,
            error_score="raise",
            return_train_score=False,
        )
        model_results: dict[str, tuple[float, float]] = {}
        for metric in scoring:
            fold_scores = scores[f"test_{metric}"]
            if task == "regression":
                fold_scores = -fold_scores
            model_results[metric] = (
                float(np.mean(fold_scores)),
                float(np.std(fold_scores, ddof=1)) if len(fold_scores) > 1 else 0.0,
            )
        results[model_name] = model_results

    return results, best_metric, lower_is_better


def print_summary(
    summary: dict[str, dict[str, tuple[float, float]]],
    best_metric: str,
    lower_is_better: bool,
) -> None:
    """Print a compact mean ± standard-deviation table and identify the winner."""
    metric_names = list(next(iter(summary.values())))
    rows = [
        [
            model_name,
            *[
                f"{metrics[name][0]:.4f} +/- {metrics[name][1]:.4f}"
                for name in metric_names
            ],
        ]
        for model_name, metrics in summary.items()
    ]
    headers = ["Model", *(name.upper() for name in metric_names)]
    widths = [
        max(len(header), *(len(row[index]) for row in rows))
        for index, header in enumerate(headers)
    ]
    print("\nCross-validation results (mean +/- standard deviation):")
    print(" | ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
    print("-+-".join("-" * width for width in widths))
    for row in rows:
        print(" | ".join(value.ljust(widths[index]) for index, value in enumerate(row)))

    winner = (
        min(summary, key=lambda model_name: summary[model_name][best_metric][0])
        if lower_is_better
        else max(summary, key=lambda model_name: summary[model_name][best_metric][0])
    )
    value, deviation = summary[winner][best_metric]
    direction = "lower" if lower_is_better else "higher"
    print(
        f"\nBest by {best_metric.upper()} ({direction} is better): {winner} "
        f"({value:.4f} +/- {deviation:.4f})"
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = parse_args()
    try:
        if args.folds < 2:
            raise ValueError("--folds must be at least 2.")
        if args.max_rows < 0:
            raise ValueError("--max-rows must be 0 (all rows) or a positive integer.")
        if args.chunk_size < 1:
            raise ValueError("--chunk-size must be a positive integer.")
        if args.frp_threshold < 0:
            raise ValueError("--frp-threshold must be non-negative.")

        X, y, derived_target = load_dataset(
            data_path=args.data,
            target_column=args.target_column,
            task=args.task,
            frp_threshold=args.frp_threshold,
            feature_columns=args.feature_columns,
            max_rows=args.max_rows,
            chunk_size=args.chunk_size,
            random_state=args.random_state,
        )
        if derived_target:
            LOGGER.info(
                "Derived binary target %s from %s >= %.2f MW.",
                args.target_column,
                FRP_COLUMN,
                args.frp_threshold,
            )
        summary, best_metric, lower_is_better = evaluate_models(
            X, y, args.task, args.folds, args.random_state
        )
    except (FileNotFoundError, ValueError, ModuleNotFoundError) as error:
        LOGGER.error("%s", error)
        return 2

    print_summary(summary, best_metric, lower_is_better)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
