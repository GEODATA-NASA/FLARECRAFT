/* Ember Almanac — the app. Four chapters (History, Right now, Severity, Industry) and Flick's guided tours. */
const App = (() => {
  const $ = (id) => document.getElementById(id);
  const tip = $("tooltip"), busy = $("busy");
  const fmt = d3.format(",.0f"), short = d3.format(".2~s");
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const PLACES = [
    { label: "Nile Delta", name: "the Nile Delta", bbox: [29.5, 30.0, 32.6, 31.7] },
    { label: "Amazon", name: "the Amazon", bbox: [-66, -14, -46, -6] },
    { label: "Sahel", name: "the Sahel", bbox: [-10, 6, 30, 15] },
    { label: "Punjab", name: "Punjab", bbox: [72.5, 29, 77.5, 32.6] },
    { label: "California", name: "California", bbox: [-124.5, 32.5, -114, 42] },
    { label: "Siberia", name: "Siberia", bbox: [105, 56, 140, 70] },
    { label: "Borneo & Sumatra", name: "Borneo and Sumatra", bbox: [95, -6, 119, 6] },
    { label: "Australia", name: "south-east Australia", bbox: [140, -39, 154, -28] },
    { label: "Whole world", name: "the world" },
  ];
  const TABS = ["history", "now", "severity", "industry"];
  const GEODATA_URL = new URLSearchParams(location.search).get("map") || `${location.protocol}//${location.hostname}:8000/`;

  const state = { tab: "history", meta: null, current: null, area: PLACES[PLACES.length - 1], selected: null, annualMode: "harmonized",
                  live: null, liveWindow: "24h", sev: null, outlook: null, industry: null, indCountry: null };
  const maps = {}, layers = {};

  /* ================================================================ helpers */
  const api = async (url) => {
    busy.classList.add("on");
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      return await r.json();
    } finally { busy.classList.remove("on"); }
  };
  const query = (a) => (a.country ? `country=${encodeURIComponent(a.country)}` : a.bbox ? `bbox=${a.bbox.join(",")}` : "");
  const weekDate = (w) => { const d = new Date(Date.UTC(2001, 0, 1 + w * 7)); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const dark = () => css("color-scheme") === "dark";
  const ramp = () => d3.interpolateRgbBasis(css("--cal-ramp").split(",").map((s) => s.trim()));
  const sevColor = (p) => (p >= 0.6 ? css("--hot") : p >= 0.3 ? css("--mid") : css("--mild"));
  const place = (country, lat, lon) => country || `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
  function showTip(html, e) {
    tip.innerHTML = html; tip.style.opacity = 1;
    tip.style.left = `${Math.min(e.clientX + 16, innerWidth - 290)}px`; tip.style.top = `${Math.min(e.clientY + 16, innerHeight - 150)}px`;
  }
  const hideTip = () => { tip.style.opacity = 0; };
  function toast(text) {
    const t = $("toast"); t.textContent = text; t.classList.add("on");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("on"), 3400);
  }
  const facts = (id, items) => {
    $(id).innerHTML = items.map((f) => `<div class="fact ${f.loading ? "loading" : ""}"><p class="k">${f.k}</p><p class="v ${f.accent ? "accent" : ""}">${f.v}</p><p class="d">${f.d || ""}</p></div>`).join("");
  };
  const loadingFacts = (id, labels) => facts(id, labels.map((k) => ({ k, v: "…", d: "Loading", loading: true })));
  function bars(id, rows, { color = "", onClick } = {}) {
    const max = d3.max(rows, (r) => r.value) || 1;
    $(id).innerHTML = rows.length ? rows.map((r, i) => `<div class="bar-row ${r.on ? "on" : ""}" data-i="${i}"><span class="name">${r.name}</span>
      <span class="track"><span class="fill ${color}" style="width:${(100 * r.value / max).toFixed(1)}%"></span></span><span class="num">${r.label ?? fmt(r.value)}</span></div>`).join("")
      : `<p class="empty">Nothing to show here yet.</p>`;
    if (onClick) $(id).querySelectorAll(".bar-row").forEach((el) => el.addEventListener("click", () => onClick(rows[+el.dataset.i])));
  }

  /* ================================================================ maps */
  function baseLayer() {
    return L.tileLayer(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark() ? "Dark" : "Light"}_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
      { attribution: "Basemap &copy; Esri · Fires: NASA FIRMS", maxZoom: 10 });
  }
  function getMap(id, view = [[15, 10], 1.5]) {
    if (!maps[id]) {
      maps[id] = L.map(id, { worldCopyJump: true, preferCanvas: true, zoomSnap: 0.5 }).setView(...view);
      maps[id].base = baseLayer().addTo(maps[id]);
      layers[id] = L.layerGroup().addTo(maps[id]);
    }
    setTimeout(() => maps[id].invalidateSize(), 50);
    return maps[id];
  }

  /* ================================================================ chapter 1: history */
  async function loadArea(next) {
    state.area = next;
    $("place-name").textContent = next.name || next.label;
    $("export").href = `/api/export.csv?${query(next)}`;
    document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", b.dataset.label === next.label));
    drawAoi();
    try {
      state.current = await api(`/api/calendar?${query(next)}`);
    } catch (err) {
      facts("glance", [{ k: "Nothing to show", v: "No fires", d: err.message.includes("no fire") ? "Satellites recorded no fires here. Try a bigger area." : err.message }]);
      return;
    }
    $("year-pick").innerHTML = state.current.years.slice().reverse().map((y) => `<option>${y}</option>`).join("");
    renderHistory();
    const c = state.current;
    selectWeek(c.years[c.years.length - 1], c.season ? c.season.peak : 30);
  }

  function renderHistory() {
    if (!state.current) return;
    renderGlance(); renderCalendar(); renderSeason(+$("year-pick").value); renderAnnual(); renderValidation();
  }

  function renderGlance() {
    const c = state.current, items = [], s = c.season, o = c.outlook, t = c.trends.harmonized, u = c.unusual_months[0];
    items.push(s ? { k: "Fire season", v: `${weekDate(s.start)} – ${weekDate(s.end)}`, d: `Busiest around ${weekDate(s.peak)}.` }
                 : { k: "Fire season", v: "Too few fires", d: "Not enough burning here to find a season." });
    if (o) items.push({ k: "Next 4 weeks", v: o.in_critical ? "Fire season" : "Quieter time", accent: o.in_critical, d: `${Math.round(o.share_of_year * 100)}% of a year's fires usually happen now.` });
    items.push(!t ? { k: "Is it changing?", v: "Not enough years", d: "We need at least six years to tell." }
      : t.significant ? { k: "Is it changing?", v: t.pct_per_decade > 0 ? "More fires" : "Fewer fires", accent: t.pct_per_decade > 0,
          d: `${Math.abs(t.pct_per_decade).toFixed(0)}% ${t.pct_per_decade > 0 ? "more" : "fewer"} every ten years since ${c.climatology_years[0]}.` }
      : { k: "Is it changing?", v: "No clear change", d: `Ups and downs since ${c.climatology_years[0]}, but no steady trend.` });
    const inClim = c.years.map((y, i) => (c.climatology_years.includes(y) ? c.annual.harmonized[i] : -1));
    const best = c.years[inClim.indexOf(Math.max(...inClim))];
    items.push(u ? { k: "Most unusual", v: `${MONTHS_LONG[u.month]} ${u.year}`, accent: true, d: `${u.ratio.toFixed(1)}× a normal ${MONTHS_LONG[u.month]}. Busiest year: ${best}.` }
                 : { k: "Busiest year", v: `${best ?? "—"}`, d: "No single month stood far above normal." });
    facts("glance", items);
  }

  function renderCalendar() {
    const root = d3.select("#calendar"); root.selectAll("*").remove();
    const c = state.current, { values, observed, anomaly } = c.calendar, years = c.years;
    const width = Math.max(640, $("calendar").clientWidth), left = 44, top = 30;
    const cw = (width - left - 4) / 52, ch = Math.max(11, Math.min(20, cw * 0.95));
    const all = values.flat().filter((v) => v > 0).sort(d3.ascending);
    const hi = d3.quantile(all, 0.995) || 1, lo = Math.max(0.5, d3.quantile(all, 0.05) || 0.5);
    const r = ramp(), empty = css("--cal-empty");
    const color = (v) => (v <= 0 ? empty : r(Math.min(1, Math.max(0, Math.log(v / lo) / Math.log(hi / lo)))));
    const svg = root.append("svg").attr("width", width).attr("height", top + years.length * ch + 4);
    svg.append("defs").append("pattern").attr("id", "hatch").attr("width", 5).attr("height", 5).attr("patternUnits", "userSpaceOnUse")
      .attr("patternTransform", "rotate(45)").append("line").attr("y2", 5).attr("stroke", dark() ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.55)").attr("stroke-width", 1.8);
    MONTHS.forEach((m, i) => svg.append("text").attr("class", "cal-month").attr("x", left + (i * 52 / 12) * cw).attr("y", 14).text(m));
    if (c.season) c.season.critical_weeks.forEach((w) => svg.append("rect").attr("x", left + w * cw).attr("y", top - 9).attr("width", cw + 0.4).attr("height", 3).attr("rx", 1.5).attr("fill", css("--accent")));
    years.forEach((year, ri) => {
      const y = top + ri * ch;
      svg.append("text").attr("class", "cal-year").attr("x", left - 8).attr("y", y + ch * 0.72).attr("text-anchor", "end").text(year);
      const row = svg.append("g");
      row.selectAll("rect").data(values[ri].map((v, w) => ({ v, w, year, r: ri }))).join("rect")
        .attr("class", "cal-cell").attr("x", (d) => left + d.w * cw).attr("y", y).attr("width", cw - 1.5).attr("height", ch - 1.5).attr("rx", 2.5).attr("fill", (d) => color(d.v))
        .on("mousemove", calTip).on("mouseleave", hideTip).on("click", (e, d) => selectWeek(d.year, d.w));
      if (!observed[ri]) row.append("rect").attr("x", left).attr("y", y).attr("width", cw * 52 - 1.5).attr("height", ch - 1.5).attr("fill", "url(#hatch)").attr("pointer-events", "none");
      anomaly[ri].forEach((z, w) => {
        if (z > 3 && values[ri][w] >= 5) svg.append("circle").attr("cx", left + w * cw + cw / 2 - 0.75).attr("cy", y + ch / 2 - 0.75).attr("r", Math.min(cw, ch) * 0.26)
          .attr("fill", "none").attr("stroke", dark() ? "#fff" : "#1d1d1f").attr("stroke-width", 1.4).attr("pointer-events", "none");
      });
    });
    const vr = years.indexOf(c.viirs_start);
    if (vr > 0) svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", top + vr * ch - 0.8).attr("y2", top + vr * ch - 0.8).attr("stroke", css("--label-3")).attr("stroke-dasharray", "2 3");
    $("cal-legend").innerHTML = `Fewer <span class="bar"></span> More fires`;
    $("cal-sub").textContent = `Each row is a year. Each square is one week. ${dark() ? "Brighter" : "Darker"} means more fires.`;
  }

  function calTip(e, d) {
    const c = state.current, lo = c.weekly.lo[d.r][d.w], hi = c.weekly.hi[d.r][d.w], normal = c.climatology.median[d.w], z = c.calendar.anomaly[d.r][d.w];
    const times = normal > 0.5 ? d.v / normal : null;
    const compare = times == null ? "" : times >= 1.15 ? `${times.toFixed(1)}× a normal week` : times <= 0.85 ? "quieter than a normal week" : "about normal for this week";
    showTip(`<div class="t-head">Week of ${weekDate(d.w)} ${d.year}</div><div class="t-val">${d.v < 1 ? "No fires" : `${fmt(d.v)} hotspots`}</div>
      ${d.v >= 1 ? `<div class="sub">likely ${fmt(lo)} to ${fmt(hi)} · ${compare}</div>` : ""}${z > 3 ? `<span class="t-tag">Unusually busy week</span><br>` : ""}
      <span class="sub">${c.calendar.observed[d.r] ? "Seen by VIIRS" : "Rebuilt from the older MODIS satellite"}</span>`, e);
  }

  function initHistoryMap() {
    const map = getMap("map");
    if (map.drawReady) return;
    map.drawReady = true;
    let start = null, box = null;
    const stop = () => { $("draw").classList.remove("on"); $("map").classList.remove("drawing"); map.dragging.enable(); };
    $("draw").addEventListener("click", () => {
      const on = !$("draw").classList.contains("on");
      $("draw").classList.toggle("on", on); $("map").classList.toggle("drawing", on);
      if (on) { map.dragging.disable(); toast("Drag on the map to draw your area"); } else stop();
    });
    map.on("mousedown", (e) => { if ($("draw").classList.contains("on")) { start = e.latlng; box = L.rectangle([start, start], { color: "#ea580c", weight: 2 }).addTo(map); } });
    map.on("mousemove", (e) => { if (start && box) box.setBounds([start, e.latlng]); });
    map.on("mouseup", (e) => {
      if (!start) return;
      const b = L.latLngBounds(start, e.latlng); box.remove(); start = null; stop();
      const [w, s, ea, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => +v.toFixed(2));
      if (n - s < 0.3 || ea - w < 0.3) { toast("That area is too small. Try a bigger box."); return; }
      loadArea({ label: "Your area", name: "your area", bbox: [w, s, ea, n] });
    });
  }
  function drawAoi() {
    const map = maps.map;
    if (!map) return;
    if (map.aoi) map.aoi.remove();
    const a = state.area;
    if (a.bbox) {
      const [w, s, e, n] = a.bbox;
      map.aoi = L.rectangle([[s, w], [n, e]], { color: "#ea580c", weight: 2, fill: false, dashArray: "6 5" }).addTo(map);
      map.fitBounds(map.aoi.getBounds(), { padding: [24, 24], maxZoom: 7 });
    } else if (!a.country) map.setView([15, 10], 1.5);
  }
  async function selectWeek(year, week) {
    state.selected = { year, week };
    d3.selectAll("#calendar .cal-cell").classed("selected", (d) => d.year === year && d.w === week);
    const from = Math.max(0, week - 1), to = Math.min(51, week + 1), a = state.area;
    const layer = await api(`/api/map?year=${year}&week_from=${from}&week_to=${to}${a.bbox ? `&bbox=${a.bbox.join(",")}` : ""}`).catch(() => null);
    if (!layer || !maps.map || state.selected.year !== year || state.selected.week !== week) return;
    layers.map.clearLayers();
    const max = d3.max(layer.points, (p) => p[2]) || 1, r = ramp();
    for (const [lat, lon, v, ind] of layer.points.slice(0, 8000)) {
      if (v >= 0.5) L.circleMarker([lat, lon], { radius: 2 + 5 * Math.sqrt(v / max), stroke: false, fillColor: r(0.45 + 0.55 * Math.sqrt(v / max)), fillOpacity: 0.85 }).addTo(layers.map);
      if (ind > 2) L.circleMarker([lat, lon], { radius: 3, stroke: false, fillColor: css("--flare"), fillOpacity: 0.9 }).addTo(layers.map);
    }
    $("map-caption").textContent = `${weekDate(from)} to ${weekDate(to)} ${year}${layer.observed ? "" : " · rebuilt from MODIS"}`;
  }

  function axes(svg, x, y, W, H, m, { yfmt = short, xticks, xfmt } = {}) {
    svg.append("g").attr("class", "axis grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(yfmt).tickSize(-(W - m.l - m.r))).call((g) => g.select(".domain").remove());
    const bottom = d3.axisBottom(x).tickSize(0);
    if (xticks) bottom.tickValues(xticks);
    if (xfmt) bottom.tickFormat(xfmt);
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(bottom).call((g) => g.select(".domain").remove()).selectAll("text").attr("dy", "1.2em");
  }

  function renderSeason(year) {
    const el = $("season"), c = state.current.climatology, ri = state.current.years.indexOf(year);
    d3.select(el).selectAll("*").remove();
    const W = el.clientWidth || 520, H = 300, m = { t: 12, r: 8, b: 26, l: 44 };
    const x = d3.scaleLinear().domain([0, 51]).range([m.l, W - m.r]);
    const vals = ri >= 0 ? state.current.calendar.values[ri] : [];
    const y = d3.scaleLinear().domain([0, d3.max([...c.p90, ...vals]) * 1.08 || 1]).nice().range([H - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
    if (state.current.season) state.current.season.critical_weeks.forEach((w) => svg.append("rect").attr("x", x(w - 0.5)).attr("width", x(1) - x(0) + 0.5).attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", css("--accent-soft")));
    axes(svg, x, y, W, H, m, { xticks: d3.range(12).map((i) => Math.round(i * 52 / 12)), xfmt: (w) => MONTHS[Math.round(w * 12 / 52)] });
    const wk = d3.range(52);
    svg.append("path").datum(wk).attr("fill", dark() ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)").attr("d", d3.area().x((w) => x(w)).y0((w) => y(c.p10[w])).y1((w) => y(c.p90[w])).curve(d3.curveMonotoneX));
    svg.append("path").datum(wk).attr("fill", "none").attr("stroke", css("--label-3")).attr("stroke-width", 2).attr("d", d3.line().x((w) => x(w)).y((w) => y(c.median[w])).curve(d3.curveMonotoneX));
    if (ri >= 0) svg.append("path").datum(wk).attr("fill", "none").attr("stroke", css("--accent")).attr("stroke-width", 2.6).attr("d", d3.line().x((w) => x(w)).y((w) => y(vals[w])).curve(d3.curveMonotoneX));
  }

  function renderAnnual() {
    const el = $("annual");
    d3.select(el).selectAll("*").remove();
    if (!$("expert").open || !state.current) return;
    const a = state.current.annual, years = state.current.years, raw = state.annualMode === "raw";
    const W = el.clientWidth || 520, H = 260, m = { t: 12, r: 8, b: 24, l: 44 };
    const x = d3.scaleBand().domain(years).range([m.l, W - m.r]).padding(0.2);
    const y = d3.scaleLinear().domain([0, d3.max(raw ? [...a.naive, ...a.modis] : [...a.naive, ...a.hi]) * 1.05 || 1]).nice().range([H - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
    axes(svg, x, y, W, H, m, { xticks: years.filter((v) => v % 4 === 3) });
    svg.selectAll(".bar").data(years.map((yr, i) => ({ yr, v: a.naive[i], i }))).join("rect")
      .attr("x", (d) => x(d.yr)).attr("width", x.bandwidth()).attr("y", (d) => y(d.v)).attr("height", (d) => y(0) - y(d.v)).attr("rx", 3)
      .attr("fill", (d) => (d.yr >= state.current.viirs_start ? "#fb923c" : "#a1a1a6")).attr("fill-opacity", raw ? 0.85 : 0.35)
      .on("mousemove", (e, d) => showTip(`<div class="t-head">${d.yr}</div><div>Raw record: <strong>${fmt(d.v)}</strong></div>
        <div>Harmonized: <strong>${fmt(a.harmonized[d.i])}</strong> (${fmt(a.lo[d.i])}–${fmt(a.hi[d.i])})</div><div>MODIS alone: ${fmt(a.modis[d.i])}</div>`, e)).on("mouseleave", hideTip);
    const pts = years.map((yr, i) => [x(yr) + x.bandwidth() / 2, i]);
    if (!raw) {
      svg.append("path").datum(pts).attr("fill", css("--accent-soft")).attr("d", d3.area().x((d) => d[0]).y0((d) => y(a.lo[d[1]])).y1((d) => y(a.hi[d[1]])).curve(d3.curveMonotoneX));
      svg.append("path").datum(pts).attr("fill", "none").attr("stroke", css("--accent")).attr("stroke-width", 2.6).attr("d", d3.line().x((d) => d[0]).y((d) => y(a.harmonized[d[1]])).curve(d3.curveMonotoneX));
    } else {
      svg.append("path").datum(pts).attr("fill", "none").attr("stroke", css("--label-2")).attr("stroke-width", 2.2).attr("d", d3.line().x((d) => d[0]).y((d) => y(a.modis[d[1]])).curve(d3.curveMonotoneX));
    }
    const p = (t) => (t ? `${t.pct_per_decade > 0 ? "+" : ""}${t.pct_per_decade.toFixed(0)}% per decade (p = ${t.p_value.toFixed(2)})` : "not enough years");
    const j = state.current.jump;
    $("annual-note").innerHTML = raw ? "Line: MODIS alone, the only sensor covering every year. It sees fewer fires, and its satellites' orbits drifted after 2020."
      : `${j ? `Joined end to end, the raw record jumps <strong>${j.naive_ratio.toFixed(1)}×</strong> when VIIRS arrives; harmonized, the change is ${j.harmonized_ratio.toFixed(2)}×. ` : ""}
         Trend, raw: <strong>${p(state.current.trends.naive)}</strong>. Harmonized: <strong>${p(state.current.trends.harmonized)}</strong> (Theil–Sen slope, Mann–Kendall test).`;
  }

  function renderValidation() {
    const rows = (state.meta && state.meta.validation) || [], el = $("validation");
    if (!rows.length) { el.innerHTML = `<p class="sub">These results appear once the full 2003–2025 record is processed.</p>`; return; }
    if (!$("expert").open) return;
    const model = d3.median(rows, (r) => r.model_month_mdape), glob = d3.median(rows, (r) => r.global_month_mdape), cov = state.meta.band_coverage && state.meta.band_coverage.month;
    el.innerHTML = `<p class="sub">Each year was rebuilt from MODIS while hidden from training, then compared with what VIIRS really saw.</p>
      <div class="stats"><div><div class="big">${model.toFixed(0)}%</div><div class="sub">median error, region by month</div></div>
      <div><div class="num">${glob.toFixed(0)}%</div><div class="sub">with one fixed factor (×${state.meta.global_ratio.toFixed(1)})</div></div>
      ${cov ? `<div><div class="num">${(cov * 100).toFixed(0)}%</div><div class="sub">of true values inside the 80% band</div></div>` : ""}</div><div id="val-chart" class="chart short"></div>`;
    const W = $("val-chart").clientWidth || 500, H = 190, m = { t: 8, r: 8, b: 22, l: 36 };
    const x = d3.scaleBand().domain(rows.map((r) => r.year)).range([m.l, W - m.r]).padding(0.25);
    const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => Math.max(r.model_month_mdape, r.global_month_mdape)) * 1.1]).range([H - m.b, m.t]);
    const svg = d3.select("#val-chart").append("svg").attr("width", W).attr("height", H);
    axes(svg, x, y, W, H, m, { yfmt: (d) => `${d}%`, xticks: rows.map((r) => r.year).filter((v, i) => i % 2 === 0) });
    const bw = x.bandwidth() / 2;
    svg.selectAll(".g").data(rows).join("rect").attr("x", (r) => x(r.year)).attr("width", bw - 1).attr("rx", 2).attr("y", (r) => y(r.global_month_mdape)).attr("height", (r) => y(0) - y(r.global_month_mdape)).attr("fill", "#a1a1a6");
    svg.selectAll(".m").data(rows).join("rect").attr("x", (r) => x(r.year) + bw).attr("width", bw - 1).attr("rx", 2).attr("y", (r) => y(r.model_month_mdape)).attr("height", (r) => y(0) - y(r.model_month_mdape)).attr("fill", css("--accent"));
  }

  /* ================================================================ chapter 2: right now */
  async function loadNow(window = state.liveWindow) {
    state.liveWindow = window;
    document.querySelectorAll("#now-window button").forEach((b) => b.classList.toggle("on", b.dataset.w === window));
    loadingFacts("now-glance", ["Fire hotspots", "Strong fires", "Factories & flares", "Busiest country"]);
    try { state.live = await api(`/api/live?window=${window}`); }
    catch (err) { facts("now-glance", [{ k: "Live data", v: "Unavailable", d: err.message }]); return; }
    renderNow();
  }
  function renderNow() {
    const l = state.live;
    if (!l) return;
    $("now-lede").textContent = `Fires spotted by NASA's VIIRS satellites between ${l.oldest} and ${l.newest}. Refreshed every few hours.`;
    const top = l.countries[0];
    facts("now-glance", [
      { k: "Fire hotspots", v: fmt(l.fires), accent: true, d: "spotted from space in this window" },
      { k: "Strong fires", v: fmt(l.severe), d: "giving off 10 megawatts or more" },
      { k: "Factories & flares", v: fmt(l.industrial), d: "glowing at known industrial sites, not counted as fires" },
      { k: "Busiest country", v: top ? top.country : "—", d: top ? `${fmt(top.fires)} hotspots` : "country names arrive with the full record" },
    ]);
    const map = getMap("now-map"), group = layers["now-map"], r = ramp();
    group.clearLayers();
    const cells = l.cells.slice().sort((a, b) => b[2] - a[2]), maxN = d3.max(cells, (c) => c[2]) || 1;
    let drawn = 0;
    for (const [lat, lon, n, frp, ind] of cells) {
      if (ind) { L.circleMarker([lat, lon], { radius: 3, stroke: false, fillColor: css("--flare"), fillOpacity: 0.85 }).addTo(group); continue; }
      if (drawn++ > 9000) continue;
      const strength = Math.min(1, Math.log1p(frp) / Math.log1p(300));
      L.circleMarker([lat, lon], { radius: 1.6 + 5 * Math.sqrt(n / maxN), stroke: false, fillColor: r(0.35 + 0.65 * strength), fillOpacity: 0.85 })
        .bindTooltip(`${fmt(n)} hotspot${n === 1 ? "" : "s"} · strongest ${frp.toFixed(0)} MW`).addTo(group);
    }
    $("now-biggest").innerHTML = l.biggest.map((b, i) => `<div class="row" data-i="${i}"><span class="badge ${b.frp >= 100 ? "hot" : ""}">${fmt(b.frp)} MW</span>
      <span class="what">${place(b.country, b.lat, b.lon)}<small>${fmt(b.n)} hotspots in the same 25 km square</small></span></div>`).join("");
    $("now-biggest").querySelectorAll(".row").forEach((el) => el.addEventListener("click", () => { const b = l.biggest[+el.dataset.i]; map.flyTo([b.lat, b.lon], 7); el.scrollIntoView({ block: "nearest" }); }));
    bars("now-countries", l.countries.map((c) => ({ name: c.country, value: c.fires })));
  }

  /* ================================================================ chapter 3: severity */
  async function loadSeverity() {
    loadingFacts("sev-glance", ["Fires scored", "Ranking skill", "Flagged as likely severe", "Severe fires caught"]);
    const [sev, out] = await Promise.allSettled([api("/api/live/severity"), api("/api/outlook")]);
    state.sev = sev.status === "fulfilled" ? sev.value : null;
    state.outlook = out.status === "fulfilled" ? out.value : null;
    if (!state.sev) facts("sev-glance", [{ k: "GeoData AI model", v: "Offline", d: `${sev.reason.message} Start it with start.cmd.` }]);
    renderSeverity();
  }
  function renderSeverity() {
    const s = state.sev, o = state.outlook;
    if (s) {
      facts("sev-glance", [
        { k: "Fires scored", v: fmt(s.scored), d: "burning right now, picked at random" },
        { k: "Ranking skill", v: pct(s.auc), accent: true, d: "of the time it ranks a severe fire above a mild one" },
        { k: "Flagged as likely severe", v: fmt(s.flagged), d: `${pct(s.flagged_right)} of them really were severe` },
        { k: "Severe fires caught", v: pct(s.severe_caught), d: "of all severe fires were flagged" },
      ]);
      getMap("sev-map");
      const group = layers["sev-map"];
      group.clearLayers();
      for (const [lat, lon, p, frp, n] of s.points.slice().sort((a, b) => a[2] - b[2])) {
        L.circleMarker([lat, lon], { radius: 2.5 + 3 * p + Math.min(3, Math.sqrt(n)), stroke: false, fillColor: sevColor(p), fillOpacity: 0.85 })
          .bindTooltip(`Model: ${Math.round(p * 100)}% chance severe · measured ${frp.toFixed(0)} MW`).addTo(group);
      }
      calibration(s);
      $("sev-watch").innerHTML = s.watchlist.map((w, i) => `<div class="row" data-i="${i}"><span class="badge hot">${Math.round(w.p * 100)}%</span>
        <span class="what">${place(w.country, w.lat, w.lon)}<small>measured ${w.frp.toFixed(0)} MW${w.frp >= 10 ? ": the model was right" : ""}</small></span></div>`).join("");
      $("sev-watch").querySelectorAll(".row").forEach((el) => el.addEventListener("click", () => { const w = s.watchlist[+el.dataset.i]; maps["sev-map"].flyTo([w.lat, w.lon], 7); }));
    }
    if (o) {
      $("out-sub").innerHTML = `${o.label}: where fires usually burn in these weeks (from the calendar) &times; how fierce they tend to be (from the model).`;
      getMap("out-map");
      const group = layers["out-map"];
      group.clearLayers();
      const maxU = d3.max(o.points, (p) => p[2]) || 1;
      for (const [lat, lon, usual, p] of o.points) {
        L.circleMarker([lat, lon], { radius: 1.5 + 6 * Math.sqrt(usual / maxU), stroke: false, fillColor: sevColor(p), fillOpacity: 0.8 })
          .bindTooltip(`Usually ${fmt(usual)} hotspots these weeks · ${Math.round(p * 100)}% look severe`).addTo(group);
      }
      bars("out-countries", o.countries.map((c) => ({ name: c.country, value: c.severe, label: `~${fmt(c.severe)}` })));
    } else {
      $("out-countries").innerHTML = `<p class="empty">The outlook needs the GeoData AI model. Start it with start.cmd.</p>`;
    }
  }
  function calibration(s) {
    const el = $("sev-calib"), rows = s.calibration.filter((r) => r.fires > 0);
    d3.select(el).selectAll("*").remove();
    const W = el.clientWidth || 480, H = 220, m = { t: 10, r: 8, b: 30, l: 40 };
    const x = d3.scaleBand().domain(rows.map((r) => r.range)).range([m.l, W - m.r]).padding(0.3);
    const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
    axes(svg, x, y, W, H, m, { yfmt: d3.format(".0%") });
    svg.selectAll(".b").data(rows).join("rect").attr("x", (r) => x(r.range)).attr("width", x.bandwidth()).attr("rx", 4)
      .attr("y", (r) => y(r.actually_severe)).attr("height", (r) => y(0) - y(r.actually_severe)).attr("fill", (r, i) => sevColor(i / 4 + 0.05))
      .on("mousemove", (e, r) => showTip(`<div class="t-head">Model said ${r.range}</div><div class="t-val">${pct(r.actually_severe)}</div><div class="sub">really were severe (${fmt(r.fires)} fires)</div>`, e))
      .on("mouseleave", hideTip);
    svg.append("text").attr("x", W / 2).attr("y", H - 2).attr("text-anchor", "middle").text("what the model said →");
    const lowR = rows[0], highR = rows[rows.length - 1];
    $("sev-calib-note").innerHTML = `When the model said <strong>${highR.range}</strong>, ${pct(highR.actually_severe)} really were severe. When it said <strong>${lowR.range}</strong>, only ${pct(lowR.actually_severe)} were.`;
  }

  /* ================================================================ chapter 4: industry */
  async function loadIndustry() {
    loadingFacts("ind-glance", ["Industrial hotspots", "Sites", "Glows most", "Today"]);
    try { state.industry = await api("/api/industry"); } catch (err) { facts("ind-glance", [{ k: "Industry", v: "Unavailable", d: err.message }]); return; }
    if (!state.live) api(`/api/live?window=24h`).then((v) => { state.live = v; renderIndustry(); }).catch(() => {});
    renderIndustry();
  }
  function renderIndustry() {
    const d = state.industry;
    if (!d) return;
    const total = (d.global.find((g) => g[0] === d.year) || [0, 0])[1], top = d.ranking[0];
    facts("ind-glance", [
      { k: `Industrial hotspots in ${d.year}`, v: fmt(total), d: "hot pixels at flares, refineries and plants" },
      { k: "Sites", v: fmt(d.sites.length), d: "places that glowed again and again" },
      { k: "Glows most", v: top ? top[0] : "—", accent: !!top, d: top ? `${fmt(top[1])} hotspots in ${d.year}` : "country names arrive with the full record" },
      { k: "Today", v: state.live ? fmt(state.live.industrial) : "…", d: "seen at known sites in the last day" },
    ]);
    getMap("ind-map", [[26, 40], 2]);
    const group = layers["ind-map"], maxN = d3.max(d.sites, (s) => s[2]) || 1;
    group.clearLayers();
    for (const [lat, lon, n, weeks, country] of d.sites) {
      L.circleMarker([lat, lon], { radius: 2 + 7 * Math.sqrt(n / maxN), stroke: false, fillColor: css("--flare"), fillOpacity: 0.75 })
        .bindTooltip(`${country && country !== "?" ? country + " · " : ""}${fmt(n)} hot pixels in ${d.year}, glowing in ${weeks} weeks`).addTo(group);
    }
    $("ind-sub").textContent = `${fmt(d.sites.length)} sites that glowed again and again in ${d.year}. Bigger dots glowed more.`;
    bars("ind-ranking", d.ranking.map(([c, n]) => ({ name: c, value: n, on: c === state.indCountry })), { color: "flare", onClick: (r) => { state.indCountry = r.name; renderIndustry(); } });
    trend();
  }
  function trend() {
    const d = state.industry, el = $("ind-trend"), series = state.indCountry ? d.series[state.indCountry] : d.global;
    $("ind-trend-title").textContent = state.indCountry ? `${state.indCountry} over the years` : "The whole world over the years";
    d3.select(el).selectAll("*").remove();
    if (!series || series.length < 2) { d3.select(el).append("p").attr("class", "empty").text("The trend appears once the full 2012–2025 record is processed."); return; }
    const W = el.clientWidth || 480, H = 220, m = { t: 10, r: 10, b: 26, l: 44 };
    const x = d3.scaleLinear().domain(d3.extent(series, (s) => s[0])).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, d3.max(series, (s) => s[1]) * 1.1]).nice().range([H - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
    axes(svg, x, y, W, H, m, { xfmt: d3.format("d"), xticks: series.map((s) => s[0]).filter((v, i) => i % 3 === 0) });
    svg.append("path").datum(series).attr("fill", "none").attr("stroke", css("--flare")).attr("stroke-width", 2.6).attr("d", d3.line().x((s) => x(s[0])).y((s) => y(s[1])).curve(d3.curveMonotoneX));
    svg.selectAll("circle").data(series).join("circle").attr("cx", (s) => x(s[0])).attr("cy", (s) => y(s[1])).attr("r", 3.5).attr("fill", css("--flare"));
  }

  /* ================================================================ tabs */
  const loaded = {};
  async function switchTab(name, { push = true } = {}) {
    if (!TABS.includes(name)) name = "history";
    state.tab = name;
    document.querySelectorAll(".tabs button").forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    document.querySelectorAll("section.tab").forEach((s) => (s.hidden = s.dataset.tab !== name));
    if (push && location.hash !== `#${name}`) history.pushState(null, "", `#${name}`);
    scrollTo(0, 0);
    Voice.pop();
    anime({ targets: `section.tab[data-tab="${name}"] > *`, opacity: [0, 1], translateY: [10, 0], delay: anime.stagger(40), duration: 420, easing: "easeOutQuad" });
    Object.values(maps).forEach((m) => setTimeout(() => m.invalidateSize(), 60));
    if (!loaded[name]) {
      loaded[name] = true;
      if (name === "history") { initHistoryMap(); await loadArea(state.area); }
      if (name === "now") await loadNow();
      if (name === "severity") await loadSeverity();
      if (name === "industry") await loadIndustry();
    }
    Guide.autoStart(name);
  }

  function rerenderAll() {
    renderHistory(); renderNow(); renderSeverity(); renderIndustry();
    if (state.selected) selectWeek(state.selected.year, state.selected.week);
  }
  function toggleTheme() {
    const next = dark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("ember-theme", next); } catch (e) {}
    Object.values(maps).forEach((m) => { m.base.remove(); m.base = baseLayer().addTo(m); m.base.bringToBack(); });
    rerenderAll();
  }
  async function openGeoData() {
    try { await fetch(`${GEODATA_URL}health`, { mode: "no-cors", cache: "no-store" }); location.href = GEODATA_URL; }
    catch { toast("The GeoData AI map isn't running yet. Start it with start.cmd, then try again."); }
  }

  /* ================================================================ Flick's guided tours */
  const TOURS = {
    history: [
      { at: ".tabs", mood: "happy", say: "Welcome to the app! These four tabs are the same chapters as the story: <strong>History</strong>, <strong>Right now</strong>, <strong>Severity</strong> and <strong>Industry</strong>." },
      { at: 'section[data-tab="history"] .hero', mood: "happy", say: "Let's start with the past. Type a country or tap a place. I'll pick the <strong>Nile Delta</strong> for us, close to home!", run: () => loadArea(PLACES[0]) },
      { at: "#glance", mood: "wow", say: "These cards answer the big questions in plain words: when's the fire season, what's coming up, is it changing, and what was unusual." },
      { at: "#calendar-card", mood: "proud", say: "And here's the fire calendar! Each row is a year, each square is a week. Circled squares were unusually busy." },
      { at: "#history-map-card", mood: "happy", say: "Tap any square and I'll show that week on this map. You can even draw your own area!" },
      { at: "#season-card", mood: "think", say: "This one compares any year with a normal year. Was it early? Late? Worse than usual?" },
      { at: "#expert", mood: "wink", say: "Scientists can open this drawer for the method, the proof and the data download." },
      { at: '.tabs [data-tab="now"]', mood: "wow", say: "That was the past. Now let's see what's burning <strong>right now</strong>! Press <strong>→</strong>.", next: "now" },
    ],
    now: [
      { at: "#now-glance", mood: "wow", say: "These numbers are fresh from NASA: every fire hotspot spotted in the last day or so." },
      { at: "#now-map-card", mood: "happy", say: "Every dot is a fire burning now. The blue ones are factories and gas flares. We learned to spot them from 23 years of history!" },
      { at: "#now-biggest-card", mood: "worried", say: "These are the strongest fires right now. Tap one and I'll fly the map there." },
      { at: "#now-countries-card", mood: "think", say: "And this is where it's burning most today." },
      { at: '.tabs [data-tab="severity"]', mood: "proud", say: "But which of these fires could turn dangerous? Let's ask our model! Press <strong>→</strong>.", next: "severity" },
    ],
    severity: [
      { at: "#sev-glance", mood: "proud", say: "Our GeoData AI model scored today's fires. Then we checked its answers against what the satellites really measured." },
      { at: "#sev-map-card", mood: "think", say: "<strong>Red</strong> means likely severe, <strong>yellow</strong> means mild. Firefighters can look at the red ones first." },
      { at: "#sev-trust-card", mood: "wink", say: "Can we trust it? When the model says 'very likely', most of those fires really were severe. Honest numbers, no magic!" },
      { at: "#sev-watch-card", mood: "worried", say: "This is the watch list: the fires the model is most worried about right now." },
      { at: "#outlook-card", mood: "worried", say: "And this looks ahead: where severe fires are most likely in the next four weeks, using the calendar and the model together." },
      { at: ".link-card", mood: "happy", say: "Want every detail? This opens our first project, the full GeoData AI map." },
      { at: '.tabs [data-tab="industry"]', mood: "wink", say: "One last secret: satellites see more than fires! Press <strong>→</strong>.", next: "industry" },
    ],
    industry: [
      { at: "#ind-map-card", mood: "wink", say: "These glowing spots aren't wildfires. They're gas flares, refineries and steel plants that burn all year." },
      { at: "#ind-rank-card", mood: "think", say: "Here's where they glow most. Tap a country and I'll show its story over the years." },
      { at: "#ind-trend-card", mood: "proud", say: "If the line goes down, fewer hot flares were spotted. That usually means less gas burned off into the air." },
      { at: ".foot", mood: "laugh", say: "That's the whole tour! Press <strong>Guide me</strong> any time and I'll come back. Bye for now!" },
    ],
  };

  const Guide = (() => {
    let dlg = null, tab = null, i = 0, spot = null;
    const box = $("app-dlg"), fab = $("flick-fab");
    const off = () => { try { return localStorage.getItem("ember-guide-off") === "1"; } catch (e) { return false; } };
    const seen = (t) => { try { return localStorage.getItem(`ember-toured-${t}`) === "1"; } catch (e) { return false; } };
    const mark = (t) => { try { localStorage.setItem(`ember-toured-${t}`, "1"); } catch (e) {} };
    function ensure() {
      if (!dlg) dlg = new Dialogue(box, { onNext: next, onBack: back, size: 96 });
    }
    function show(k) {
      const steps = TOURS[tab], step = steps[k];
      i = k;
      if (spot) spot.classList.remove("spot");
      spot = document.querySelector(step.at);
      if (spot) {
        spot.classList.add("spot");
        if (!spot.closest(".nav")) spot.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      }
      $("dlg-step").textContent = `${k + 1}/${steps.length}`;
      box.querySelector(".dlg-back").disabled = k === 0;
      if (step.run) step.run();
      dlg.say(step.say, step.mood);
    }
    function start(t) {
      ensure();
      tab = t; mark(t);
      box.hidden = false; fab.hidden = true;
      anime({ targets: box, opacity: [0, 1], translateY: [20, 0], duration: 350, easing: "easeOutQuad" });
      Voice.chime();
      show(0);
    }
    function next() {
      const steps = TOURS[tab], step = steps[i];
      if (step.next) { end(false); switchTab(step.next).then(() => start(step.next)); return; }
      if (i + 1 < steps.length) show(i + 1); else end(false);
    }
    function back() { if (i > 0) show(i - 1); }
    function end(disable) {
      if (spot) spot.classList.remove("spot");
      spot = null; box.hidden = true; fab.hidden = false;
      if (dlg) dlg.finish(true);
      if (disable) try { localStorage.setItem("ember-guide-off", "1"); } catch (e) {}
    }
    function autoStart(t) { if (!off() && !seen(t) && box.hidden) setTimeout(() => start(t), 700); }
    function keys(e) {
      if (box.hidden || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      if (["ArrowRight", "Enter"].includes(e.key)) { e.preventDefault(); dlg.advance(next); }
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Escape") end(false);
    }
    $("dlg-close").addEventListener("click", (e) => { e.stopPropagation(); end(true); toast("Okay! Tap 'Guide me' whenever you want me back."); });
    fab.addEventListener("click", () => { try { localStorage.removeItem("ember-guide-off"); } catch (e) {} start(state.tab); });
    addEventListener("keydown", keys);
    return { start, autoStart, end };
  })();

  /* ================================================================ init */
  async function init() {
    $("foot-flick").innerHTML = Flick.svg(40);
    $("fab-face").innerHTML = Flick.svg(40, "wink");
    $("presets").innerHTML = PLACES.map((p) => `<button data-label="${p.label}">${p.label}</button>`).join("");
    document.querySelectorAll("#presets button").forEach((b, i) => b.addEventListener("click", () => loadArea(PLACES[i])));
    $("annual-toggle").innerHTML = `<button class="on" data-m="harmonized">Harmonized</button><button data-m="raw">Raw</button>`;
    document.querySelectorAll("#annual-toggle button").forEach((b) => b.addEventListener("click", () => {
      state.annualMode = b.dataset.m; document.querySelectorAll("#annual-toggle button").forEach((o) => o.classList.toggle("on", o === b)); renderAnnual();
    }));
    document.querySelectorAll("#now-window button").forEach((b) => b.addEventListener("click", () => loadNow(b.dataset.w)));
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    addEventListener("popstate", () => switchTab(location.hash.slice(1), { push: false }));
    $("year-pick").addEventListener("change", (e) => renderSeason(+e.target.value));
    $("print").addEventListener("click", () => { $("expert").open = true; renderAnnual(); renderValidation(); setTimeout(print, 250); });
    $("replay").addEventListener("click", () => { Guide.end(false); $("app").hidden = true; Story.open(show); });
    $("theme").addEventListener("click", toggleTheme);
    $("to-geodata").addEventListener("click", openGeoData);
    $("expert").addEventListener("toggle", () => { if ($("expert").open) { renderAnnual(); renderValidation(); } });
    $("search").addEventListener("change", (e) => {
      const name = e.target.value.trim(), match = [...$("country-list").options].find((o) => o.value.toLowerCase() === name.toLowerCase());
      if (match) loadArea({ label: match.value, name: match.value, country: match.value });
      else if (name) toast(`We couldn't find "${name}". Pick a country from the list.`);
    });
    let resizeTimer;
    addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(rerenderAll, 200); });
    const [meta] = await Promise.all([api("/api/meta"), api("/api/countries").then((list) => { $("country-list").innerHTML = list.map((c) => `<option value="${c}">`).join(""); })]);
    state.meta = meta;
  }

  function show(opts = {}) {
    $("app").hidden = false;
    const wanted = location.hash.slice(1);
    if (opts.tour) { try { TABS.forEach((t) => localStorage.removeItem(`ember-toured-${t}`)); localStorage.removeItem("ember-guide-off"); } catch (e) {} }
    switchTab(TABS.includes(wanted) ? wanted : "history", { push: false });
  }

  return { init, show };
})();

App.init().catch((err) => console.error(err)).finally(() => {
  if (new URLSearchParams(location.search).has("app") || location.hash) App.show();
  else Story.open(App.show);
});
