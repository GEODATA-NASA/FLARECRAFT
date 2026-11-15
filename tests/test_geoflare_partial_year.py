"""GeoFlare History with a running year: unseen weeks stay unknown, and normal/trends use complete years only."""

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd

# GeoFlare's api package shares its name with GeoData's, so load the module by path.
_spec = importlib.util.spec_from_file_location("geoflare_analytics", Path(__file__).resolve().parents[1] / "geoflare" / "api" / "analytics.py")
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
analyse = _module.analyse


def test_running_year_is_shown_but_not_counted_as_normal():
    rows = []
    for year in range(2003, 2027):
        for week in range(52):
            seen = not (year == 2026 and week > 44)
            value = 100.0 + 50 * np.sin(week / 52 * 2 * np.pi) if seen else np.nan
            rows.append({"year": year, "week": week, "modis": value if seen else np.nan, "viirs": value if year >= 2012 else np.nan,
                         "viirs_j1": np.nan, "recon": value, "modis_ind": 0.0 if seen else np.nan, "viirs_ind": 0.0 if seen else np.nan})
    report = {"partial": {"year": 2026, "last_week": 44, "through": "2026-11-11", "data_until": "2026-11-13"}}
    out = analyse(pd.DataFrame(rows), report, viirs_start=2012)

    assert out["climatology_years"][-1] == 2025 and 2026 in out["years"]
    row = out["calendar"]["values"][out["years"].index(2026)]
    assert row[44] is not None and row[45] is None and out["calendar"]["anomaly"][-1][51] is None
    assert out["partial"] == {"year": 2026, "last_week": 44, "through": "2026-11-11"}
    assert not any(m["year"] == 2026 and m["month"] >= 10 for m in out["unusual_months"] + out["quiet_months"])
    assert 2026 not in out["season_by_year"]
