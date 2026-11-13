"""Turn an area's weekly series into a burning-activity calendar with the questions users ask:
when is the season, what is normal, what was unusual, is it changing, and how sure are we."""

import datetime as dt

import numpy as np
import pandas as pd
from scipy import stats

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
FIRST_FULL_YEAR = 2003  # Aqua MODIS joined in mid-2002; earlier years lack the afternoon overpass


def week_label(week):
    start = dt.date(2001, 1, 1) + dt.timedelta(days=int(week) * 7)
    return f"{start.day} {MONTHS[start.month - 1]}"


def band_from_table(pred, table):
    pred = np.asarray(pred, dtype="float64")
    if not table:
        return pred * 0.7, pred * 1.4
    lo, hi = np.empty_like(pred), np.empty_like(pred)
    edges = [row["hi"] for row in table]
    idx = np.clip(np.searchsorted(edges, pred, side="right"), 0, len(table) - 1)
    q10 = np.array([table[i]["q10"] for i in idx])
    q90 = np.array([table[i]["q90"] for i in idx])
    lo, hi = (pred + 1) * q10 - 1, (pred + 1) * q90 - 1
    return np.clip(lo, 0, None), np.maximum(hi, pred)


def harmonize(frame, viirs_start):
    """VIIRS-equivalent weekly activity: observed S-NPP from viirs_start, reconstructed before."""
    observed = frame.year >= viirs_start
    value = np.where(observed, frame.viirs.fillna(0), frame.recon)
    return pd.Series(value, index=frame.index), observed


def season(curve):
    """Start / peak / end weeks of a 52-week activity curve, robust to seasons crossing New Year."""
    curve = np.asarray(curve, dtype="float64")
    if curve.sum() <= 0:
        return None
    smooth = np.convolve(np.r_[curve[-2:], curve, curve[:2]], np.ones(5) / 5, mode="valid")
    trough = int(np.argmin(smooth))
    order = (np.arange(52) + trough) % 52  # start the cycle at the quietest week
    cum = np.cumsum(curve[order]) / curve.sum()
    start = int(order[np.searchsorted(cum, 0.10)])
    end = int(order[min(np.searchsorted(cum, 0.90), 51)])
    peak = int(np.argmax(smooth))
    critical = [int(w) for w in np.flatnonzero(smooth >= 0.5 * smooth.max())]
    return {"start": start, "peak": peak, "end": end, "critical_weeks": critical,
            "label": f"{week_label(start)} - {week_label(end)}", "peak_label": week_label(peak),
            "trough": trough}


def trend(years, totals):
    years, totals = np.asarray(years, float), np.asarray(totals, float)
    if len(years) < 6 or totals.mean() <= 0:
        return None
    slope, intercept, lo, hi = stats.theilslopes(totals, years)
    tau, p = stats.kendalltau(years, totals)
    mean = totals.mean()
    return {"slope_per_year": float(slope), "pct_per_year": float(100 * slope / mean),
            "pct_per_decade": float(1000 * slope / mean), "ci_pct_per_year": [float(100 * lo / mean), float(100 * hi / mean)],
            "kendall_tau": float(tau), "p_value": float(p), "significant": bool(p < 0.05),
            "line": [float(intercept + slope * years[0]), float(intercept + slope * years[-1])]}


