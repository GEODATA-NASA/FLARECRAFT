"""Derived features, shared by training (modeling/train_model.py) and serving (api/predictor.py).

Every feature is computed from the inputs of ONE detection, so a single API request can produce it.
They are NaN-safe: a blank input gives a blank output (never an error and never a made-up value), which
keeps blank-input training consistent (see ``blank_augment``).

Not included: humidity change versus the previous day and multi-day drought trends. They need the
previous day's weather for the same place, but the weather index holds one nearest-station tree per
day, so serving would need a second lookup per fire and training a second pass over 40 million rows.
"""

import numpy as np
import pandas as pd

DERIVED_FEATURES = [
    "dryness",            # (100 - humidity) * (1 - soil wetness): high when the air and the ground are both dry
    "hot_dry",            # 1 when humidity < 30 % and soil wetness < 0.3
    "rain_class",         # 0 none (< 0.1 mm), 1 light (< 5 mm), 2 heavy
    "doy_sin", "doy_cos",  # season on a circle, so 31 Dec sits next to 1 Jan
    "abs_latitude",       # distance from the equator, the climate band
    "pixel_area",         # scan x track in km2: how much ground one pixel covers
    "brightness_per_km2",  # brightness / pixel area
]


def _col(df: pd.DataFrame, name: str) -> pd.Series:
    if name in df.columns:
        return pd.to_numeric(df[name], errors="coerce").astype(float)
    return pd.Series(np.nan, index=df.index)


def add_derived_features(df: pd.DataFrame) -> pd.DataFrame:
    """Return ``df`` with the derived columns added (overwriting any already there)."""
    out = df.copy()
    rh, wet, rain = _col(out, "rh2m"), _col(out, "gwettop"), _col(out, "prectotcorr")
    doy, lat = _col(out, "day_of_year"), _col(out, "latitude")
    scan, track, bright = _col(out, "scan"), _col(out, "track"), _col(out, "brightness")

    out["dryness"] = (100.0 - rh) * (1.0 - wet)
    both = rh.notna() & wet.notna()
    out["hot_dry"] = ((rh < 30) & (wet < 0.3)).astype(float).where(both)
    out["rain_class"] = pd.Series(np.select([rain < 0.1, rain < 5], [0.0, 1.0], default=2.0), index=out.index).where(rain.notna())
    angle = 2.0 * np.pi * doy / 365.25
    out["doy_sin"], out["doy_cos"] = np.sin(angle), np.cos(angle)
    out["abs_latitude"] = lat.abs()
    area = (scan * track).where(lambda a: a > 0)
    out["pixel_area"] = area
    out["brightness_per_km2"] = bright / area
    return out.replace([np.inf, -np.inf], np.nan)
