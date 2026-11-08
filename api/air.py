"""GeoFlare Air: how is the air where you live, and what do nearby gas flares and factories add?

Three sources, joined at one point:
  * industrial heat sites from the harmonized archive (cells with static heat in many weeks),
    with each site's distance, direction, yearly glow and trend since VIIRS began;
  * which of those sites glowed in the last 24 hours (live FIRMS feed);
  * air quality and wind from Open-Meteo: CAMS model estimates of PM2.5, PM10, NO2, SO2, CO and
    ozone with the US AQI, and the 10 m wind. These are model values on a 10-45 km grid, not a sensor.

The report turns those numbers into a verdict, facts (good and bad) and precautions.
"""

import math
import threading
import time

import numpy as np
import requests

from pipeline.config import CELL_DEG, N_COLS

AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
WIND_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
POLLUTANTS = ["pm2_5", "pm10", "nitrogen_dioxide", "sulphur_dioxide", "carbon_monoxide", "ozone"]
# WHO 2021 air quality guidelines (24-hour; ozone 8-hour). CO is in ug/m3 here (4 mg/m3).
WHO = {"pm2_5": 15, "pm10": 45, "nitrogen_dioxide": 25, "sulphur_dioxide": 40, "carbon_monoxide": 4000, "ozone": 100}
NAMES = {"pm2_5": "fine particles (PM2.5)", "pm10": "coarse dust (PM10)", "nitrogen_dioxide": "nitrogen dioxide (NO2)",
         "sulphur_dioxide": "sulphur dioxide (SO2)", "carbon_monoxide": "carbon monoxide (CO)", "ozone": "ozone (O3)"}
HARM = {
    "pm2_5": "Fine particles are small enough to pass the lungs and reach the blood. Over time they raise the risk of heart and lung disease.",
    "pm10": "Coarse dust irritates the nose, throat and lungs, and makes asthma worse. Here it is often desert dust.",
    "nitrogen_dioxide": "Nitrogen dioxide comes from burning fuel: traffic, power plants and flares. It inflames the airways and triggers asthma.",
    "sulphur_dioxide": "Sulphur dioxide comes from burning sulphur-rich oil and gas. Even short exposure tightens the airways of people with asthma.",
    "carbon_monoxide": "Carbon monoxide takes the place of oxygen in the blood. Outdoors it rarely reaches harmful levels.",
    "ozone": "Ozone forms when sunlight cooks traffic and industrial fumes. It stings the lungs, mostly on hot afternoons.",
}
# US EPA AQI bands: (upper bound, level 1-6, label)
AQI_BANDS = [(50, 1, "Good"), (100, 2, "Moderate"), (150, 3, "Unhealthy for sensitive groups"),
             (200, 4, "Unhealthy"), (300, 5, "Very unhealthy"), (10_000, 6, "Hazardous")]
COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
EARTH_KM = 6371.0088
TTL = 30 * 60


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(a))


