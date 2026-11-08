"""Derived features (NaN-safe, same code in training and serving), the saved decision threshold, and SHAP in /model."""

import numpy as np
import pandas as pd
import pytest

from modeling.features import DERIVED_FEATURES, add_derived_features
from modeling.train_model import pick_threshold, spatial_groups

FULL = {"latitude": -12.5, "longitude": 23.4, "day_of_year": 227.0, "brightness": 340.0, "scan": 0.5, "track": 0.4,
        "rh2m": 20.0, "gwettop": 0.1, "prectotcorr": 0.0}


def test_derived_features_are_computed_from_one_row():
    out = add_derived_features(pd.DataFrame([FULL])).iloc[0]
    assert out["dryness"] == (100 - 20) * (1 - 0.1)
    assert out["hot_dry"] == 1.0 and out["rain_class"] == 0.0
    assert abs(out["pixel_area"] - 0.2) < 1e-9 and abs(out["brightness_per_km2"] - 1700) < 1e-6
    assert abs(out["doy_sin"] ** 2 + out["doy_cos"] ** 2 - 1) < 1e-9 and out["abs_latitude"] == 12.5


def test_derived_features_stay_blank_when_inputs_are_blank():
    row = {**FULL, "rh2m": np.nan, "gwettop": np.nan, "prectotcorr": np.nan, "scan": np.nan, "brightness": np.nan}
    out = add_derived_features(pd.DataFrame([row])).iloc[0]
    for name in ("dryness", "hot_dry", "rain_class", "pixel_area", "brightness_per_km2"):
        assert np.isnan(out[name]), name
    assert not np.isnan(out["doy_sin"]) and not np.isnan(out["abs_latitude"])
    assert not np.isinf(add_derived_features(pd.DataFrame([{**FULL, "scan": 0.0}])).iloc[0]["brightness_per_km2"])
    assert add_derived_features(pd.DataFrame([{"latitude": 1.0}])).shape[0] == 1   # missing columns are fine too


def test_serving_builds_the_same_derived_features_as_training(client):
    from api.predictor import SeverityPredictor
    predictor = client.app.state.runtime.predictor
    if not set(DERIVED_FEATURES) <= set(predictor.feature_columns):
        pytest.skip("the installed model artifact was trained before the derived features existed")
    fires = pd.DataFrame([{"latitude": 30.0, "longitude": 31.0, "acq_date": "2025-01-02", "brightness": 330.0, "scan": 0.4, "track": 0.4,
                           "rh2m": 20.0, "gwettop": 0.1, "prectotcorr": 0.0}])
    served = predictor.build_features(fires, None)
    expected = add_derived_features(served[[c for c in predictor.feature_columns if c not in DERIVED_FEATURES]])
    for name in DERIVED_FEATURES:
        assert np.allclose(served[name].astype(float), expected[name].astype(float), equal_nan=True), name


def test_pick_threshold_reaches_target_recall():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 5000)
    p = np.clip(0.35 * y + rng.random(5000) * 0.65, 0, 1)
    threshold, info = pick_threshold(y, p)
    assert info["validation_recall"] >= 0.85 and 0.01 <= threshold <= 0.99
    assert ((p >= threshold) & (y == 1)).sum() / y.sum() >= 0.85


def test_spatial_groups_follow_five_degree_blocks():
    g = spatial_groups(pd.DataFrame({"latitude": [0.0, 4.9, 5.1], "longitude": [0.0, 4.9, 0.0]}))
    assert g[0] == g[1] != g[2]


def test_artifact_threshold_is_used_and_env_override_wins(client, tmp_path):
    import joblib
    from api.predictor import SeverityPredictor
    predictor = client.app.state.runtime.predictor
    saved = joblib.load(predictor.model_path).get("decision_threshold")
    if saved is not None:
        assert abs(predictor.decision_threshold - saved) < 1e-9
    forced = SeverityPredictor(predictor.model_path, 10.0, 0.37).load()
    assert forced.decision_threshold == 0.37


def test_model_info_exposes_shap_and_threshold(client):
    info = client.get("/api/v1/model").json()
    if not info.get("shap_importance"):
        pytest.skip("the installed model artifact was trained before SHAP was stored")
    assert info["shap_importance"] and abs(sum(info["shap_importance"].values()) - 1) < 1e-6
    assert 0 < info["decision_threshold"] < 1
