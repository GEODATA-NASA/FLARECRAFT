/* GeoFlare: the router for the three apps (Dashboard, Fires, Air), the Dashboard itself, and Flick's tours. */
const App = (() => {
  const { $, fmt, short, pct, MONTHS, MONTHS_LONG, api, css, dark, ramp, place, showTip, hideTip, toast, facts, loadingFacts, bars, axes, getMap, layers, maps } = UI;
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
  const VIEWS = ["fires", "air"];
  // Fires sub-sections and the tab each belongs to. "severe" opens from Today's button and stays under Now > Today.
  const FSUBS = { history: "past", archive: "past", today: "now", severe: "now", outlook: "now" };
  const FTABS = { past: [["history", "History"], ["archive", "2025 archive"]], now: [["today", "Today"], ["outlook", "Next 4 weeks"]] };
  const OLD_SUBS = { now: "today", explore: "archive" };   // links from before the Dashboard was folded into Fires
  const weekDate = (w) => { const d = new Date(Date.UTC(2001, 0, 1 + w * 7)); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  const query = (a) => (a.country ? `country=${encodeURIComponent(a.country)}` : a.bbox ? `bbox=${a.bbox.join(",")}` : "");

  const state = { view: null, pane: "history", meta: null, current: null, area: PLACES[PLACES.length - 1], selected: null, annualMode: "harmonized",
                  live: null, liveWindow: "24h", ranks: null, leaderDir: "best" };
  let dashFlick = null, nowFlick = null;

  /* ================================================================ history */
  async function loadArea(next) {
    state.area = next;
    $("place-name").textContent = next.name || next.label;
    $("export").href = `/api/export.csv?${query(next)}`;
    document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", b.dataset.label === next.label));
    drawAoi();
    renderLeader();
    try {
      state.current = await api(`/api/calendar?${query(next)}`);
    } catch (err) {
      facts("glance", [{ k: "Nothing to show", v: "No fires", d: err.message.includes("no fire") ? "Satellites recorded no fires here. Try a bigger area." : err.message }]);
      dashFlick && dashFlick.say(`Hmm, satellites saw no fires in ${next.name || next.label}. Try a bigger area, or pick a country.`, "think");
      return;
    }
    $("year-pick").innerHTML = state.current.years.slice().reverse().map((y) => `<option>${y}</option>`).join("");
    renderHistory();
    const c = state.current;
    selectWeek(c.years[c.years.length - 1], c.season ? c.season.peak : 30);
    explainArea();
  }

  /* Flick sums the place up in plain words: the useful sentence, not a description of the screen. */
  function explainArea() {
    const c = state.current, a = state.area, name = a.name || a.label, s = c.season, o = c.outlook, t = c.trends.harmonized, u = c.unusual_months[0];
    const bits = [];
    if (s) bits.push(`In ${name}, fire season runs from <strong>${weekDate(s.start)} to ${weekDate(s.end)}</strong>, busiest around ${weekDate(s.peak)}.`);
    else bits.push(`${name[0].toUpperCase() + name.slice(1)} doesn't burn much, so there's no clear fire season.`);
    if (o) bits.push(o.in_critical ? "That's <strong>right now</strong>, so keep an eye out." : "Right now is a quieter time.");
    if (t && t.significant) bits.push(`Fires here are ${t.pct_per_decade > 0 ? "<strong>rising</strong>" : "falling"}: about ${Math.abs(t.pct_per_decade).toFixed(0)}% ${t.pct_per_decade > 0 ? "more" : "fewer"} every ten years.`);
    else if (t) bits.push("Year to year it goes up and down, with no steady trend.");
    if (u) bits.push(`The strangest month was ${MONTHS_LONG[u.month]} ${u.year}, with ${u.ratio.toFixed(1)}× the usual fires.`);
    const mood = o && o.in_critical ? "worried" : t && t.significant && t.pct_per_decade > 0 ? "worried" : "happy";
    dashFlick && dashFlick.say(bits.join(" "), mood);
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
    const layer = await api(`/api/map?year=${year}&week_from=${from}&week_to=${to}${a.bbox || a.country ? `&${query(a)}` : ""}`).catch(() => null);
    if (!layer || !maps.map || state.selected.year !== year || state.selected.week !== week) return;
    layers.map.clearLayers();
    const max = d3.max(layer.points, (p) => p[2]) || 1, r = ramp();
    const pts = [];
    for (const [lat, lon, v, ind] of layer.points.slice(0, 8000)) {
      if (v >= 0.5) { L.circleMarker([lat, lon], { radius: 2 + 5 * Math.sqrt(v / max), stroke: false, fillColor: r(0.45 + 0.55 * Math.sqrt(v / max)), fillOpacity: 0.85 }).addTo(layers.map); pts.push([lat, lon]); }
      if (ind > 2) L.circleMarker([lat, lon], { radius: 3, stroke: false, fillColor: css("--flare"), fillOpacity: 0.9 }).addTo(layers.map);
    }
    if (a.country && pts.length) maps.map.fitBounds(L.latLngBounds(pts), { padding: [20, 20], maxZoom: 6 });
    $("map-caption").textContent = `${weekDate(from)} to ${weekDate(to)} ${year}${layer.observed ? "" : " · rebuilt from MODIS"}`;
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

  /* ================================================================ leaderboard */
  async function loadLeader() {
    try { state.ranks = await api("/api/rankings"); } catch (err) { $("leader-card").hidden = true; return; }
    $("leader-sub").textContent = `Countries with the fewest severe fires and the least factory heat for their size, ${state.ranks.year}. ${state.ranks.ranked_countries} countries ranked.`;
    renderLeader();
  }
  function renderLeader() {
    const r = state.ranks;
    if (!r) return;
    const rows = r.countries.filter((c) => c.ranked), worst = state.leaderDir === "worst", mine = state.area.country;
    const list = (key, rank, value, unit) => {
      const sorted = rows.slice().sort((a, b) => (worst ? b[value] - a[value] : a[value] - b[value])).slice(0, 5);
      $(key).innerHTML = sorted.map((c) => `<li class="${c.country === mine ? "on" : ""}" data-c="${UI.esc(c.country)}"><span class="lb-rank">${c[rank]}</span>
        <span class="lb-name">${UI.esc(c.country)}</span><span class="lb-val">${c[value] < 0.05 ? "0" : c[value] < 10 ? c[value].toFixed(1) : fmt(c[value])}<small>${unit}</small></span></li>`).join("");
      $(key).querySelectorAll("li").forEach((li) => li.addEventListener("click", () => loadArea({ label: li.dataset.c, name: li.dataset.c, country: li.dataset.c })));
    };
    list("leader-fire", "severe_rank", "severe_per_1k", "");
    list("leader-ind", "ind_rank", "ind_per_1k", "");
    const me = mine && r.countries.find((c) => c.country === mine);
    $("leader-you").innerHTML = me && me.ranked
      ? `<strong>${UI.esc(mine)}</strong> ranks <strong>#${me.severe_rank}</strong> of ${r.ranked_countries} for fewest severe fires (${me.severe_per_1k.toFixed(1)} per 1,000 km²) and <strong>#${me.ind_rank}</strong> for cleanest from industry. <a href="/air" data-view="air">Check the air where you live &rarr;</a>`
      : me ? `${UI.esc(mine)} is too small to rank fairly: a handful of hot pixels would swing it.` : "Pick a country above to see where it ranks.";
  }

  /* ================================================================ right now */
  async function loadNow(window = state.liveWindow) {
    state.liveWindow = window;
    document.querySelectorAll("#now-window button").forEach((b) => b.classList.toggle("on", b.dataset.w === window));
    loadingFacts("now-glance", ["Fire hotspots", "Strong fires", "Factories & flares", "Busiest country"]);
    const q = new URLSearchParams({ window, sat: $("now-sat").value, conf: $("now-conf").value, daynight: $("now-dn").value, min_frp: $("now-frp").value });
    const ticket = (state.nowTicket = (state.nowTicket || 0) + 1);   // only the latest request may draw
    try { const live = await api(`/api/live?${q}`); if (ticket !== state.nowTicket) return; state.live = live; }
    catch (err) {
      if (ticket !== state.nowTicket) return;
      const empty = /empty|match/i.test(err.message);
      facts("now-glance", [{ k: "Live data", v: empty ? "No fires" : "Unavailable", d: err.message }]);
      nowFlick && nowFlick.say(empty ? `${UI.esc(err.message)} Try another satellite or loosen a switch.` : "NASA's live feed isn't answering right now. Try again in a few minutes.", "worried");
      return;
    }
    renderNow();
  }
  function renderNow() {
    const l = state.live;
    if (!l) return;
    $("now-lede").textContent = `Fires spotted by NASA's VIIRS ${l.satellite} satellite between ${l.oldest} and ${l.newest}.`;
    const f = l.filters || {};
    $("now-source").textContent = `Source: NASA FIRMS near-real-time feed, VIIRS ${l.satellite}, about 3 hours behind the satellite. Fetched ${l.fetched.replace("T", " ").replace("+00:00", " UTC")}. `
      + `Showing ${fmt(l.shown_detections)} of ${fmt(l.raw_detections)} detections${f.conf === "nh" ? " (nominal and high confidence, as in the archive)" : ""}.`;
    const top = l.countries[0], big = l.biggest[0];
    facts("now-glance", [
      { k: "Fire hotspots", v: fmt(l.fires), accent: true, d: "spotted from space in this window" },
      { k: "Strong fires", v: fmt(l.severe), d: "giving off 10 megawatts or more" },
      { k: "Factories & flares", v: fmt(l.industrial), d: "glowing at known industrial sites, not counted as fires" },
      { k: "Busiest country", v: top ? top.country : "—", d: top ? `${fmt(top.fires)} hotspots` : "" },
    ]);
    nowFlick && nowFlick.say(`${state.liveWindow === "24h" ? "In the last day" : "This week"} satellites spotted <strong>${fmt(l.fires)} fires</strong>. ${fmt(l.severe)} of them were strong.`
      + (big ? ` The fiercest is in ${place(big.country, big.lat, big.lon)}, giving off ${fmt(big.frp)} MW. Tap it in the list and I'll fly you there.` : "")
      + ` Want to know which could turn severe? Press <a href="/fires#severe" data-view="fires">See which could turn severe</a>.`, "wow");
    const map = getMap("now-map"), group = layers["now-map"], r = ramp();
    group.clearLayers();
    const cells = l.cells.slice().sort((a, b) => b[2] - a[2]), maxN = d3.max(cells, (c) => c[2]) || 1;
    let drawn = 0;
    for (const [lat, lon, n, frp, ind] of cells) {
      if (ind && !$("now-ind").checked) continue;
      if (ind) { L.circleMarker([lat, lon], { radius: 3, stroke: false, fillColor: css("--flare"), fillOpacity: 0.85 }).bindTooltip("Gas flare or factory, not a wildfire").addTo(group); continue; }
      if (drawn++ > 9000) continue;
      const strength = Math.min(1, Math.log1p(frp) / Math.log1p(300));
      L.circleMarker([lat, lon], { radius: 1.6 + 5 * Math.sqrt(n / maxN), stroke: false, fillColor: r(0.35 + 0.65 * strength), fillOpacity: 0.85 })
        .bindTooltip(`${fmt(n)} hotspot${n === 1 ? "" : "s"} · strongest ${frp.toFixed(0)} MW`).addTo(group);
    }
    $("now-biggest").innerHTML = l.biggest.map((b, i) => `<div class="row" data-i="${i}"><span class="badge ${b.frp >= 100 ? "hot" : ""}">${fmt(b.frp)} MW</span>
      <span class="what">${place(b.country, b.lat, b.lon)}<small>${fmt(b.n)} hotspots in the same 25 km square</small></span></div>`).join("");
    $("now-biggest").querySelectorAll(".row").forEach((el) => el.addEventListener("click", () => { const b = l.biggest[+el.dataset.i]; map.flyTo([b.lat, b.lon], 7); $("now-map-card").scrollIntoView({ behavior: "smooth", block: "center" }); }));
    bars("now-countries", l.countries.map((c) => ({ name: c.country, value: c.fires })));
  }

  /* ================================================================ router */
  const loaded = {};
  function parse() {
    const first = location.pathname.replace(/^\/+/, "").split("/")[0];
    const hash = location.hash.slice(1), view = first === "air" ? "air" : "fires";
    if (view === "air") return { view, sub: hash };
    const sub = OLD_SUBS[hash] || hash;
    return { view, sub: FSUBS[sub] ? sub : "history" };
  }
  function go(view, sub = "") {
    const url = `/${view}${sub ? `#${sub}` : ""}`;
    if (location.pathname + location.hash !== url) history.pushState(null, "", url);
    route();
  }
  async function route() {
    const { view, sub } = parse();
    state.navs = (state.navs || 0) + (state.view ? 1 : 0);
    const changed = view !== state.view;
    state.view = view;
    document.body.dataset.view = view;
    document.querySelectorAll(".products a").forEach((a) => { const on = a.dataset.view === view; a.classList.toggle("on", on); a.setAttribute("aria-current", on ? "page" : "false"); });
    document.querySelectorAll("section.view").forEach((s) => (s.hidden = s.dataset.view !== view));
    document.title = `GeoFlare ${view[0].toUpperCase() + view.slice(1)} · Team FLARECRAFT`;
    $("back").hidden = false;   // there is always somewhere to go back to: the previous screen, or Fires
    if (changed) {
      scrollTo(0, 0);
      Voice.pop();
      anime({ targets: `section.view[data-view="${view}"] > *`, opacity: [0, 1], translateY: [10, 0], delay: anime.stagger(40), duration: 420, easing: "easeOutQuad" });
    }
    UI.refreshMaps();
    if (view === "fires") await showFires(sub);
    if (view === "air" && window.Air) {
      // Every click on the Air tab starts Flick's Air story; the page itself is built when the story ends, so its maps never draw while hidden.
      if (state.airIntro) { state.airIntro = false; playAirStory(); return; }
      await Air.show(sub);
    }
  }
  async function showFires(sub) {
    const top = FSUBS[sub], shown = sub === "severe" ? "today" : sub;
    state.fsub = sub;
    document.querySelectorAll("#fires-top button").forEach((b) => { const on = b.dataset.top === top; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    $("fires-subs").innerHTML = FTABS[top].map(([key, label]) => `<button role="tab" data-fsub="${key}" class="${key === shown ? "on" : ""}" aria-selected="${key === shown}">${label}</button>`).join("");
    // History and Today are built into the page; the archive, severity and outlook are built by fires.js.
    const pane = sub === "history" ? "history" : sub === "today" ? "now" : null;
    document.querySelectorAll('.view[data-view="fires"] > .pane').forEach((p) => (p.hidden = p.dataset.pane !== pane));
    $("fires-view").hidden = !!pane;
    UI.refreshMaps();
    if (!pane) { if (window.Fires) Fires.show({ archive: "explore", severe: "today", outlook: "outlook" }[sub]); return; }
    if (!loaded[pane]) {
      loaded[pane] = true;
      if (pane === "history") { initHistoryMap(); loadLeader(); await loadArea(state.area); }
      if (pane === "now") await loadNow();
    }
  }
  const tourKey = () => (state.view === "fires" ? `fires-${state.fsub}` : state.view);

  function rerenderAll() {
    renderHistory(); renderNow();
    if (state.selected) selectWeek(state.selected.year, state.selected.week);
  }
  function toggleTheme() {
    const next = dark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("geoflare-theme", next); } catch (e) {}
    UI.themeChanged();
    rerenderAll();
  }

  /* ================================================================ Flick's tours: short, and only on a first visit */
  const TOURS = {
    "fires-history": [
      { at: ".products", mood: "happy", say: "This is GeoFlare. Two apps, one place: <strong>Fires</strong> for the past and the present, <strong>Air</strong> for your health." },
      { at: ".fnav", mood: "think", say: "<strong>Past</strong> holds the history and the 2025 archive. <strong>Now</strong> holds today's fires and the next four weeks." },
      { at: '.pane[data-pane="history"] .hero', mood: "happy", say: "Pick a place. I'll try the <strong>Nile Delta</strong>, close to home!", run: () => loadArea(PLACES[0]) },
      { at: "#dash-flick", mood: "proud", say: "Whenever you pick a place, I'll sum it up for you up here." },
      { at: "#calendar-card", mood: "wow", say: "Every square is one week since 2003. Tap one and the map shows that week." },
      { at: "#leader-card", mood: "wink", say: "And here's who has the fewest severe fires and the cleanest air from industry." },
    ],
    "fires-today": [
      { at: "#now-flick", mood: "wow", say: "These are today's fires, fresh from NASA. I'll tell you the headline up here." },
      { at: "#now-map-card", mood: "happy", say: "The blue dots aren't wildfires. They're gas flares and factories, recognised from the satellite archive. Press <strong>See which could turn severe</strong> to score today's fires." },
    ],
  };
  const tours = (key) => TOURS[key] || (key === "fires-severe" && window.Fires && Fires.tour) || (key === "air" && window.Air && Air.tour) || [];

  const Guide = (() => {
    let dlg = null, key = null, i = 0, spot = null;
    const box = $("app-dlg"), fab = $("flick-fab");
    const off = () => { try { return localStorage.getItem("geoflare-guide-off") === "1"; } catch (e) { return false; } };
    const seen = (t) => { try { return localStorage.getItem(`geoflare-toured-${t}`) === "1"; } catch (e) { return false; } };
    const mark = (t) => { try { localStorage.setItem(`geoflare-toured-${t}`, "1"); } catch (e) {} };
    function show(k) {
      const steps = tours(key), step = steps[k];
      i = k;
      if (spot) spot.classList.remove("spot");
      spot = document.querySelector(step.at);
      if (spot) {
        spot.classList.add("spot");
        if (!spot.closest(".nav")) spot.scrollIntoView({ behavior: "auto", block: "start" });
      }
      // Keep the box off what Flick is talking about: if the section reaches under the box, move the box to the top.
      requestAnimationFrame(() => {
        const r = spot ? spot.getBoundingClientRect() : null, bh = box.offsetHeight + 28;
        box.classList.toggle("top", !!r && r.bottom > innerHeight - bh && r.top > bh + 64);
      });
      $("dlg-step").textContent = `${k + 1}/${steps.length}`;
      box.querySelector(".dlg-back").disabled = k === 0;
      if (step.run) step.run();
      dlg.say(step.say, step.mood);
    }
    function start(k) {
      if (!tours(k).length) return;
      if (!dlg) dlg = new Dialogue(box, { onNext: next, onBack: back, size: 96 });
      key = k; mark(k);
      box.hidden = false; document.body.classList.add("touring");
      anime({ targets: box, opacity: [0, 1], translateY: [20, 0], duration: 350, easing: "easeOutQuad" });
      Voice.chime();
      show(0);
    }
    function next() { if (i + 1 < tours(key).length) show(i + 1); else end(false); }
    function back() { if (i > 0) show(i - 1); }
    function end(disable) {
      if (spot) spot.classList.remove("spot");
      spot = null; box.hidden = true; document.body.classList.remove("touring");
      if (dlg) dlg.finish(true);
      if (disable) try { localStorage.setItem("geoflare-guide-off", "1"); } catch (e) {}
    }
    function autoStart(k) { if (!off() && !seen(k) && box.hidden && tours(k).length) setTimeout(() => { if (tourKey() === k) start(k); }, 900); }
    function keys(e) {
      if (box.hidden || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      if (["ArrowRight", "Enter"].includes(e.key)) { e.preventDefault(); dlg.advance(next); }
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Escape") end(false);
    }
    $("dlg-close").addEventListener("click", (e) => { e.stopPropagation(); end(false); });
    fab.addEventListener("click", () => { try { localStorage.removeItem("geoflare-guide-off"); } catch (e) {} start(tourKey()); });
    addEventListener("keydown", keys);
    return { start, autoStart, end };
  })();

  /* ================================================================ init */
  async function init() {
    dashFlick = UI.flickCard($("dash-flick"));
    nowFlick = UI.flickCard($("now-flick"), { mood: "wow" });
    $("presets").innerHTML = PLACES.map((p) => `<button data-label="${p.label}">${p.label}</button>`).join("");
    document.querySelectorAll("#presets button").forEach((b, i) => b.addEventListener("click", () => loadArea(PLACES[i])));
    $("annual-toggle").innerHTML = `<button class="on" data-m="harmonized">Harmonized</button><button data-m="raw">Raw</button>`;
    document.querySelectorAll("#annual-toggle button").forEach((b) => b.addEventListener("click", () => {
      state.annualMode = b.dataset.m; document.querySelectorAll("#annual-toggle button").forEach((o) => o.classList.toggle("on", o === b)); renderAnnual();
    }));
    document.querySelectorAll("#leader-toggle button").forEach((b) => b.addEventListener("click", () => {
      state.leaderDir = b.dataset.dir; document.querySelectorAll("#leader-toggle button").forEach((o) => o.classList.toggle("on", o === b)); renderLeader();
    }));
    document.querySelectorAll("#now-window button").forEach((b) => b.addEventListener("click", () => loadNow(b.dataset.w)));
    ["now-sat", "now-conf", "now-dn", "now-frp"].forEach((id) => $(id).addEventListener("change", () => loadNow()));
    $("now-ind").addEventListener("change", renderNow);
    document.querySelectorAll("#fires-top button").forEach((b) => b.addEventListener("click", () => go("fires", b.dataset.top === "now" ? "today" : "history")));
    $("fires-subs").addEventListener("click", (e) => { const b = e.target.closest("[data-fsub]"); if (b) go("fires", b.dataset.fsub); });
    // Any link or button with data-view switches app without a page load, so back and forward work.
    document.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-view]");   // links only: <body> and the views carry data-view too
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      const [path, sub = ""] = (a.getAttribute("href") || `/${a.dataset.view}`).split("#");
      if (a.dataset.view === "air" && !sub && state.view !== "air") state.airIntro = true;
      go(path.replace(/^\/+/, "") || a.dataset.view, sub);
    });
    addEventListener("popstate", route);
    addEventListener("hashchange", route);
    $("year-pick").addEventListener("change", (e) => renderSeason(+e.target.value));
    $("print").addEventListener("click", () => { $("expert").open = true; renderAnnual(); renderValidation(); setTimeout(print, 250); });
    $("back").addEventListener("click", () => { if (history.length > 1 && state.navs > 0) history.back(); else go("fires"); });
    $("replay").addEventListener("click", () => { Guide.end(false); $("app").hidden = true; Story.open(show); });
    $("air-story").addEventListener("click", playAirStory);
    $("theme").addEventListener("click", toggleTheme);
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

  /* GeoFlare Air's own story: what flares put in the air, and whether factory heat and wildfires are related. */
  function playAirStory() {
    Guide.end(false);
    $("app").hidden = true;
    Story.openAir((opts = {}) => { $("app").hidden = false; go("air", opts.sub || ""); UI.refreshMaps(); scrollTo(0, 0); });
  }

  /* Called when the story ends (or straight away for /fires and /air). */
  function show(opts = {}) {
    $("app").hidden = false;
    if (opts.tour) { try { Object.keys(localStorage).filter((k) => k.startsWith("geoflare-toured-")).forEach((k) => localStorage.removeItem(k)); localStorage.removeItem("geoflare-guide-off"); } catch (e) {} }
    if (opts.view === "air" && !opts.sub) state.airIntro = true;   // choosing Air at the end of the main story starts the Air story
    if (opts.view) history.replaceState(null, "", `/${VIEWS.includes(opts.view) ? opts.view : "fires"}${opts.sub ? `#${opts.sub}` : ""}`);
    else { const { view, sub } = parse(); history.replaceState(null, "", `/${view}${sub && sub !== "history" ? `#${sub}` : ""}`); }   // old /dashboard links land in Fires
    state.view = null;
    route();
  }

  return { init, show, go, loadArea };
})();

App.init().catch((err) => console.error(err)).finally(() => {
  const path = location.pathname.replace(/^\/+/, "");
  if (new URLSearchParams(location.search).has("app") || path) App.show();
  else Story.open(App.show);
});
