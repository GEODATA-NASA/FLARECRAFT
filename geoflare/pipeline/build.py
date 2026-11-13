"""Train, cross-validate and publish the harmonized record.

Steps
  1. weekly tables for MODIS, VIIRS S-NPP (target) and VIIRS NOAA-20 (independent check)
  2. leave-one-year-out over the overlap years: train on the others, reconstruct the
     held-out year from MODIS alone, compare with what VIIRS really saw (honest validation)
  3. final model on all overlap years -> reconstruct every MODIS year (2000-2011 matter most)
  4. publish: data/product/cellweek.parquet  (cell, year, week, modis, viirs, viirs_j1, recon, ind, ...)
              data/product/cells.parquet     (cell, lat, lon, country, s_bg)
              data/product/report.json       (validation metrics, calibration bands, global ratio)

    python -m pipeline.build                 # full archive (data/agg)
    python -m pipeline.build --source agg-dev --no-loyo   # plumbing test on local 2025
"""

import argparse
import json
import time

import duckdb
import joblib
import numpy as np
import pandas as pd

from pipeline.config import DATA_DIR, cell_center
from pipeline.harmonize import (FEATURES, VIIRS_STATIC, aggregate_errors, assemble, calibration_table, fit,
                                static_features)
from pipeline.weekly import weekly_cached

TRAIN_KEEP = 0.25      # fraction of informative rows per training set
ZERO_ROWS = 1_500_000  # sampled all-zero rows per training set
LOG = []


def log(message, started=[time.time()]):
    line = f"[{time.time() - started[0]:6.0f}s] {message}"
    LOG.append(line)
    print(line, flush=True)


def predict_years(model, static, m, years):
    """Reconstruct VIIRS-equivalent counts for the given years from MODIS alone."""
    parts = []
    for year in years:
        m_year = m[m.year == year]
        if m_year.empty:
            continue
        rows = assemble(m_year, None, static)
        rows["recon"] = model.predict(rows).astype("float32")
        parts.append(rows[["t", "cell", "recon"]])
    if not parts:
        return pd.DataFrame({"t": pd.Series(dtype="int32"), "cell": pd.Series(dtype="int32"), "recon": pd.Series(dtype="float32")})
    return pd.concat(parts, ignore_index=True)


def leave_one_year_out(m, v, years):
    features = FEATURES + VIIRS_STATIC
    recon, metrics, grouped = [], {}, {lvl: [] for lvl in ("week", "month", "year")}
    for held in years:
        others = [y for y in years if y != held]
        m_tr, v_tr = m[m.year.isin(others)], v[v.year.isin(others)]
        static = static_features(m_tr, v_tr)
        model = fit(assemble(m_tr, v_tr, static, zero_rows=ZERO_ROWS, keep=TRAIN_KEEP), features)
        test = assemble(m[m.year == held], v[v.year == held], static)
        test["pred_model"] = model.predict(test).astype("float32")
        test["pred_global"] = (test.m_veg * static.attrs["prior"]).astype("float32")
        year_metrics = {}
        for name in ("pred_model", "pred_global"):
            year_metrics[name] = {}
            for level in ("month", "year"):
                year_metrics[name][level], g = aggregate_errors(test, name, level)
                if name == "pred_model":
                    grouped[level].append(g)
            if name == "pred_model":
                _, g = aggregate_errors(test, name, "week")
                grouped["week"].append(g)
        metrics[int(held)] = year_metrics
        recon.append(test[["t", "cell", "pred_model"]].rename(columns={"pred_model": "recon"}))
        log(f"LOYO {held}: model year-level R2(log)={year_metrics['pred_model']['year']['r2_log']:.3f} "
            f"MdAPE={year_metrics['pred_model']['month']['median_abs_pct_err']:.0f}% (month) | "
            f"global-ratio MdAPE={year_metrics['pred_global']['month']['median_abs_pct_err']:.0f}%")
    pooled = {level: pd.concat(frames) for level, frames in grouped.items()}
    calibration = {level: calibration_table(g) for level, g in pooled.items()}
    coverage = {}
    for level, g in pooled.items():
        lo, hi = band(g.yhat.to_numpy(), calibration[level])
        coverage[level] = float(((g.y >= lo) & (g.y <= hi)).mean())
    return pd.concat(recon, ignore_index=True), metrics, calibration, coverage


def band(pred, table):
    """80% band from the empirical calibration table (actual / predicted quantiles by magnitude)."""
    pred = np.asarray(pred, dtype="float64")
    lo, hi = np.full(pred.shape, np.nan), np.full(pred.shape, np.nan)
    for row in table:
        sel = (pred >= row["lo"]) & (pred < row["hi"])
        lo[sel], hi[sel] = (pred[sel] + 1) * row["q10"] - 1, (pred[sel] + 1) * row["q90"] - 1
    first, last = table[0], table[-1]
    small = pred < first["lo"]
    lo[small], hi[small] = (pred[small] + 1) * first["q10"] - 1, (pred[small] + 1) * first["q90"] - 1
    big = np.isnan(lo)
    lo[big], hi[big] = (pred[big] + 1) * last["q10"] - 1, (pred[big] + 1) * last["q90"] - 1
    return np.clip(lo, 0, None), hi


