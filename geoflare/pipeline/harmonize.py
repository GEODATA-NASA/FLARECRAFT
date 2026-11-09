"""Learn MODIS -> VIIRS(S-NPP)-equivalent fire activity, validate it, and quantify uncertainty.

Question the model answers: "Given only what MODIS saw in this cell and week, how many
vegetation-fire detections would VIIRS S-NPP have made?"  Trained where both sensors flew.

Features (all available in the MODIS-only era):
  cell-week   m_veg, m_t, m_a (Terra/Aqua), m_frp, m_frp_max, m_night
  context     m_nb (8 neighbouring cells, same week), m_prev / m_next (same cell, +-1 week)
  regime      s_frp (mean MODIS FRP per detection), s_mfreq (share of weeks with MODIS fire),
              s_ratio, s_bg (VIIRS/MODIS ratio and VIIRS-only background, overlap years only)
  place/time  lat, |lat|, sin/cos week
Model: HistGradientBoostingRegressor with Poisson loss (counts), compared with two baselines:
  global ratio  v = k * m_veg          per-cell ratio  v = s_ratio * m_veg
"""

import argparse
import json
import time

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import d2_tweedie_score

from pipeline.config import MODEL_DIR, N_COLS, N_ROWS
from pipeline.weekly import weekly

NCELLS = N_COLS * N_ROWS
M_COLS = ["veg", "veg_t", "veg_a", "frp", "frp_max", "night"]
FEATURES = ["m_veg", "m_t", "m_a", "m_frp", "m_frp_max", "m_night", "m_nb", "m_prev", "m_next",
            "s_frp", "s_mfreq", "lat", "abslat", "wsin", "wcos"]
VIIRS_STATIC = ["s_ratio", "s_bg"]
RNG = np.random.default_rng(42)


def keys(t, cell):
    return t.astype("int64") * NCELLS + cell.astype("int64")


def lookup(series, query_keys):
    return series.reindex(query_keys).fillna(0).to_numpy("float32")


def modis_context(m):
    """Neighbour and adjacent-week MODIS sums, keyed by (t, cell)."""
    m = m.assign(t=m.year.astype("int32") * 52 + m.week)
    k = keys(m.t, m.cell)
    veg = pd.Series(m.veg.to_numpy("float32"), index=k)
    return m, k, veg


def neighbour_features(query_t, query_cell, veg):
    k = keys(query_t, query_cell)
    nb = np.zeros(len(k), "float32")
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr or dc:
                nb += lookup(veg, k + dr * N_COLS + dc)
    return nb, lookup(veg, k - NCELLS), lookup(veg, k + NCELLS)


def static_features(m, v=None):
    """Per-cell fire regime. MODIS-only terms always; VIIRS terms only when v (overlap years) is given."""
    n_weeks = m.year.nunique() * 52  # years need not be contiguous (leave-one-year-out)
    g = m.assign(active=m.veg > 0).groupby("cell").agg(
        m_tot=("veg", "sum"), m_frp_tot=("frp", "sum"), m_weeks=("active", "sum"))
    out = pd.DataFrame({
        "s_frp": (g.m_frp_tot / g.m_tot.clip(lower=1)).astype("float32"),
        "s_mfreq": (g.m_weeks / n_weeks).astype("float32"),
    })
    if v is not None:
        vt = v.groupby("cell").veg.sum()
        both = pd.concat([g.m_tot, vt.rename("v_tot")], axis=1).fillna(0)
        prior = both.v_tot.sum() / max(both.m_tot.sum(), 1)
        # Empirical-Bayes shrinkage toward the global ratio for cells with little MODIS data.
        out = out.reindex(both.index)
        out["s_ratio"] = ((both.v_tot + 20 * prior) / (both.m_tot + 20)).astype("float32")
        out.attrs["prior"] = float(prior)
        # VIIRS detections in weeks where MODIS saw nothing nearby: small fires MODIS cannot see.
        mm, _, veg = modis_context(m)
        vv = v.assign(t=v.year.astype("int32") * 52 + v.week)
        nb, prev, nxt = neighbour_features(vv.t, vv.cell, veg)
        own = lookup(veg, keys(vv.t, vv.cell))
        blind = (own + nb + prev + nxt) == 0
        out["s_bg"] = (vv[blind].groupby("cell").veg.sum() / n_weeks).reindex(out.index).fillna(0).astype("float32")
    return out


