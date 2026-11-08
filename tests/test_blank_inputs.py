"""Blank inputs: the model is trained on copies of rows with groups of inputs left out,
so a request that only knows where and when gets an ordinary risk, not a near-certain "severe"."""

import numpy as np
import pandas as pd

from modeling.train_model import BLANK_PATTERNS, MEASUREMENT_FEATURES, blank_augment

FEATURES = ["latitude", "longitude", "brightness", "confidence", "scan", "track", "type", "acq_time", "day_of_year", "rh2m", "prectotcorr", "gwettop"]
WEATHER = ["rh2m", "prectotcorr", "gwettop"]


def test_place_and_time_only_is_not_near_certain(client):
    payload = client.post("/api/v1/predict", json={"latitude": -12.5, "longitude": 23.4, "acq_date": "2025-08-15"}).json()
    assert 0.02 < payload["high_frp_probability"] < 0.9


def test_full_and_partial_inputs_both_score(client):
    full = {"latitude": -12.5, "longitude": 23.4, "acq_date": "2025-08-15", "acq_time": 1230, "brightness": 345.0,
            "confidence": 100, "scan": 0.45, "track": 0.39, "type": 0}
    partial = {k: v for k, v in full.items() if k not in ("brightness", "scan")}
    for body in (full, partial):
        p = client.post("/api/v1/predict", json=body).json()["high_frp_probability"]
        assert 0.0 <= p <= 1.0


def test_blank_augment_keeps_originals_and_blanks_groups():
    rng = np.random.default_rng(0)
    train = pd.DataFrame(rng.random((1000, len(FEATURES))), columns=FEATURES).assign(target=rng.integers(0, 2, 1000))
    out = blank_augment(train, FEATURES, WEATHER, share=0.5)
    assert len(out) == 1000 + sum(int(500 * part) for _, part in BLANK_PATTERNS.values())
    assert out.iloc[:1000][FEATURES].notna().all().all()          # the original rows are untouched
    copies = out.iloc[1000:]
    all_blank = copies[MEASUREMENT_FEATURES + WEATHER].isna().all(axis=1)
    assert all_blank.sum() == int(500 * BLANK_PATTERNS["place_and_time_only"][1])
    assert copies[["latitude", "longitude", "day_of_year"]].notna().all().all()   # place and time are never blanked
