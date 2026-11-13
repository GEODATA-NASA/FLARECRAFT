"""Are factory and flare heat and wildfires related? Three checks on the harmonized record (VIIRS years).

1. Rhythm: do fires and industrial heat rise and fall in the same weeks of the year?
   Weekly global totals averaged over the VIIRS years; peak-to-trough ratio of each and the correlation
   between the two 52-week curves.
2. Proximity: do more fires burn next to factories and flares than elsewhere in the same country?
   Average yearly fire detections in cells that touch a persistent industrial site (the site's own cell and
   its 8 neighbours, about 28 km) against all other cells with any fire, compared country by country so that
   climate and land use are held roughly equal. Togetherness is not cause: farms, roads and towns are near
   industry too.
3. Trends: in years when industrial heat went up, did fires go up too? Correlation of year-to-year changes,
   globally and per country.

Writes data/product/findings.json; the Air story and GET /api/findings read it.

    python -m pipeline.findings
"""

import json

import duckdb
import numpy as np
import pandas as pd

from pipeline.config import N_COLS, PRODUCT_DIR

OUT = PRODUCT_DIR / "findings.json"
MIN_WEEKS = 12          # same definition as the live app: static heat in at least 12 weeks = a persistent site
MIN_CELLS = 5           # a country needs this many cells on each side of the proximity comparison


def corr(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) < 3 or a.std() == 0 or b.std() == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def strength(r):
    if r is None:
        return "not enough data"
    size = abs(r)
    word = "no clear" if size < 0.3 else "a weak" if size < 0.5 else "a moderate" if size < 0.7 else "a strong"
    return f"{word} {'positive' if r > 0 else 'negative'} link" if size >= 0.3 else "no clear link"