def assemble(m, v, static, zero_rows=0, keep=1.0):
    """Rows = every (t, cell) with MODIS context or VIIRS fire, plus sampled all-zero rows (weighted).

    keep < 1 subsamples the informative rows (weight 1/keep) so multi-year training fits in memory.
    """
    m, mk, veg = modis_context(m)
    domain = [m[["t", "cell"]]]
    if v is not None:
        domain.append(v.assign(t=v.year.astype("int32") * 52 + v.week)[["t", "cell"]])
    rows = full = pd.concat(domain).drop_duplicates()
    if keep < 1:
        rows = rows.sample(frac=keep, random_state=0)
    weight = np.full(len(rows), 1 / keep, "float32")
    if zero_rows:
        active = rows.cell.unique()
        ts = np.arange(rows.t.min(), rows.t.max() + 1)
        sample = pd.DataFrame({"t": RNG.choice(ts, zero_rows), "cell": RNG.choice(active, zero_rows)})
        sample = sample[~keys(sample.t, sample.cell).isin(keys(full.t, full.cell))].drop_duplicates()
        density = len(active) * len(ts) - len(full)
        weight = np.concatenate([weight, np.full(len(sample), density / max(len(sample), 1), "float32")])
        rows = pd.concat([rows, sample], ignore_index=True)

    rows = rows.reset_index(drop=True)
    k = keys(rows.t, rows.cell)
    mi = m.set_index(mk)
    out = pd.DataFrame({"t": rows.t.to_numpy("int32"), "cell": rows.cell.to_numpy("int32")})
    for col, name in zip(M_COLS, ["m_veg", "m_t", "m_a", "m_frp", "m_frp_max", "m_night"]):
        out[name] = mi[col].reindex(k).fillna(0).to_numpy("float32")
    out["m_nb"], out["m_prev"], out["m_next"] = neighbour_features(out.t, out.cell, veg)
    row = out.cell // N_COLS
    out["lat"] = (-90 + (row + 0.5) * 0.25).astype("float32")
    out["abslat"] = out.lat.abs()
    week = out.t % 52
    out["wsin"] = np.sin(2 * np.pi * week / 52).astype("float32")
    out["wcos"] = np.cos(2 * np.pi * week / 52).astype("float32")
    out = out.join(static, on="cell")
    for col in static.columns:
        # Cells never seen in the overlap years fall back to the global VIIRS/MODIS ratio.
        out[col] = out[col].fillna(static.attrs.get("prior", 0) if col == "s_ratio" else 0)
    if v is not None:
        vt = v.assign(t=v.year.astype("int32") * 52 + v.week)
        out["target"] = lookup(pd.Series(vt.veg.to_numpy("float32"), index=keys(vt.t, vt.cell)), k)
    out["weight"] = weight
    return out


