"""Country leaderboard: fewest severe fires and least industrial heat, per 1,000 km2.

Severe fires: VIIRS S-NPP vegetation-fire detections with fire radiative power of 10 MW or more
(the same definition the GeoData AI severity model uses), counted for one full year from the
GeoData cleaned FIRMS file. Industrial heat: hot pixels at persistent static sources (gas flares,
refineries, plants) in the same year, from the harmonized product.

Land areas and populations come from GeoNames (countryInfo.txt, downloaded to data/ref).
Countries under MIN_AREA_KM2 are listed but not ranked, because a few pixels swing a tiny
country's density. Places under MIN_POPULATION (Antarctica, empty territories) are not ranked.

    python -m pipeline.rankings [path/to/cleaned_master_fires.csv]
"""

import json
import sys
from pathlib import Path

import duckdb
import pandas as pd

from pipeline.config import CELL_DEG, CLEANED_FIRES_FILE, GEONAMES_FILE, N_COLS, PRODUCT_DIR

FIRES_CSV = (Path(sys.argv[1]) if len(sys.argv) > 1
             else CLEANED_FIRES_FILE)
PRODUCT = PRODUCT_DIR
GEONAMES = GEONAMES_FILE
OUT = PRODUCT / "rankings.json"
YEAR = 2025
MIN_AREA_KM2 = 10_000
MIN_POPULATION = 100_000  # leaves out Antarctica and nearly empty territories
SEVERE_MW = 10

# FIRMS archive country names -> GeoNames names.
ALIASES = {
    "Brunei Darussalam": "Brunei", "Cape Verde": "Cabo Verde", "Cote d Ivoire": "Ivory Coast", "Czech Republic": "Czechia",
    "Dem Rep Korea": "North Korea", "Faeroe Islands": "Faroe Islands", "Federated States of Micronesia": "Micronesia",
    "French Southern and Antarctic Lands": "French Southern Territories", "Heard I and McDonald Islands": "Heard Island and McDonald Islands",
    "Lao PDR": "Laos", "Macedonia Former Yugoslav Republic of": "North Macedonia", "Netherlands": "The Netherlands",
    "Palestine": "Palestinian Territory", "Republic of Congo": "Republic of the Congo", "Republic of Korea": "South Korea",
    "Russian Federation": "Russia", "Saint-Barthelemy": "Saint Barthelemy", "Saint-Martin": "Saint Martin",
    "South Georgia and South Sandwich Islands": "South Georgia and the South Sandwich Islands", "Swaziland": "Eswatini",
    "The Gambia": "Gambia", "Timor-Leste": "Timor Leste", "United States Virgin Islands": "U.S. Virgin Islands",
    "Wallis and Futuna Islands": "Wallis and Futuna",
}


def geonames():
    """GeoNames name -> (area km2, population)."""
    rows = [line.rstrip("\n").split("\t") for line in GEONAMES.open(encoding="utf-8") if not line.startswith("#")]
    return {r[4]: (float(r[6]), int(r[7] or 0)) for r in rows if len(r) > 7 and r[6]}


def main():
    con = duckdb.connect()
    con.register("cells", pd.read_parquet(PRODUCT / "cells.parquet")[["cell", "country"]])
    path = FIRES_CSV.as_posix()
    print(f"counting severe fires in {path} ...", flush=True)
    fires = con.sql(f"""
        WITH f AS (
            SELECT (LEAST(GREATEST(FLOOR((latitude + 90) / {CELL_DEG}), 0), {int(180 / CELL_DEG) - 1}) * {N_COLS}
                    + LEAST(GREATEST(FLOOR((longitude + 180) / {CELL_DEG}), 0), {N_COLS - 1}))::INTEGER AS cell, frp
            FROM read_csv_auto('{path}', sample_size=200000)
            WHERE satellite_source = 'viirs_suomi' AND type = 0 AND YEAR(acq_date) = {YEAR})
        SELECT c.country, COUNT(*) AS fires, COUNT(*) FILTER (WHERE f.frp >= {SEVERE_MW}) AS severe
        FROM f JOIN cells c USING (cell) WHERE c.country IS NOT NULL AND c.country <> '?' GROUP BY ALL""").df()
    print(f"  {int(fires.fires.sum()):,} fires, {int(fires.severe.sum()):,} severe", flush=True)

    cellweek = (PRODUCT / "cellweek.parquet").as_posix()
    industry = con.sql(f"""
        SELECT c.country, SUM(w.viirs_ind)::DOUBLE AS ind_pixels,
               COUNT(DISTINCT w.cell) FILTER (WHERE w.viirs_ind > 0) AS ind_cells
        FROM '{cellweek}' w JOIN cells c USING (cell)
        WHERE w.year = {YEAR} AND w.viirs_ind IS NOT NULL GROUP BY ALL""").df()

    known = geonames()
    countries = sorted(set(pd.read_parquet(PRODUCT / "cells.parquet").country.dropna()) - {"?"})
    frame = pd.DataFrame({"country": countries})
    frame["area_km2"] = frame.country.map(lambda c: known.get(ALIASES.get(c, c), (None, 0))[0])
    frame["population"] = frame.country.map(lambda c: known.get(ALIASES.get(c, c), (None, 0))[1])
    frame = frame.merge(fires, on="country", how="left").merge(industry, on="country", how="left")
    frame[["fires", "severe", "ind_pixels", "ind_cells"]] = frame[["fires", "severe", "ind_pixels", "ind_cells"]].fillna(0)
    frame["severe_per_1k"] = frame.severe / frame.area_km2 * 1000
    frame["ind_per_1k"] = frame.ind_pixels / frame.area_km2 * 1000
    frame["severe_share"] = (frame.severe / frame.fires.where(frame.fires > 0)).round(4)
    frame["ranked"] = (frame.area_km2.fillna(0) >= MIN_AREA_KM2) & (frame.population >= MIN_POPULATION)
    ranked = frame[frame.ranked].copy()
    # Rank 1 = best (fewest per 1,000 km2). Ties share a rank.
    ranked["severe_rank"] = ranked.severe_per_1k.rank(method="min").astype(int)
    ranked["ind_rank"] = ranked.ind_per_1k.rank(method="min").astype(int)
    frame = frame.merge(ranked[["country", "severe_rank", "ind_rank"]], on="country", how="left")
    missing = frame[frame.area_km2.isna()].country.tolist()
    if missing:
        print("  no area for:", missing)
    out = {
        "year": YEAR, "severe_mw": SEVERE_MW, "min_area_km2": MIN_AREA_KM2, "ranked_countries": int(frame.ranked.sum()),
        "source": {"fires": "NASA FIRMS VIIRS S-NPP vegetation fires (GeoData cleaned file)", "industry": "harmonized product, viirs_ind",
                   "area": "GeoNames countryInfo.txt"},
        "countries": json.loads(frame.round(4).to_json(orient="records")),
    }
    OUT.write_text(json.dumps(out), encoding="utf-8")
    print(f"wrote {OUT} ({out['ranked_countries']} ranked countries)")


if __name__ == "__main__":
    main()