def analyse(frame, report, viirs_start, today=None):
    calib = report.get("calibration", {})
    frame = frame[frame.year >= FIRST_FULL_YEAR].reset_index(drop=True)
    years = sorted(frame.year.unique())
    harm, observed = harmonize(frame, viirs_start)
    frame = frame.assign(harm=harm, observed=observed)

    # Uncertainty: reconstructed weeks use the empirical calibration of held-out years;
    # observed weeks use the spread between the two VIIRS instruments (or Poisson noise).
    lo, hi = band_from_table(frame.harm, calib.get("week", []))
    if "viirs_j1" in frame:
        j1 = frame.viirs_j1
        both = observed & j1.notna()
        obs_lo = np.where(both, np.minimum(frame.harm, j1), frame.harm - 1.28 * np.sqrt(frame.harm))
        obs_hi = np.where(both, np.maximum(frame.harm, j1), frame.harm + 1.28 * np.sqrt(frame.harm))
    else:
        obs_lo, obs_hi = frame.harm - 1.28 * np.sqrt(frame.harm), frame.harm + 1.28 * np.sqrt(frame.harm)
    frame["lo"] = np.where(observed, np.clip(obs_lo, 0, None), lo)
    frame["hi"] = np.where(observed, obs_hi, hi)

    grid = frame.pivot(index="year", columns="week", values="harm").reindex(years)
    complete = [y for y in years if (frame[frame.year == y].modis.sum() > 0 or frame[frame.year == y].viirs.fillna(0).sum() > 0)]
    clim_years = [y for y in complete if y < (today or dt.date.today()).year]
    clim = grid.loc[clim_years] if clim_years else grid
    median = clim.median().to_numpy()
    p10, p90 = clim.quantile(0.10).to_numpy(), clim.quantile(0.90).to_numpy()
    mad = (clim - clim.median()).abs().median().to_numpy()

    # Annual totals: harmonized vs the naive stitched record vs MODIS alone.
    annual = frame.groupby("year").agg(harm=("harm", "sum"), modis=("modis", "sum"), viirs=("viirs", "sum"),
                                       recon=("recon", "sum"), observed=("observed", "all"),
                                       ind=("modis_ind", "sum"), viirs_ind=("viirs_ind", "sum")).reindex(years)
    naive = np.where(annual.index >= viirs_start, annual.viirs, annual.modis)
    a_lo, a_hi = band_from_table(annual.harm, calib.get("year", []))
    a_lo = np.where(annual.observed, annual.harm * 0.97, a_lo)
    a_hi = np.where(annual.observed, annual.harm * 1.03, a_hi)
    trend_years = [y for y in clim_years]
    sel = annual.index.isin(trend_years)
    trends = {
        "harmonized": trend(annual.index[sel], annual.harm[sel]),
        "naive": trend(annual.index[sel], naive[sel]),
        "modis_only": trend(annual.index[sel], annual.modis[sel]),
    }
    jump = None
    pre = annual[(annual.index < viirs_start) & annual.index.isin(clim_years)]
    post = annual[(annual.index >= viirs_start) & annual.index.isin(clim_years)]
    if len(pre) and len(post) and pre.modis.mean() > 0:
        jump = {"naive_ratio": float(post.viirs.mean() / pre.modis.mean()),
                "harmonized_ratio": float(post.harm.mean() / max(pre.harm.mean(), 1e-9))}

    # Unusual months: monthly totals against that month's climatology.
    frame["month"] = np.minimum(frame.week * 12 // 52, 11)
    monthly = frame.groupby(["year", "month"]).agg(harm=("harm", "sum"), lo=("lo", "sum"), hi=("hi", "sum")).reset_index()
    mclim = monthly[monthly.year.isin(clim_years)].groupby("month").harm.agg(["median", lambda s: (s - s.median()).abs().median()])
    mclim.columns = ["median", "mad"]
    monthly = monthly.join(mclim, on="month")
    monthly["ratio"] = monthly.harm / monthly["median"].clip(lower=1)
    monthly["z"] = (monthly.harm - monthly["median"]) / (1.4826 * monthly["mad"] + np.sqrt(monthly["median"] + 1))
    unusual = monthly[(monthly.z > 2.5) & (monthly.ratio >= 1.3) & (monthly.harm >= 20)].sort_values("z", ascending=False).head(8)
    quiet = monthly[(monthly.z < -1.5) & (monthly["median"] >= 50)].sort_values("z").head(4)

    season_clim = season(median)
    per_year = {}
    for y in years:
        s = season(grid.loc[y].to_numpy())
        if s:
            per_year[int(y)] = {k: s[k] for k in ("start", "peak", "end")}
    peak_trend = None
    if season_clim and len(per_year) >= 8:
        trough = season_clim["trough"]
        ys = [y for y in per_year if y in clim_years]
        shifted = [((per_year[y]["start"] - trough) % 52) for y in ys]
        peak_trend = trend(ys, np.array(shifted) + 1)  # +1 keeps the mean positive for % maths

    outlook = None
    if season_clim:
        now = today or dt.date.today()
        week_now = min((now.timetuple().tm_yday - 1) // 7, 51)
        upcoming = [(week_now + i) % 52 for i in range(4)]
        expected = float(sum(median[w] for w in upcoming))
        share = expected / max(median.sum(), 1e-9)
        outlook = {"weeks": upcoming, "expected": expected, "share_of_year": float(share),
                   "in_critical": any(w in season_clim["critical_weeks"] for w in upcoming),
                   "label": f"{week_label(upcoming[0])} - {week_label((upcoming[-1] + 1) % 52)}"}

    ranks = annual.harm[annual.index.isin(clim_years)].rank(ascending=False)
    insights = narrative(annual, clim_years, trends, jump, season_clim, unusual, outlook, ranks, peak_trend, viirs_start)

    return {
        "years": [int(y) for y in years],
        "viirs_start": int(viirs_start),
        "climatology_years": [int(y) for y in clim_years],
        "calendar": {
            "values": np.round(grid.fillna(0).to_numpy(), 2).tolist(),
            "observed": [bool(y >= viirs_start) for y in years],
            "anomaly": np.round(((grid - median) / (1.4826 * mad + np.sqrt(median + 1))).fillna(0).to_numpy(), 2).tolist(),
        },
        "weekly": {
            "lo": np.round(frame.pivot(index="year", columns="week", values="lo").reindex(years).fillna(0).to_numpy(), 2).tolist(),
            "hi": np.round(frame.pivot(index="year", columns="week", values="hi").reindex(years).fillna(0).to_numpy(), 2).tolist(),
        },
        "climatology": {"median": np.round(median, 2).tolist(), "p10": np.round(p10, 2).tolist(), "p90": np.round(p90, 2).tolist()},
        "annual": {
            "harmonized": np.round(annual.harm.to_numpy(), 1).tolist(),
            "lo": np.round(a_lo, 1).tolist(), "hi": np.round(a_hi, 1).tolist(),
            "modis": annual.modis.round(1).tolist(), "viirs": [None if np.isnan(x) else round(float(x), 1) for x in annual.viirs.where(annual.index >= viirs_start)],
            "naive": np.round(naive, 1).tolist(),
            "reconstructed": np.round(annual.recon.to_numpy(), 1).tolist(),
            "industrial": [round(float(v if y >= viirs_start else m), 1) for y, v, m in zip(annual.index, annual.viirs_ind.fillna(0), annual.ind)],
        },
        "season": season_clim, "season_by_year": per_year, "season_shift": peak_trend,
        "trends": trends, "jump": jump,
        "unusual_months": [month_row(r) for r in unusual.itertuples()],
        "quiet_months": [month_row(r) for r in quiet.itertuples()],
        "outlook": outlook,
        "insights": insights,
    }


def month_row(r):
    return {"year": int(r.year), "month": int(r.month), "label": f"{MONTHS[int(r.month)]} {int(r.year)}",
            "value": round(float(r.harm), 1), "normal": round(float(r.median), 1),
            "ratio": round(float(r.ratio), 2), "z": round(float(r.z), 2)}


def fmt(n):
    n = float(n)
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.1f}k" if n >= 1e4 else f"{n:,.0f}"


def narrative(annual, clim_years, trends, jump, season_clim, unusual, outlook, ranks, peak_trend, viirs_start):
    out = []
    if season_clim:
        out.append({"kind": "season", "title": "Fire season",
                    "text": f"Burning here typically runs {season_clim['label']}, peaking around {season_clim['peak_label']}."})
    if outlook:
        tone = "inside the critical window" if outlook["in_critical"] else "outside the usual critical window"
        out.append({"kind": "outlook", "title": "Next 4 weeks",
                    "text": f"{outlook['label']} is {tone}: historically {outlook['share_of_year'] * 100:.0f}% of a year's burning "
                            f"(about {fmt(outlook['expected'])} detections) happens in these weeks."})
    if jump and jump["naive_ratio"] > 1.3:
        out.append({"kind": "jump", "title": "The sensor jump",
                    "text": f"Stitching the raw records makes activity look {jump['naive_ratio']:.1f}x higher after VIIRS arrived in "
                            f"{viirs_start}. Harmonized, the change is {jump['harmonized_ratio']:.2f}x."})
    h, n = trends.get("harmonized"), trends.get("naive")
    if h:
        direction = "rising" if h["pct_per_decade"] > 0 else "falling"
        verdict = "a statistically significant" if h["significant"] else "no statistically significant"
        text = (f"Harmonized activity is {direction} {abs(h['pct_per_decade']):.0f}% per decade "
                f"({verdict} trend, p={h['p_value']:.2f}).") if h["significant"] else \
               f"No statistically significant trend in harmonized activity (p={h['p_value']:.2f})."
        if n and n["significant"] and (not h["significant"] or np.sign(n["slope_per_year"]) != np.sign(h["slope_per_year"])):
            text += f" The naive record would wrongly claim {n['pct_per_decade']:+.0f}% per decade."
        out.append({"kind": "trend", "title": "Long-term change", "text": text})
    if len(ranks):
        top = ranks.sort_values().index[0]
        out.append({"kind": "record", "title": "Most active year",
                    "text": f"{int(top)} was the most active of {len(ranks)} years "
                            f"({fmt(annual.harm[top])} VIIRS-equivalent detections)."})
    if len(unusual):
        r = unusual.iloc[0]
        out.append({"kind": "anomaly", "title": "Most unusual month",
                    "text": f"{MONTHS[int(r.month)]} {int(r.year)} saw {r.ratio:.1f}x the normal activity for that month."})
    if peak_trend and peak_trend["significant"]:
        days = peak_trend["slope_per_year"] * 7 * 10
        out.append({"kind": "shift", "title": "Season timing",
                    "text": f"The season is starting {abs(days):.0f} days {'later' if days > 0 else 'earlier'} per decade."})
    return out