class LogCountModel:
    """Gradient boosting on log1p(count), back-transformed with a binned smearing correction.

    sklearn's Poisson loss takes unbounded Newton steps: a leaf whose VIIRS counts are
    hundreds of times the starting mean blows up after one tree (LightGBM caps this with
    max_delta_step; sklearn cannot). Boosting in log space is stable; exp() of a mean log
    underestimates the mean count (Jensen), so each prediction decile gets a factor
    sum(actual) / sum(expm1(pred)) learned on held-out training cells.
    """

    def __init__(self, features):
        self.features = features
        self.booster = HistGradientBoostingRegressor(
            loss="squared_error", learning_rate=0.08, max_iter=600, max_leaf_nodes=63,
            min_samples_leaf=200, l2_regularization=1.0, early_stopping=True,
            validation_fraction=0.1, n_iter_no_change=25, random_state=0)

    def fit(self, data):
        block = ((data.cell // N_COLS) // 20) * 1000 + (data.cell % N_COLS) // 20
        calib = (block % 10) == 3  # spatial blocks reserved for the bias correction
        fit_rows, cal_rows = data[~calib], data[calib]
        self.booster.fit(fit_rows[self.features], np.log1p(fit_rows.target), sample_weight=fit_rows.weight)
        raw = np.expm1(self.booster.predict(cal_rows[self.features])).clip(min=0)
        self.edges = np.unique(np.quantile(raw, np.linspace(0, 1, 21)[1:-1]))
        bins = np.digitize(raw, self.edges)
        frame = pd.DataFrame({"bin": bins, "y": cal_rows.target * cal_rows.weight, "p": raw * cal_rows.weight})
        sums = frame.groupby("bin")[["y", "p"]].sum()
        self.factors = (sums.y / sums.p.clip(lower=1e-9)).reindex(range(len(self.edges) + 1)).fillna(1.0).to_numpy()
        self.n_iter_ = self.booster.n_iter_
        return self

    def predict(self, frame):
        raw = np.expm1(self.booster.predict(frame[self.features])).clip(min=0)
        return raw * self.factors[np.digitize(raw, self.edges)]


def fit(data, features):
    return LogCountModel(features).fit(data)


def aggregate_errors(frame, pred_col, level):
    """Compare predicted vs actual totals for 5x5 degree boxes at week / month / year level."""
    row, col = frame.cell // N_COLS, frame.cell % N_COLS
    box = (row // 20) * 1000 + (col // 20)
    year, week = frame.t // 52, frame.t % 52
    period = {"week": frame.t, "month": year * 12 + np.minimum(week * 12 // 52, 11), "year": year}[level]
    g = pd.DataFrame({"box": box, "p": period, "y": frame.target * frame.weight,
                      "yhat": frame[pred_col] * frame.weight}).groupby(["box", "p"]).sum()
    g = g[(g.y + g.yhat) >= 20]  # ignore near-empty boxes
    logerr = np.log((g.y + 1) / (g.yhat + 1))
    return {
        "n": int(len(g)),
        "r2_log": float(1 - ((np.log1p(g.y) - np.log1p(g.yhat)) ** 2).sum() / ((np.log1p(g.y) - np.log1p(g.y).mean()) ** 2).sum()),
        "median_abs_pct_err": float(np.median(np.abs(g.yhat - g.y) / g.y.clip(lower=1)) * 100),
        "total_bias_pct": float((g.yhat.sum() / g.y.sum() - 1) * 100),
        "logerr_q10": float(np.quantile(logerr, 0.1)), "logerr_q90": float(np.quantile(logerr, 0.9)),
    }, g


def calibration_table(g, bins=(20, 50, 100, 300, 1000, 3000, 1e12)):
    """Empirical 80% band: quantiles of actual/predicted by predicted magnitude."""
    out = []
    edges = list(bins)
    for lo, hi in zip([0] + edges[:-1], edges):
        sel = g[(g.yhat >= lo) & (g.yhat < hi)]
        if len(sel) < 30:
            continue
        ratio = (sel.y + 1) / (sel.yhat + 1)
        out.append({"lo": lo, "hi": hi, "n": int(len(sel)), "q10": float(ratio.quantile(0.1)),
                    "q50": float(ratio.quantile(0.5)), "q90": float(ratio.quantile(0.9))})
    return out


def evaluate(model, train, valid, features):
    valid = valid.copy()
    k = (train.target * train.weight).sum() / (train.m_veg * train.weight).sum()
    valid["pred_model"] = model.predict(valid)
    valid["pred_global"] = valid.m_veg * k
    if "s_ratio" in valid:
        valid["pred_cell"] = valid.m_veg * valid.s_ratio
    report = {"global_ratio": float(k), "rows": int(len(valid))}
    for name in [c for c in valid.columns if c.startswith("pred_")]:
        report[name] = {"d2_poisson_cellweek": float(d2_tweedie_score(valid.target, valid[name].clip(lower=1e-6),
                                                                      sample_weight=valid.weight, power=1))}
        for level in ("week", "month", "year"):
            report[name][level], g = aggregate_errors(valid, name, level)
            if name == "pred_model":
                report[name][level]["calibration"] = calibration_table(g)
    return report, valid


def run(train_years, valid_years, source="agg", out=None):
    started = time.time()
    span = (min(train_years[0], valid_years[0]), max(train_years[1], valid_years[1]))
    m_all = weekly("modis", span, source)
    v_all = weekly("viirs-snpp", span, source)
    in_years = lambda d, y: d[(d.year >= y[0]) & (d.year <= y[1])]
    m_tr, v_tr = in_years(m_all, train_years), in_years(v_all, train_years)
    m_va, v_va = in_years(m_all, valid_years), in_years(v_all, valid_years)
    print(f"weekly tables: modis {len(m_all):,} viirs {len(v_all):,} rows [{time.time() - started:.0f}s]", flush=True)

    static = static_features(m_tr, v_tr)
    features = FEATURES + VIIRS_STATIC
    train = assemble(m_tr, v_tr, static, zero_rows=2_000_000)
    valid = assemble(m_va, v_va, static, zero_rows=2_000_000)
    print(f"train {len(train):,} rows, valid {len(valid):,} rows [{time.time() - started:.0f}s]", flush=True)

    model = fit(train, features)
    print(f"fitted {model.n_iter_} iterations [{time.time() - started:.0f}s]", flush=True)
    report, _ = evaluate(model, train, valid, features)
    report.update({"train_years": train_years, "valid_years": valid_years, "features": features,
                   "seconds": round(time.time() - started)})
    out = out or MODEL_DIR
    out.mkdir(parents=True, exist_ok=True)
    tag = f"{train_years[0]}-{train_years[1]}_v{valid_years[0]}-{valid_years[1]}"
    (out / f"report_{tag}.json").write_text(json.dumps(report, indent=2))
    joblib.dump({"model": model, "features": features, "static": static}, out / f"model_{tag}.joblib", compress=3)
    return report


def run_spatial_dev(source="agg-dev", year=2025):
    """Dev check on one year: hold out every 4th 5x5 degree block (no VIIRS-derived statics)."""
    m = weekly("modis", (year, year), source)
    v = weekly("viirs-snpp", (year, year), source)
    static = static_features(m)
    data = assemble(m, v, static, zero_rows=1_000_000)
    block = ((data.cell // N_COLS) // 20) * 1000 + (data.cell % N_COLS) // 20
    holdout = (block % 4) == 0
    model = fit(data[~holdout], FEATURES)
    report, _ = evaluate(model, data[~holdout], data[holdout], FEATURES)
    blind = (data.m_veg + data.m_nb + data.m_prev + data.m_next) == 0
    report["viirs_share_where_modis_blind"] = float((data.target * data.weight)[blind].sum() / (data.target * data.weight).sum())
    report["rows"] = int(len(data))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", default="2012-2017")
    parser.add_argument("--valid", default="2018-2019")
    parser.add_argument("--dev", action="store_true", help="spatial holdout on the local 2025 file")
    args = parser.parse_args()
    if args.dev:
        print(json.dumps(run_spatial_dev(), indent=2))
    else:
        span = lambda s: tuple(int(x) for x in s.split("-"))
        print(json.dumps(run(span(args.train), span(args.valid)), indent=2))
