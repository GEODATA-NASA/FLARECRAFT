"""Fire Risk Score (0-100) and its Low / Medium / High / Extreme levels.

The classifier is trained with balanced class weights, so its raw probability runs high (on the hold-out its
average is well above the true share of severe fires). The score therefore comes from a calibrated probability:
an isotonic regression fitted on the validation slice (the last dates of the training period, never the test
period), so a score of 30 means about 30% of such fires turned out severe.

Levels are tied to measured cut-offs rather than round numbers:
  * Medium  from half the typical severe share in the validation slice
  * High    from the recall-first decision threshold (the point where the model flags a fire)
  * Extreme from a calibrated chance of 50% (more likely severe than not)

Training (modeling/train_model.py) and serving (api/predictor.py) both call ``apply_risk``.
"""

import numpy as np
from sklearn.isotonic import IsotonicRegression

LEVELS = ("Low", "Medium", "High", "Extreme")


def fit_risk(y_validation, p_validation, decision_threshold):
    """Fit the calibration and the level cut-offs on the validation slice. Returns a picklable dict."""
    y = np.asarray(y_validation, dtype=float)
    p = np.asarray(p_validation, dtype=float)
    calibrator = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(p, y)
    base = float(y.mean())
    high = float(calibrator.predict([decision_threshold])[0])
    medium = min(base / 2, high * 0.75)
    extreme = max(0.5, high + 0.05)
    return {
        "calibrator": calibrator,
        "cutoffs": {"Medium": round(medium * 100, 1), "High": round(high * 100, 1), "Extreme": round(extreme * 100, 1)},
        "base_rate": base,
        "decision_threshold": float(decision_threshold),
        "method": "isotonic regression on the validation slice",
    }


def apply_risk(scale, probabilities):
    """Raw model probabilities -> (calibrated chance, score 0-100, level). NaN probabilities give NaN / None."""
    p = np.asarray(probabilities, dtype=float)
    calibrated = np.full(p.shape, np.nan)
    ok = np.isfinite(p)
    if ok.any():
        calibrated[ok] = scale["calibrator"].predict(p[ok])
    score = np.round(calibrated * 100, 1)
    cut = scale["cutoffs"]
    levels = np.where(~ok, None, np.where(score >= cut["Extreme"], "Extreme", np.where(score >= cut["High"], "High",
                      np.where(score >= cut["Medium"], "Medium", "Low"))))
    return calibrated, score, levels


def level_table(scale, y_true, probabilities):
    """How each level behaved on a labelled set: share of fires and how many were really severe."""
    _, score, levels = apply_risk(scale, probabilities)
    y = np.asarray(y_true)
    table = {}
    for name in LEVELS:
        mask = levels == name
        table[name] = {"fires": int(mask.sum()), "share": float(mask.mean()),
                       "actually_severe": float(y[mask].mean()) if mask.any() else None}
    return table