def bearing(lat1, lon1, lat2, lon2):
    """Compass bearing in degrees from point 1 to point 2."""
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def compass(deg):
    return COMPASS[int((deg + 22.5) // 45) % 8]


def aqi_band(value):
    if value is None:
        return {"level": 0, "label": "Unknown"}
    for upper, level, label in AQI_BANDS:
        if value <= upper:
            return {"level": level, "label": label}


class Air:
    def __init__(self, store, live):
        self.store, self.live = store, live
        self.cache, self.lock = {}, threading.Lock()
        self._sites = None

    # ------------------------------------------------------------ helpers
    def _remember(self, key, build, ttl=TTL):
        with self.lock:
            hit = self.cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        value = build()
        with self.lock:
            self.cache[key] = (time.time(), value)
        return value

    def sites(self):
        """Every persistent industrial cell with its yearly VIIRS glow (2012 onward)."""
        if self._sites is None:
            s = self.store
            frame = s.db.sql(f"""
                SELECT cell, year, SUM(viirs_ind)::DOUBLE AS n, COUNT(*) FILTER (WHERE viirs_ind > 0) AS weeks
                FROM '{s.cellweek}' WHERE viirs_ind IS NOT NULL AND viirs_ind > 0
                GROUP BY cell, year""").df()
            frame = frame[frame.cell.isin(self.live.industrial_cells())]
            last = int(frame.year.max())
            wide = frame.pivot_table(index="cell", columns="year", values="n", fill_value=0)
            weeks = frame[frame.year == last].set_index("cell").weeks
            row, col = np.divmod(wide.index.to_numpy(), N_COLS)
            self._sites = {
                "last": last, "years": [int(y) for y in wide.columns], "cells": wide.index.to_numpy(),
                "lat": -90 + (row + 0.5) * CELL_DEG, "lon": -180 + (col + 0.5) * CELL_DEG,
                "glow": wide.to_numpy(), "weeks": weeks.reindex(wide.index).fillna(0).astype(int).to_numpy(),
            }
        return self._sites

    def nearby(self, lat, lon, radius_km=100):
        s = self.sites()
        dist = haversine(lat, lon, s["lat"], s["lon"])
        idx = np.where(dist <= radius_km)[0]
        idx = idx[np.argsort(dist[idx])]
        last_col = s["years"].index(s["last"])
        lit = set()
        try:
            det = self.live.detections("24h")
            lit = set(det.loc[det.industrial, "cell"].astype(int))
        except Exception:  # live feed down: report the archive only
            pass
        out = []
        for i in idx:
            series = s["glow"][i]
            base = series[:3].mean() if len(series) >= 6 else None
            recent = series[-3:].mean() if len(series) >= 6 else None
            out.append({
                "lat": round(float(s["lat"][i]), 3), "lon": round(float(s["lon"][i]), 3),
                "km": round(float(dist[i]), 1), "bearing": round(bearing(lat, lon, s["lat"][i], s["lon"][i])),
                "glow": int(series[last_col]), "weeks": int(s["weeks"][i]), "lit_now": int(s["cells"][i]) in lit,
                "change": round(float(recent / base - 1), 3) if base and base >= 5 else None,
                "series": [int(v) for v in series],
            })
        return out, s["years"], s["last"]

    def air_quality(self, lat, lon):
        key = f"aq-{lat:.1f}-{lon:.1f}"

        def build():
            r = requests.get(AIR_URL, params={"latitude": lat, "longitude": lon, "current": ",".join(["us_aqi", *POLLUTANTS]),
                                              "hourly": "us_aqi,pm2_5", "forecast_days": 2, "timezone": "auto"}, timeout=40)
            r.raise_for_status()
            j = r.json()
            hourly = j.get("hourly", {})
            now = j["current"]["time"]
            times = hourly.get("time", [])
            start = next((k for k, t in enumerate(times) if t >= now[:13]), 0)
            return {"time": now, "timezone": j.get("timezone"), "current": {k: j["current"].get(k) for k in ["us_aqi", *POLLUTANTS]},
                    "next": [{"time": t, "aqi": a} for t, a in zip(times[start:start + 36], hourly.get("us_aqi", [])[start:start + 36])]}
        return self._remember(key, build)

    def wind(self, lat, lon):
        key = f"wind-{lat:.1f}-{lon:.1f}"

        def build():
            r = requests.get(WIND_URL, params={"latitude": lat, "longitude": lon, "current": "wind_speed_10m,wind_direction_10m",
                                               "timezone": "auto"}, timeout=40)
            r.raise_for_status()
            c = r.json()["current"]
            return {"speed_kmh": c.get("wind_speed_10m"), "from_deg": c.get("wind_direction_10m")}
        return self._remember(key, build)

    def places(self, q):
        r = requests.get(GEOCODE_URL, params={"name": q, "count": 6, "language": "en"}, timeout=20)
        r.raise_for_status()
        return [{"name": p["name"], "admin": p.get("admin1"), "country": p.get("country"), "lat": p["latitude"], "lon": p["longitude"],
                 "population": p.get("population")} for p in r.json().get("results", [])]

    # ------------------------------------------------------------ the report
    def report(self, lat, lon, radius_km=100):
        sites, years, last = self.nearby(lat, lon, radius_km)
        errors = []
        try:
            aq = self.air_quality(lat, lon)
        except requests.RequestException as error:
            aq, errors = None, [f"air quality: {error}"]
        try:
            wind = self.wind(lat, lon)
        except requests.RequestException as error:
            wind = None
            errors.append(f"wind: {error}")
        country = self.store.cells.country.reindex([int(((lat + 90) // CELL_DEG) * N_COLS + (lon + 180) // CELL_DEG)]).iloc[0]
        country = country if isinstance(country, str) and country != "?" else None

        aqi = aq["current"]["us_aqi"] if aq else None
        band = aqi_band(aqi)
        nearest = sites[0] if sites else None
        main = main_site(sites)
        downwind = None
        if main and wind and wind["from_deg"] is not None and (wind["speed_kmh"] or 0) >= 3:
            gap = abs((wind["from_deg"] - main["bearing"] + 180) % 360 - 180)
            downwind = gap <= 45
        exposure = ("close" if nearest and nearest["km"] <= 10 else "near" if nearest and nearest["km"] <= 30
                    else "around" if nearest else "none")
        industry_level = {"close": 3 if downwind else 2, "near": 2 if downwind else 1, "around": 1, "none": 1}[exposure]
        level = max(band["level"] or 1, industry_level)

        worst = None
        if aq:
            ratios = {k: (aq["current"][k] or 0) / WHO[k] for k in POLLUTANTS if aq["current"].get(k) is not None}
            if ratios:
                k = max(ratios, key=ratios.get)
                worst = {"key": k, "name": NAMES[k], "value": aq["current"][k], "who": WHO[k], "times": round(ratios[k], 1)}

        return {
            "point": {"lat": lat, "lon": lon, "country": country},
            "verdict": {"level": level, "air": band, "aqi": aqi, "industry": exposure, "downwind": downwind,
                        "title": VERDICTS[level][0], "line": VERDICTS[level][1]},
            "air": aq, "wind": wind, "worst": worst,
            "sites": sites[:25], "site_count": len(sites), "main_site": main, "lit_now": sum(s["lit_now"] for s in sites),
            "years": years, "year": last, "radius_km": radius_km,
            "facts": facts(sites, aq, wind, worst, downwind, last, years),
            "steps": precautions(band["level"], exposure, downwind, worst),
            "errors": errors,
            "sources": "Air quality and wind: Open-Meteo (CAMS model estimates, 10-45 km grid). Industrial sites: NASA FIRMS VIIRS, 2012 onward.",
        }


VERDICTS = {
    1: ("Breathe easy", "The air is clean right now and no big industrial heat source is pushing smoke your way."),
    2: ("Mostly fine", "Most people can carry on as normal. Sensitive people should keep an eye on it."),
    3: ("Take care", "Sensitive people should cut down time outdoors. Everyone else: no long, hard exercise outside."),
    4: ("Unhealthy air", "Everyone may start to feel it. Spend less time outside and keep indoor air clean."),
    5: ("Very unhealthy", "Stay indoors as much as you can, and protect children, older people and anyone with asthma."),
    6: ("Hazardous", "This is an emergency level. Stay inside with windows shut and follow local health advice."),
}


def main_site(sites):
    """The site that matters most: the brightest within 50 km, else the nearest."""
    close = [s for s in sites if s["km"] <= 50]
    return max(close, key=lambda s: s["glow"]) if close else (sites[0] if sites else None)


def facts(sites, aq, wind, worst, downwind, last, years):
    """Plain-language facts, each tagged good / bad / warn / info."""
    out = []
    if aq and aq["current"].get("us_aqi") is not None:
        a = aq["current"]["us_aqi"]
        band = aqi_band(a)
        tone = "good" if band["level"] == 1 else "warn" if band["level"] <= 3 else "bad"
        text = f"US air quality index {a:.0f}: {band['label'].lower()}."
        if worst and worst["times"] >= 1:
            text += f" The biggest problem is {worst['name']}: {worst['value']:.0f} µg/m³, {worst['times']:.1f}× the WHO 24-hour guideline of {worst['who']}."
        elif worst:
            text += f" Every pollutant is under the WHO 24-hour guidelines; the highest is {worst['name']} at {worst['times'] * 100:.0f}% of its limit."
        out.append({"tone": tone, "icon": "gauge", "title": "The air right now", "text": text})
        nxt = [h["aqi"] for h in aq.get("next", []) if h["aqi"] is not None]
        if len(nxt) >= 12:
            peak = max(nxt[:24]); low = min(nxt[:24])
            if peak - a >= 25:
                out.append({"tone": "warn", "icon": "clock", "title": "Getting worse later",
                            "text": f"The forecast climbs to {peak:.0f} within a day. Plan outdoor time for the cleaner hours."})
            elif a - low >= 25:
                out.append({"tone": "good", "icon": "clock", "title": "Getting better soon",
                            "text": f"The forecast drops to {low:.0f} within a day."})
        if worst and worst["times"] >= 1:
            out.append({"tone": "info", "icon": "lungs", "title": f"About {worst['name'].split(' (')[0]}", "text": HARM[worst["key"]]})

    if not sites:
        out.append({"tone": "good", "icon": "factory", "title": "No industrial heat nearby",
                    "text": f"Satellites saw no gas flare, refinery or steel plant glowing within 100 km of here in {last}."})
    else:
        n, m = sites[0], main_site(sites)
        lit = sum(s["lit_now"] for s in sites)
        text = f"The closest is {n['km']:.0f} km to the {compass(n['bearing'])}. It glowed in {n['weeks']} of 52 weeks in {last}" + (
            ", and it is glowing today." if n["lit_now"] else ".")
        if m is not n:
            text += f" The brightest, {m['km']:.0f} km to the {compass(m['bearing'])}, glowed in {m['weeks']} weeks" + (
                " and is glowing today." if m["lit_now"] else ".")
        if len(sites) > 1 and lit:
            text += f" {lit} of the {len(sites)} were glowing in the last 24 hours."
        out.append({"tone": "bad" if n["km"] <= 10 else "warn" if n["km"] <= 30 else "info", "icon": "factory",
                    "title": f"{len(sites)} industrial heat source{'s' if len(sites) != 1 else ''} within 100 km", "text": text})
        n = m
        if wind and wind["from_deg"] is not None:
            wfrom = compass(wind["from_deg"])
            if downwind:
                out.append({"tone": "bad" if n["km"] <= 30 else "warn", "icon": "wind", "title": "The wind is bringing it your way",
                            "text": f"Wind from the {wfrom} at {wind['speed_kmh']:.0f} km/h carries air from that site toward you."})
            elif downwind is False:
                out.append({"tone": "good", "icon": "wind", "title": "The wind is on your side",
                            "text": f"Wind from the {wfrom} at {wind['speed_kmh']:.0f} km/h pushes that site's fumes away from you."})
            else:
                out.append({"tone": "info", "icon": "wind", "title": "Calm air", "text": "There is almost no wind, so fumes linger close to where they start."})
        # Compare total glow of all nearby sites, so one tiny site's big percentage can't dominate.
        series = np.array([s["series"] for s in sites], dtype=float)
        base, recent = (series[:, :3].sum(), series[:, -3:].sum()) if series.shape[1] >= 6 else (0, 0)
        if base >= 30:
            total = recent / base - 1
            if total <= -0.15:
                out.append({"tone": "good", "icon": "trend", "title": "Flaring is going down here",
                            "text": f"Sites near you glowed {abs(total) * 100:.0f}% less in {years[-3]}-{years[-1]} than in {years[0]}-{years[2]}. Less gas burned means less soot and NO2."})
            elif total >= 0.15:
                out.append({"tone": "bad", "icon": "trend", "title": "Flaring is going up here",
                            "text": f"Sites near you glowed {total * 100:.0f}% more in {years[-3]}-{years[-1]} than in {years[0]}-{years[2]}."})
        if n["km"] <= 30:
            out.append({"tone": "info", "icon": "flare", "title": "What a flare puts in the air",
                        "text": "A flare burns gas that oil fields cannot use. Burned badly, it gives off black soot, nitrogen dioxide and, from sour gas, sulphur dioxide. Gas with hydrogen sulphide smells like rotten eggs."})
        out.append({"tone": "good", "icon": "leaf", "title": "Better burned than leaked",
                    "text": "A flame is still better than letting the gas escape. Unburned methane warms the planet about 80 times more than CO2 over 20 years."})
    return out


STEP_TEXT = {
    "open": ("Open the windows", "Let the clean air in while it lasts."),
    "outside": ("Enjoy being outside", "It is a good day for a walk, sport or play."),
    "watch": ("Check again later", "Air changes by the hour. Look again before a long run or a picnic."),
    "sensitive": ("Go easy if you have asthma", "People with asthma, heart or lung disease: take breaks and keep outdoor exercise light."),
    "indoor-sport": ("Move hard exercise indoors", "Running and football pull far more air deep into your lungs."),
    "inhaler": ("Keep your inhaler close", "If you use asthma or heart medicine, carry it with you today."),
    "close": ("Close windows and doors", "Keep the outside air outside, especially in the evening when it settles."),
    "purifier": ("Clean the air inside", "Run an air purifier with a HEPA filter, or set the air conditioner to recirculate."),
    "mask": ("Wear a real mask outside", "A well-fitted N95 or FFP2 mask filters fine particles. Cloth and surgical masks barely do."),
    "check-on": ("Check on others", "Call older relatives, neighbours and anyone with asthma. Keep children's play indoors."),
    "stay-in": ("Stay indoors", "Make one room your clean-air room: windows shut, purifier on."),
    "no-smoke": ("Don't add smoke inside", "Skip frying, incense, candles and cigarettes while the air is bad."),
    "doctor": ("Know the warning signs", "Chest pain, tight breathing or dizziness? Get medical help right away."),
    "report": ("Smell rotten eggs or see black smoke?", "Go inside, close the windows, and report the flare to your local environment office."),
}


def precautions(air_level, exposure, downwind, worst):
    if air_level <= 1:
        keys = ["open", "outside", "watch"]
    elif air_level == 2:
        keys = ["sensitive", "watch"]
    elif air_level == 3:
        keys = ["sensitive", "indoor-sport", "inhaler", "watch"]
    elif air_level == 4:
        keys = ["close", "indoor-sport", "purifier", "mask", "check-on"]
    else:
        keys = ["stay-in", "close", "purifier", "no-smoke", "mask", "doctor"]
    if exposure == "close" or (exposure == "near" and downwind):
        if "open" in keys:
            keys.remove("open")
        keys.insert(1 if air_level <= 2 else len(keys), "report")
        if downwind and "close" not in keys:
            keys.insert(0, "close")
    return [{"key": k, "title": STEP_TEXT[k][0], "text": STEP_TEXT[k][1]} for k in keys]