def main():
    con = duckdb.connect()
    cw = (PRODUCT_DIR / "cellweek.parquet").as_posix()
    con.register("cells", pd.read_parquet(PRODUCT_DIR / "cells.parquet")[["cell", "country"]])
    first = con.execute(f"SELECT MIN(year) FROM '{cw}' WHERE viirs IS NOT NULL").fetchall()[0][0]
    last = con.execute(f"SELECT MAX(year) FROM '{cw}' WHERE viirs IS NOT NULL").fetchall()[0][0]
    years = last - first + 1

    # 1. Rhythm
    weekly = con.sql(f"""
        SELECT week, SUM(viirs)::DOUBLE / {years} AS fires, SUM(viirs_ind)::DOUBLE / {years} AS industry
        FROM '{cw}' WHERE year >= {first} GROUP BY week ORDER BY week""").df()
    rhythm = {
        "fires_peak_to_trough": float(weekly.fires.max() / max(weekly.fires.min(), 1e-9)),
        "industry_peak_to_trough": float(weekly.industry.max() / max(weekly.industry.min(), 1e-9)),
        "weekly_correlation": corr(weekly.fires, weekly.industry),
        "fires_by_week": weekly.fires.round(1).tolist(),
        "industry_by_week": weekly.industry.round(1).tolist(),
    }

    # 2. Proximity
    sites = con.sql(f"""SELECT cell FROM '{cw}' WHERE COALESCE(viirs_ind, modis_ind) > 0 GROUP BY cell HAVING COUNT(*) >= {MIN_WEEKS}""").df().cell.to_numpy()
    near = set()
    for c in sites:
        r, k = divmod(int(c), N_COLS)
        for dr in (-1, 0, 1):
            for dk in (-1, 0, 1):
                near.add((r + dr) * N_COLS + (k + dk) % N_COLS)
    fires = con.sql(f"""
        SELECT w.cell, c.country, SUM(w.viirs)::DOUBLE / {years} AS per_year
        FROM '{cw}' w JOIN cells c USING (cell) WHERE w.year >= {first} GROUP BY ALL HAVING SUM(w.viirs) > 0""").df()
    fires["near"] = fires.cell.isin(near)
    rows = []
    for country, g in fires[fires.country.notna() & (fires.country != "?")].groupby("country"):
        a, b = g[g.near].per_year, g[~g.near].per_year
        if len(a) >= MIN_CELLS and len(b) >= MIN_CELLS and b.mean() > 0:
            rows.append({"country": country, "near_cells": int(len(a)), "other_cells": int(len(b)),
                         "near_mean": float(a.mean()), "other_mean": float(b.mean()), "ratio": float(a.mean() / b.mean())})
    by_country = pd.DataFrame(rows)
    proximity = {
        "sites": int(len(sites)),
        "countries_compared": int(len(by_country)),
        "median_ratio": float(by_country.ratio.median()) if len(by_country) else None,
        "share_countries_more_fire_near_industry": float((by_country.ratio > 1).mean()) if len(by_country) else None,
        "global_share_of_fires_near_industry": float(fires[fires.near].per_year.sum() / fires.per_year.sum()),
        "global_share_of_fire_cells_near_industry": float(fires.near.mean()),
        "examples": by_country.sort_values("near_cells", ascending=False).head(8).round(3).to_dict(orient="records"),
    }

    # 3. Trends
    yearly = con.sql(f"""
        SELECT c.country, w.year, SUM(w.viirs)::DOUBLE AS fires, SUM(w.viirs_ind)::DOUBLE AS industry
        FROM '{cw}' w JOIN cells c USING (cell) WHERE w.year >= {first} GROUP BY ALL""").df()
    world = yearly.groupby("year")[["fires", "industry"]].sum().sort_index()
    per_country = []
    for country, g in yearly[yearly.country.notna() & (yearly.country != "?")].groupby("country"):
        g = g.sort_values("year")
        if len(g) >= 8 and g.industry.sum() >= 500 and g.fires.sum() >= 500:
            r = corr(g.fires.diff().dropna(), g.industry.diff().dropna())
            if r is not None:
                per_country.append(r)
    trends = {
        "years": [int(first), int(last)],
        "world_change_correlation": corr(world.fires.diff().dropna(), world.industry.diff().dropna()),
        "countries": len(per_country),
        "median_country_correlation": float(np.median(per_country)) if per_country else None,
        "world_fires": world.fires.round(0).tolist(), "world_industry": world.industry.round(0).tolist(),
    }

    r = rhythm["weekly_correlation"]
    verdict = {
        "rhythm": f"Fires swing {rhythm['fires_peak_to_trough']:.1f}x between the quietest and busiest week of the year; "
                  f"factory and flare heat swings only {rhythm['industry_peak_to_trough']:.1f}x. The two weekly curves show {strength(r)} (r = {r:.2f}), "
                  "mostly because both peak in the northern summer, when skies over the northern oil fields are clearer and free of snow, so satellites see more of both.",
        "proximity": (f"In {proximity['countries_compared']} countries, cells next to a factory or flare had "
                      f"{proximity['median_ratio']:.1f}x the fires of other burning cells in the same country (median), "
                      f"and {proximity['share_countries_more_fire_near_industry'] * 100:.0f}% of those countries had more fire near industry. "
                      "Together is not the same as caused: farms, roads and towns cluster near industry too.") if proximity["median_ratio"] else "Not enough data.",
        "trends": (f"From {first} to {last}, the world's year-to-year changes in fires and industrial heat show "
                   f"{strength(trends['world_change_correlation'])} (r = {trends['world_change_correlation']:.2f}); "
                   f"across {trends['countries']} countries the median is r = {trends['median_country_correlation']:.2f}.") if trends["median_country_correlation"] is not None else "Not enough data.",
    }
    OUT.write_text(json.dumps({"rhythm": rhythm, "proximity": proximity, "trends": trends, "verdict": verdict}), encoding="utf-8")
    for k, v in verdict.items():
        print(f"{k}: {v}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
