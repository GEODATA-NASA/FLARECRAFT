"""Read access to the published harmonized record (DuckDB over Parquet)."""

import json
import threading
from functools import lru_cache
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from pipeline.config import CELL_DEG, N_COLS, N_ROWS

SUMS = ["modis", "viirs", "viirs_j1", "recon", "modis_ind", "viirs_ind", "modis_volc", "modis_frp", "viirs_frp"]


class Store:
    def __init__(self, product_dir: Path):
        self.dir = Path(product_dir)
        self.cellweek = (self.dir / "cellweek.parquet").as_posix()
        self.report = json.loads((self.dir / "report.json").read_text())
        self._local = threading.local()
        cells = pd.read_parquet(self.dir / "cells.parquet")
        self.cells = cells.set_index("cell")
        self.columns = [c for c in SUMS if c in duckdb.sql(f"DESCRIBE SELECT * FROM '{self.cellweek}'").df().column_name.tolist()]
        meta = self.db.execute(f"SELECT MIN(year), MAX(year) FROM '{self.cellweek}'").fetchall()[0]
        self.first_year, self.last_year = int(meta[0]), int(meta[1])
        snpp = self.db.execute(f"SELECT MIN(year) FROM '{self.cellweek}' WHERE viirs IS NOT NULL").fetchall()[0][0]
        self.viirs_start = int(snpp) if snpp is not None else self.last_year + 1
        counts = cells.groupby("country").size()
        self.countries = sorted(c for c in counts.index if isinstance(c, str) and c != "?")
        self.intro_cache = None

    @property
    def db(self):
        if not hasattr(self._local, "con"):
            self._local.con = duckdb.connect()
            self._local.con.register("cells_df", self.cells.reset_index())
        return self._local.con

    # ---------------------------------------------------------------- areas
    @staticmethod
    def bbox_filter(west, south, east, north):
        """SQL predicate selecting 0.25 degree cells whose centre lies in the box."""
        r0 = max(0, int(np.floor((south + 90) / CELL_DEG)))
        r1 = min(N_ROWS - 1, int(np.ceil((north + 90) / CELL_DEG)) - 1)
        c0 = int(np.floor((west + 180) / CELL_DEG)) % N_COLS
        c1 = (int(np.ceil((east + 180) / CELL_DEG)) - 1) % N_COLS
        rows = f"cell BETWEEN {r0 * N_COLS} AND {r1 * N_COLS + N_COLS - 1}"
        cols = (f"(cell % {N_COLS}) BETWEEN {c0} AND {c1}" if c0 <= c1
                else f"((cell % {N_COLS}) >= {c0} OR (cell % {N_COLS}) <= {c1})")  # crosses the dateline
        return f"{rows} AND {cols}"

    def area_filter(self, bbox=None, country=None):
        if country:
            safe = country.replace("'", "''")
            return f"cell IN (SELECT cell FROM cells_df WHERE country = '{safe}')", f"country = '{safe}'"
        if bbox:
            pred = self.bbox_filter(*bbox)
            return pred, pred
        return "TRUE", "TRUE"

    # --------------------------------------------------------------- series
    @lru_cache(maxsize=256)
    def weekly(self, bbox=None, country=None):
        where, cell_where = self.area_filter(bbox, country)
        sums = ", ".join(f"SUM({c})::DOUBLE AS {c}" for c in self.columns)
        frame = self.db.sql(f"""
            SELECT year, week, {sums} FROM '{self.cellweek}'
            WHERE {where} GROUP BY year, week ORDER BY year, week""").df()
        # VIIRS-only background (fires too small for MODIS anywhere nearby), added to reconstructions.
        bg = self.db.execute(f"SELECT COALESCE(SUM(s_bg), 0) FROM cells_df WHERE {cell_where}").fetchall()[0][0]
        n_cells = self.db.execute(f"SELECT COUNT(*) FROM cells_df WHERE {cell_where}").fetchall()[0][0]
        full = pd.MultiIndex.from_product([range(self.first_year, self.last_year + 1), range(52)], names=["year", "week"])
        frame = frame.set_index(["year", "week"]).reindex(full).reset_index()
        for col in self.columns:
            frame[col] = frame[col].fillna(0.0)
        frame.loc[frame.year < self.viirs_start, ["viirs", "viirs_frp", "viirs_ind"]] = np.nan
        if "viirs_j1" in frame:
            j1_years = self.db.sql(f"SELECT DISTINCT year FROM '{self.cellweek}' WHERE viirs_j1 IS NOT NULL").df().year
            frame.loc[~frame.year.isin(j1_years), "viirs_j1"] = np.nan
        frame["recon"] = frame.recon + bg
        return frame, float(bg), int(n_cells)

    def intro_frames(self, year, per_frame=1800):
        """Weekly harmonized activity on a 1 degree grid: [[lat, lon, value], ...] per week."""
        value = "viirs" if year >= self.viirs_start else "recon"
        frame = self.db.sql(f"""
            SELECT week, (cell // {N_COLS}) // 4 AS r, (cell % {N_COLS}) // 4 AS c, SUM({value})::DOUBLE AS v
            FROM '{self.cellweek}' WHERE year = {int(year)}
            GROUP BY ALL HAVING v >= 1""").df()
        frame["rank"] = frame.groupby("week").v.rank(ascending=False, method="first")
        frame = frame[frame["rank"] <= per_frame]
        frame["lat"] = -90 + (frame.r + 0.5)
        frame["lon"] = -180 + (frame.c + 0.5)
        return [g[["lat", "lon", "v"]].round(1).values.tolist() for _, g in frame.groupby("week")]

    def industrial_sites(self, year, limit=350):
        """Persistent static heat sources (gas flares, refineries, offshore platforms) for one year."""
        column = "viirs_ind" if year >= self.viirs_start else "modis_ind"
        frame = self.db.sql(f"""
            SELECT cell, SUM({column})::DOUBLE AS n, COUNT(*) FILTER (WHERE {column} > 0) AS weeks
            FROM '{self.cellweek}' WHERE year = {int(year)}
            GROUP BY cell HAVING n > 0 ORDER BY n DESC LIMIT {int(limit)}""").df()
        row, col = np.divmod(frame.cell.to_numpy(), N_COLS)
        frame["lat"], frame["lon"] = -90 + (row + 0.5) * CELL_DEG, -180 + (col + 0.5) * CELL_DEG
        frame["country"] = self.cells.country.reindex(frame.cell).to_numpy()
        return frame[["lat", "lon", "n", "weeks", "country"]].round(3).values.tolist()

    def cell_values(self, year, week_from, week_to, bbox=None, limit=20000):
        """Harmonized activity per cell for a map layer (observed VIIRS when available)."""
        where = self.bbox_filter(*bbox) if bbox else "TRUE"
        value = "SUM(viirs)" if year >= self.viirs_start else "SUM(recon)"
        frame = self.db.sql(f"""
            SELECT cell, {value}::DOUBLE AS value, SUM(COALESCE(viirs_ind, modis_ind))::DOUBLE AS ind
            FROM '{self.cellweek}'
            WHERE year = {int(year)} AND week BETWEEN {int(week_from)} AND {int(week_to)} AND {where}
            GROUP BY cell HAVING value >= 0.5 OR ind > 0
            ORDER BY value DESC LIMIT {int(limit)}""").df()
        row, col = np.divmod(frame.cell.to_numpy(), N_COLS)
        frame["lat"] = -90 + (row + 0.5) * CELL_DEG
        frame["lon"] = -180 + (col + 0.5) * CELL_DEG
        return frame
