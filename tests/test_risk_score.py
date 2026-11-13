"""Fire Risk Score: calibrated 0-100 score with Low / Medium / High / Extreme levels."""

import numpy as np
import pytest

from modeling.risk import LEVELS, apply_risk, fit_risk, level_table


def _scale(seed=0):
    rng = np.random.default_rng(seed)
    p = rng.random(5000)
    y = (rng.random(5000) < p * 0.6).astype(int)      # raw scores run high, like a balanced-weight model
    return fit_risk(y, p, decision_threshold=0.45), y, p


def test_scores_are_calibrated_and_levels_ordered():
    scale, y, p = _scale()
    calibrated, score, levels = apply_risk(scale, p)
    assert abs(calibrated.mean() - y.mean()) < 0.02                 # calibrated mean matches the observed share
    assert 0 <= score.min() and score.max() <= 100
    cut = scale["cutoffs"]
    assert cut["Medium"] < cut["High"] < cut["Extreme"]
    order = {name: i for i, name in enumerate(LEVELS)}
    ranked = [order[level] for _, level in sorted(zip(score, levels))]
    assert ranked == sorted(ranked)                                  # a higher score never gets a lower level


def test_blank_probability_gives_no_score():
    scale, _, _ = _scale()
    _, score, levels = apply_risk(scale, [np.nan, 0.9])
    assert np.isnan(score[0]) and levels[0] is None and levels[1] in LEVELS


def test_levels_mean_more_severe_fires_as_they_rise():
    scale, y, p = _scale(1)
    table = level_table(scale, y, p)
    rates = [table[name]["actually_severe"] for name in LEVELS if table[name]["fires"]]
    assert rates == sorted(rates)


def test_api_returns_risk_when_the_model_has_a_scale(client):
    payload = client.post("/api/v1/predict", json={"latitude": -12.5, "longitude": 23.4, "acq_date": "2025-08-15", "brightness": 345, "scan": 0.4, "track": 0.4}).json()
    info = client.get("/api/v1/model").json()
    if not info.get("risk_levels"):
        pytest.skip("the installed model predates the risk score")
    assert 0 <= payload["risk_score"] <= 100 and payload["risk_level"] in LEVELS


def test_model_info_exposes_risk_cutoffs(client):
    """The /api/v1/model response schema must not drop the risk cut-offs the frontends read."""
    import joblib
    from api.settings import Settings
    artifact = joblib.load(Settings().model_path) if Settings().model_path.is_file() else {}
    if not artifact.get("risk_scale"):
        pytest.skip("the installed model predates the risk score")
    info = client.get("/api/v1/model").json()
    assert set(info["risk_levels"]["cutoffs"]) == {"Medium", "High", "Extreme"}