def dominant_country(source):
    path = (DATA_DIR / source / "*" / "*.parquet").as_posix()
    frame = duckdb.sql(f"""
        SELECT cell, arg_max(country, n) AS country FROM (
            SELECT cell, country, SUM(n) AS n FROM read_parquet('{path}', union_by_name=true)
            GROUP BY cell, country)
        GROUP BY cell""").df()
    return frame


def main(source="agg", loyo=True):
    out = DATA_DIR / "product" if source == "agg" else DATA_DIR / f"product-{source}"
    out.mkdir(parents=True, exist_ok=True)
    m = weekly_cached("modis", source)
    v = weekly_cached("viirs-snpp", source)
    try:
        j = weekly_cached("viirs-jpss1", source)
    except duckdb.IOException:
        j = None
    log(f"weekly rows: modis {len(m):,}  snpp {len(v):,}  noaa20 {0 if j is None else len(j):,}")
    overlap = sorted(set(m.year.unique()) & set(v.year.unique()))
    log(f"overlap years: {overlap}")

    report = {"overlap_years": [int(y) for y in overlap]}
    recon_oos = None
    if loyo and len(overlap) >= 3:
        recon_oos, metrics, calibration, coverage = leave_one_year_out(m, v, overlap)
        report.update({"loyo": metrics, "calibration": calibration, "band_coverage": coverage})

    static = static_features(m[m.year.isin(overlap)], v[v.year.isin(overlap)])
    final = fit(assemble(m[m.year.isin(overlap)], v[v.year.isin(overlap)], static,
                         zero_rows=ZERO_ROWS, keep=TRAIN_KEEP), FEATURES + VIIRS_STATIC)
    joblib.dump({"model": final, "static": static}, out / "final_model.joblib", compress=3)
    report["global_ratio"] = static.attrs["prior"]
    log(f"final model: {final.n_iter_} trees; global VIIRS/MODIS ratio {static.attrs['prior']:.2f}")

    pre = [y for y in sorted(m.year.unique()) if y not in overlap or recon_oos is None]
    recon = predict_years(final, static, m, pre)
    if recon_oos is not None:
        recon = pd.concat([recon, recon_oos], ignore_index=True)
    recon["year"], recon["week"] = (recon.t // 52).astype("int16"), (recon.t % 52).astype("int16")
    log(f"reconstructed {len(recon):,} cell-weeks for {len(pre)} MODIS-only years + {len(overlap)} held-out years")

    key = ["cell", "year", "week"]
    table = m[key + ["veg", "frp", "ind", "volc"]].rename(columns={"veg": "modis", "frp": "modis_frp", "ind": "modis_ind", "volc": "modis_volc"})
    table = table.merge(v[key + ["veg", "frp", "ind"]].rename(columns={"veg": "viirs", "frp": "viirs_frp", "ind": "viirs_ind"}), on=key, how="outer")
    if j is not None:
        table = table.merge(j[key + ["veg"]].rename(columns={"veg": "viirs_j1"}), on=key, how="outer")
    table = table.merge(recon[key + ["recon"]], on=key, how="outer")
    snpp_years = set(v.year.unique())
    in_snpp = table.year.isin(snpp_years)
    for col in table.columns.difference(key):
        table[col] = table[col].astype("float32")
    # Missing means zero inside a sensor's years, unknown outside them.
    for col in ("modis", "modis_frp", "modis_ind", "modis_volc", "recon"):
        table[col] = table[col].fillna(0)
    for col in ("viirs", "viirs_frp", "viirs_ind"):
        table.loc[in_snpp, col] = table.loc[in_snpp, col].fillna(0)
    if j is not None:
        table.loc[table.year.isin(set(j.year.unique())), "viirs_j1"] = table.loc[table.year.isin(set(j.year.unique())), "viirs_j1"].fillna(0)
    table = table.astype({"cell": "int32", "year": "int16", "week": "int16"}).sort_values(key).reset_index(drop=True)
    table.to_parquet(out / "cellweek.parquet", index=False, compression="zstd", row_group_size=200_000)

    cells = pd.DataFrame({"cell": table.cell.unique()})
    cells["lat"], cells["lon"] = cell_center(cells.cell.to_numpy())
    cells = cells.merge(dominant_country(source), on="cell", how="left")
    cells["s_bg"] = static.s_bg.reindex(cells.cell).fillna(0).to_numpy("float32") if "s_bg" in static else 0
    cells.to_parquet(out / "cells.parquet", index=False)

    report["rows"] = int(len(table))
    report["log"] = LOG
    (out / "report.json").write_text(json.dumps(report, indent=2, default=float))
    log(f"published {len(table):,} cell-weeks, {len(cells):,} cells -> {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="agg")
    parser.add_argument("--no-loyo", action="store_true")
    args = parser.parse_args()
    main(args.source, loyo=not args.no_loyo)
