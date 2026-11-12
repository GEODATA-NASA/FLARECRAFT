/* GeoFlare Fires: which fires could turn severe. Three parts:
   Today (live fires scored by the GeoData AI model and graded against measured fire power),
   Next 4 weeks (calendar x model outlook), and Explore the archive (every 2025 fire, filters,
   score-your-own, ask the data). Talks to /api/* and, through the same-origin proxy, /geodata/*. */
const Fires = (() => {
  const $ = (id) => document.getElementById(id);
  const SUBS = ["today", "outlook", "explore"];
  const SOURCES = { modis: "MODIS", viirs_j1: "VIIRS NOAA-20", viirs_suomi: "VIIRS Suomi NPP" };
  const PIXELS = { viirs: { scan: 0.38, track: 0.36 }, modis: { scan: 1.0, track: 1.0 } };
  const FEATURES = { brightness: "How hot the pixel looks", confidence: "Satellite's confidence", scan: "Pixel width", track: "Pixel height",
    acq_time: "Time of day", longitude: "East-west position", latitude: "North-south position", day_of_year: "Time of year",
    rh2m: "Air humidity", gwettop: "Soil wetness", prectotcorr: "Rain", type: "Kind of hotspot" };
  const state = { sub: "today", sev: null, outlook: null, health: null, model: null, features: [], stats: null, filters: null,
                  pin: null, lastProb: 0, ask: { history: [], enabled: false, busy: false }, loaded: {}, offline: false };
  let mounted = false, flick = null;

  const fmt = (v) => UI.fmt(v), pct = (v) => UI.pct(v);
  const dateLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const isOffline = (err) => /offline|not running|not reachable|503/i.test(String(err && err.message));
  const say = (html, mood = "happy") => flick && flick.say(html, mood);

  /* ================================================================ markup */
  const TEMPLATE = `
    <div class="subnav toggle big" id="fires-sub" role="tablist">
      <button data-sub="today" role="tab">Today</button>
      <button data-sub="outlook" role="tab">Next 4 weeks</button>
      <button data-sub="explore" role="tab">Explore the archive</button>
    </div>
    <div class="classic-row"><a class="pill" id="classic-map" href="http://127.0.0.1:8000/">Open the classic map view &rarr;</a></div>

    <div class="pane" data-sub="today">
      <div class="hero">
        <p><a class="pill" href="/fires#today" data-view="fires">&larr; Back to today's map</a></p>
        <p class="chapter">GeoFlare Fires · Now · Today, scored</p>
        <h1>Which fires could turn <span>severe</span>?</h1>
        <p class="lede">Our AI model looks at each fire's heat, place, season and weather, and gives the chance it is a severe fire: 10 megawatts or more. Then we check its answers against what the satellites measured.</p>
      </div>
      <div class="flick-card" data-flick></div>
      <div class="glance" id="fsev-glance"></div>
      <section class="card" id="fsev-map-card">
        <div class="card-head"><div><h2>Today's fires, scored</h2><p class="sub" id="fsev-sub">Each dot is a 25 km square with fires burning now. Tap one and Flick explains it.</p></div>
          <div class="legend"><span class="dot mild"></span>Mild <span class="dot mid"></span>Maybe <span class="dot hot"></span>Likely severe</div></div>
        <div class="map tall" id="fsev-map"></div>
      </section>
      <div class="two">
        <section class="card" id="fsev-trust-card"><div class="card-head"><div><h2>Can we trust it?</h2><p class="sub">We grouped today's fires by what the model said, then counted how many really were severe.</p></div></div>
          <div id="fsev-calib" class="chart short"></div><p class="note" id="fsev-calib-note"></p></section>
        <section class="card" id="fsev-watch-card"><div class="card-head"><div><h2>Watch list</h2><p class="sub">The fires the model worries about most right now. Tap one to fly there.</p></div></div>
          <div class="rows" id="fsev-watch"></div></section>
      </div>
    </div>

    <div class="pane" data-sub="outlook" hidden>
      <div class="hero">
        <p class="chapter">GeoFlare Fires · Now · Next 4 weeks</p>
        <h1>Where should we <span>watch</span> next?</h1>
        <p class="lede" id="fout-lede">Where fires usually burn in the coming four weeks, and how fierce they tend to be there.</p>
      </div>
      <div class="flick-card" data-flick></div>
      <section class="card" id="fout-card">
        <div class="card-head"><div><h2>The next four weeks</h2><p class="sub" id="fout-sub">Bigger dots: more fires usually burn here now. Redder dots: more of them tend to be severe.</p></div>
          <div class="legend"><span class="dot mild"></span>Mostly mild <span class="dot mid"></span>Mixed <span class="dot hot"></span>Often severe</div></div>
        <div class="two flat fout-body">
          <div class="map tall" id="fout-map"></div>
          <div><h3>Most severe fires expected</h3><div class="bars" id="fout-countries"></div>
            <p class="note">A planning guide built from 23 years of fire history and the severity model. It is not a forecast of individual fires.</p></div>
        </div>
      </section>
    </div>

    <div class="pane" data-sub="explore" hidden>
      <div class="hero">
        <p class="chapter">GeoFlare Fires · Past · 2025 archive</p>
        <h1>Look up any fire from <span id="fx-year">2025</span></h1>
        <p class="lede">Every fire NASA's satellites recorded, scored by the model. Pick dates and satellites, or tap the map to score a fire of your own.</p>
      </div>
      <div class="flick-card" data-flick></div>
      <div id="fx-offline" hidden></div>
      <div id="fx-body">
        <section class="card fx-filters" id="fx-filters">
          <form id="fx-form" autocomplete="off">
            <label class="fx-field"><span>From</span><input type="date" id="fx-start" required></label>
            <label class="fx-field"><span>To</span><input type="date" id="fx-end" required></label>
            <div class="fx-field"><span>Satellites</span>
              <div class="fx-chips">${Object.entries(SOURCES).map(([k, v]) => `<label class="fx-chip"><input type="checkbox" name="fx-source" value="${k}" checked><span>${v}</span></label>`).join("")}</div></div>
            <div class="fx-field"><span>Colour by</span>
              <div class="toggle" id="fx-color"><button type="button" class="on" data-mode="severity">Severity</button><button type="button" data-mode="probability">Chance</button><button type="button" data-mode="frp">Power</button><button type="button" data-mode="source">Satellite</button></div></div>
            <label class="fx-field"><span>Dots</span><select id="fx-limit"><option value="2000">Up to 2,000</option><option value="5000" selected>Up to 5,000</option><option value="10000">Up to 10,000</option><option value="25000">Up to 25,000</option></select></label>
            <label class="fx-check"><input type="checkbox" id="fx-viewport"><span>Only the area on screen</span></label>
            <div class="fx-actions"><button type="submit" class="pill strong" id="fx-apply">Show fires</button><button type="button" class="pill" id="fx-reset">Latest week</button></div>
          </form>
        </section>
        <div class="glance" id="fx-glance"></div>
        <div class="fx-grid">
          <section class="card" id="fx-map-card">
            <div class="card-head"><div><h2>The fires on the map</h2><p class="sub" id="fx-map-sub">Tap a dot for its details. Tap anywhere else to score a fire there.</p></div></div>
            <div class="map tall" id="fx-map"></div>
            <div class="sub map-key" id="fx-legend"></div>
          </section>
          <section class="card" id="fx-days-card">
            <div class="card-head"><div><h2>Day by day</h2><p class="sub">Grey: all fires. <span class="accent-text">Red</span>: the severe ones.</p></div></div>
            <div id="fx-days" class="chart short"></div>
            <h3 class="fx-h3">By satellite</h3>
            <div class="bars" id="fx-sources"></div>
          </section>
        </div>
        <div class="two">
          <section class="card" id="fx-score-card">
            <div class="card-head"><div><h2>Score a fire yourself</h2><p class="sub">Tap the map to place it, or fill in what you know. Leave a box empty if you don't know.</p></div></div>
            <form id="fx-score" class="fx-score" autocomplete="off">
              <label class="fx-field"><span>Latitude</span><input type="number" id="fs-lat" step="0.0001" min="-90" max="90" required></label>
              <label class="fx-field"><span>Longitude</span><input type="number" id="fs-lon" step="0.0001" min="-180" max="180" required></label>
              <label class="fx-field"><span>Date</span><input type="date" id="fs-date" required></label>
              <label class="fx-field"><span>Time (UTC, HHMM)</span><input type="number" id="fs-time" min="0" max="2359" placeholder="Don't know? Leave empty"></label>
              <div class="fx-field fx-wide"><span>Which satellite saw it?</span>
                <div class="toggle" id="fs-sensor"><button type="button" class="on" data-sensor="">I don't know</button><button type="button" data-sensor="viirs">VIIRS (375 m)</button><button type="button" data-sensor="modis">MODIS (1 km)</button></div></div>
              <label class="fx-field"><span>Brightness (K)</span><input type="number" id="fs-brightness" step="0.1" min="1" placeholder="Don't know? Leave empty"></label>
              <label class="fx-field"><span>Confidence (%)</span><input type="number" id="fs-confidence" min="0" max="100" placeholder="Don't know? Leave empty"></label>
              <label class="fx-field"><span>Pixel width (km)</span><input type="number" id="fs-scan" step="0.01" min="0.1" placeholder="Don't know? Leave empty"></label>
              <label class="fx-field"><span>Pixel height (km)</span><input type="number" id="fs-track" step="0.01" min="0.1" placeholder="Don't know? Leave empty"></label>
              <label class="fx-field fx-wide"><span>Kind of hotspot</span><select id="fs-type"><option value="0">Vegetation fire</option><option value="1">Volcano</option><option value="2">Factory or other fixed heat</option><option value="3">Offshore platform</option></select></label>
              <div class="fx-actions fx-wide"><button type="submit" class="pill strong" id="fs-go">Score this fire</button></div>
            </form>
            <div class="fx-result" id="fx-result" hidden>
              <div class="fx-result-top"><div><p class="fx-result-label" id="fr-label"></p><p class="sub" id="fr-sub"></p></div>
                <p class="fx-prob"><span id="fr-prob">0</span><small>%</small></p></div>
              <div class="fx-meter" aria-hidden="true"><span id="fr-meter"></span><i id="fr-cut"></i></div>
              <p class="note" id="fr-caution" hidden></p>
              <dl class="fx-kv" id="fr-kv"></dl>
            </div>
          </section>
          <section class="card" id="fx-model-card">
            <div class="card-head"><div><h2>What the model looks at</h2><p class="sub">How much each clue counts in the score.</p></div></div>
            <div class="bars" id="fx-importance"></div>
            <p class="note" id="fx-extent"></p>
          </section>
        </div>
        <section class="card" id="fx-ask-card" hidden>
          <div class="card-head"><div><h2>Ask about the data</h2><p class="sub">Questions in plain words. The answer is looked up in the fire records and the model.</p></div></div>
          <div class="fx-thread" id="fx-thread" aria-live="polite"></div>
          <form id="fx-ask" class="fx-ask" autocomplete="off">
            <label class="visually-hidden" for="fx-q">Your question</label>
            <textarea id="fx-q" rows="2" maxlength="2000" placeholder="Which region had the most severe fires in August?"></textarea>
            <div class="chips" id="fx-suggest">
              <button type="button">How did severe fires change month by month?</button>
              <button type="button">Which satellite sees the strongest fires?</button>
              <button type="button">How reliable is the severity model?</button>
            </div>
            <div class="fx-actions"><button type="submit" class="pill strong" id="fx-ask-go">Ask</button><button type="button" class="pill" id="fx-ask-reset" hidden>Start over</button></div>
          </form>
        </section>
      </div>
    </div>`;

  function offlineCard(message) {
    return `<section class="card fx-offline-card"><h2>The GeoData AI service isn't running</h2>
      <p class="sub">${UI.esc(message || "")}</p><p>Start it with <strong>start.cmd</strong> (it runs on port 8000), then reload this page.</p></section>`;
  }

  /* ================================================================ today */
  async function loadToday() {
    UI.loadingFacts("fsev-glance", ["Fires scored", "Ranking skill", "Flagged as likely severe", "Severe fires caught"]);
    try { state.sev = await UI.api("/api/live/severity"); }
    catch (err) {
      UI.facts("fsev-glance", [{ k: "GeoData AI model", v: "Offline", d: `${UI.esc(err.message)} Start it with start.cmd.` }]);
      if (state.sub === "today") say("My model friend is asleep right now. Start the GeoData AI service with <strong>start.cmd</strong> and I'll score today's fires for you.", "worried");
      return;
    }
    renderToday();
    if (state.sub === "today") sayToday();
  }
  function sayToday() {
    const s = state.sev;
    if (!s) return;
    say(`I checked <strong>${fmt(s.scored)}</strong> fires burning right now. The model flags <strong>${fmt(s.flagged)}</strong> as likely severe, and ${pct(s.flagged_right)} of those really were.
      It caught ${pct(s.severe_caught)} of all the severe ones. Tap any dot and I'll tell you how it did there.`, s.auc >= 0.8 ? "proud" : "think");
  }
  function renderToday() {
    const s = state.sev;
    if (!s) return;
    UI.facts("fsev-glance", [
      { k: "Fires scored", v: fmt(s.scored), d: "burning now, picked at random" },
      { k: "Ranking skill", v: pct(s.auc), accent: true, d: "of the time it ranks a severe fire above a mild one" },
      { k: "Flagged as likely severe", v: fmt(s.flagged), d: `${pct(s.flagged_right)} of them really were severe` },
      { k: "Severe fires caught", v: pct(s.severe_caught), d: "of all severe fires were flagged" },
    ]);
    const map = UI.getMap("fsev-map"), group = UI.layers["fsev-map"];
    group.clearLayers();
    for (const [lat, lon, p, frp, n] of s.points.slice().sort((a, b) => a[2] - b[2])) {
      L.circleMarker([lat, lon], { radius: 2.5 + 3 * p + Math.min(3, Math.sqrt(n)), stroke: false, fillColor: UI.sevColor(p), fillOpacity: 0.85 })
        .bindTooltip(`Model: ${Math.round(p * 100)}% chance severe · measured ${frp.toFixed(0)} MW`)
        .on("click", () => explainCell(lat, lon, p, frp, n)).addTo(group);
    }
    calibration(s);
    $("fsev-watch").innerHTML = s.watchlist.map((w, i) => `<div class="row" data-i="${i}"><span class="badge hot">${Math.round(w.p * 100)}%</span>
      <span class="what">${UI.esc(UI.place(w.country, w.lat, w.lon))}<small>measured ${w.frp.toFixed(0)} MW${w.frp >= 10 ? ": the model was right" : ": a false alarm"}</small></span></div>`).join("")
      || `<p class="empty">No fires to watch right now.</p>`;
    $("fsev-watch").querySelectorAll(".row").forEach((el) => el.addEventListener("click", () => {
      const w = s.watchlist[+el.dataset.i];
      map.flyTo([w.lat, w.lon], 7, { duration: UI.reduced() ? 0 : 1.2 });
      explainFire(UI.place(w.country, w.lat, w.lon), w.p, w.frp, 1);
    }));
  }
  function explainCell(lat, lon, p, frp, n) {
    explainFire(UI.place(null, lat, lon), p, frp, n);
  }
  function explainFire(where, p, frp, n) {
    const said = p >= 0.5, was = frp >= 10, chance = Math.round(p * 100);
    const what = n > 1 ? `${n} fires in this 25 km square near <strong>${UI.esc(where)}</strong>. The model gave them <strong>${chance}%</strong> on average, and the strongest measured <strong>${frp.toFixed(0)} MW</strong>.`
      : `This fire near <strong>${UI.esc(where)}</strong>: the model gave it <strong>${chance}%</strong>, and the satellite measured <strong>${frp.toFixed(0)} MW</strong>.`;
    if (said && was) say(`${what} That's severe, so the model got it right!`, "proud");
    else if (!said && !was) say(`${what} That's a mild fire, just as the model said.`, "happy");
    else if (said && !was) say(`${what} It turned out mild, so this one was a false alarm. Better safe than sorry.`, "think");
    else say(`${what} That's severe, and the model missed it. No model is perfect, which is why we show you how often it's wrong.`, "worried");
  }
  function calibration(s) {
    const el = $("fsev-calib"), rows = s.calibration.filter((r) => r.fires > 0);
    d3.select(el).selectAll("*").remove();
    if (!rows.length) return;
    const W = el.clientWidth || 480, H = 220, m = { t: 10, r: 8, b: 30, l: 40 };
    const x = d3.scaleBand().domain(rows.map((r) => r.range)).range([m.l, W - m.r]).padding(0.3);
    const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
    UI.axes(svg, x, y, W, H, m, { yfmt: d3.format(".0%") });
    svg.selectAll(".b").data(rows).join("rect").attr("x", (r) => x(r.range)).attr("width", x.bandwidth()).attr("rx", 4)
      .attr("y", (r) => y(r.actually_severe)).attr("height", (r) => y(0) - y(r.actually_severe)).attr("fill", (r, i) => UI.sevColor(i / Math.max(1, rows.length - 1) * 0.8 + 0.05))
      .on("mousemove", (e, r) => UI.showTip(`<div class="t-head">Model said ${r.range}</div><div class="t-val">${pct(r.actually_severe)}</div><div class="sub">really were severe (${fmt(r.fires)} fires)</div>`, e))
      .on("mouseleave", UI.hideTip);
    svg.append("text").attr("x", W / 2).attr("y", H - 2).attr("text-anchor", "middle").text("what the model said →");
    const lo = rows[0], hi = rows[rows.length - 1];
    $("fsev-calib-note").innerHTML = `When the model said <strong>${hi.range}</strong>, ${pct(hi.actually_severe)} really were severe. When it said <strong>${lo.range}</strong>, only ${pct(lo.actually_severe)} were.`;
  }

  /* ================================================================ outlook */
  async function loadOutlook() {
    $("fout-countries").innerHTML = `<p class="empty">Loading the outlook…</p>`;
    try { state.outlook = await UI.api("/api/outlook"); }
    catch (err) {
      $("fout-countries").innerHTML = `<p class="empty">The outlook needs the GeoData AI model. ${UI.esc(err.message)} Start it with start.cmd.</p>`;
      if (state.sub === "outlook") say("I need the GeoData AI model to look ahead. Start it with <strong>start.cmd</strong> and come back!", "worried");
      return;
    }
    renderOutlook();
    if (state.sub === "outlook") sayOutlook();
  }
  function sayOutlook() {
    const o = state.outlook;
    if (!o) return;
    const top = o.countries[0];
    say(`Big dots are places where lots of fires usually burn between <strong>${o.label}</strong>. Red ones are where many of them tend to be severe.
      ${top ? `<strong>${UI.esc(top.country)}</strong> tops the list: about ${fmt(top.severe)} severe fires in a normal year at this time.` : ""} It's a guide for planning, not a forecast.`, "worried");
  }
  function renderOutlook() {
    const o = state.outlook;
    if (!o) return;
    $("fout-lede").textContent = `${o.label}: where fires usually burn in these weeks, and how fierce they tend to be there.`;
    UI.getMap("fout-map");
    const group = UI.layers["fout-map"], maxU = d3.max(o.points, (p) => p[2]) || 1;
    group.clearLayers();
    for (const [lat, lon, usual, p] of o.points) {
      L.circleMarker([lat, lon], { radius: 1.5 + 6 * Math.sqrt(usual / maxU), stroke: false, fillColor: UI.sevColor(p), fillOpacity: 0.8 })
        .bindTooltip(`Usually ${fmt(usual)} fire hotspots these weeks · ${Math.round(p * 100)}% look severe`).addTo(group);
    }
    UI.bars("fout-countries", o.countries.map((c) => ({ name: UI.esc(c.country), value: c.severe, label: `~${fmt(c.severe)}` })));
  }

  /* ================================================================ explore: archive */
  const checkedSources = () => [...document.querySelectorAll('input[name="fx-source"]:checked')].map((i) => i.value);
  const colorMode = () => ($("fx-color").querySelector("button.on") || {}).dataset?.mode || "severity";
  const srcColor = (src) => ({ modis: UI.css("--fx-src-modis"), viirs_j1: UI.css("--fx-src-j1"), viirs_suomi: UI.css("--fx-src-snpp") }[src] || UI.css("--label-3"));
  function featureColor(p, mode) {
    if (mode === "probability") return d3.interpolateRgb(UI.css("--mild"), UI.css("--hot"))(Math.max(0, Math.min(1, p.high_frp_probability ?? 0)));
    if (mode === "frp") return UI.ramp()(Math.max(0.1, Math.min(1, Math.log10(1 + (p.frp || 0)) / 3)));
    if (mode === "source") return srcColor(p.satellite_source);
    return p.is_high_frp ? UI.css("--hot") : UI.css("--mild");
  }
  function legend(mode) {
    const el = $("fx-legend");
    if (mode === "probability") el.innerHTML = `Chance of a severe fire: <span class="fx-ramp" style="background:linear-gradient(90deg,${UI.css("--mild")},${UI.css("--hot")})"></span> 0% to 100%`;
    else if (mode === "frp") el.innerHTML = `Measured power: <span class="fx-ramp" style="background:linear-gradient(90deg,${UI.css("--cal-ramp")})"></span> 1 to 1,000+ MW`;
    else if (mode === "source") el.innerHTML = Object.entries(SOURCES).map(([k, v]) => `<span class="dot" style="background:${srcColor(k)}"></span>${v}`).join(" ");
    else el.innerHTML = `<span class="dot hot"></span>Model says severe <span class="dot mild"></span>Model says mild`;
  }

  async function loadExplore() {
    try {
      state.health = await UI.api("/geodata/health");
    } catch (err) {
      state.offline = true;
      $("fx-body").hidden = true;
      $("fx-offline").hidden = false;
      $("fx-offline").innerHTML = offlineCard(err.message);
      if (state.sub === "explore") say("The archive lives in the GeoData AI service, and it's switched off. Run <strong>start.cmd</strong> and I'll open it for you.", "worried");
      return;
    }
    state.offline = false;
    $("fx-body").hidden = false; $("fx-offline").hidden = true;
    const range = state.health.fire_date_range || {};
    if (range.end_date) {
      ["fx-start", "fx-end", "fs-date"].forEach((id) => { $(id).min = range.start_date; $(id).max = range.end_date; });
      $("fx-year").textContent = range.start_date.slice(0, 4) === range.end_date.slice(0, 4) ? range.end_date.slice(0, 4) : `${range.start_date.slice(0, 4)}–${range.end_date.slice(0, 4)}`;
    }
    resetFilters();
    const map = UI.getMap("fx-map", [[20, 15], 2]);
    if (!map.fxReady) {
      map.fxReady = true;
      map.on("click", (e) => { setPin(e.latlng.lat, e.latlng.lng); scoreNow(); });
    }
    if (!state.pin) setPin(27.18, 31.18);
    loadFires();
    loadModel();
    loadAsk();
  }
  function resetFilters() {
    const end = (state.health && state.health.fire_date_range.end_date) || new Date().toISOString().slice(0, 10);
    $("fx-end").value = end; $("fx-start").value = addDays(end, -6);
    if (!$("fs-date").value) $("fs-date").value = end;
    document.querySelectorAll('input[name="fx-source"]').forEach((i) => { i.checked = true; });
    $("fx-limit").value = "5000"; $("fx-viewport").checked = false;
  }
  function readFilters() {
    const f = { start_date: $("fx-start").value, end_date: $("fx-end").value, source: checkedSources() };
    if ($("fx-viewport").checked && UI.maps["fx-map"]) {
      const b = UI.maps["fx-map"].getBounds(), c = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      f.bbox = [c(b.getWest(), -180, 180), c(b.getSouth(), -90, 90), c(b.getEast(), -180, 180), c(b.getNorth(), -90, 90)].map((v) => v.toFixed(4)).join(",");
    }
    return f;
  }
  const qs = (f, extra = {}) => {
    const p = new URLSearchParams();
    Object.entries({ ...f, ...extra }).forEach(([k, v]) => {
      if (v == null || v === "") return;
      (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x));
    });
    return p.toString();
  };
  async function loadFires() {
    const f = readFilters();
    if (!f.start_date || !f.end_date) return UI.toast("Pick a start and an end date first.");
    if (f.start_date > f.end_date) return UI.toast("The start date is after the end date.");
    if (!f.source.length) return UI.toast("Pick at least one satellite.");
    $("fx-apply").disabled = true; $("fx-apply").textContent = "Loading…";
    UI.loadingFacts("fx-glance", ["Fires found", "Measured severe", "Model expects severe", "Busiest day"]);
    try {
      const [geo, stats] = await Promise.all([
        UI.api(`/geodata/api/v1/fires/geojson?${qs(f, { limit: $("fx-limit").value, predict: true })}`),
        UI.api(`/geodata/api/v1/fires/stats?${qs(f)}`),
      ]);
      state.filters = f; state.features = geo.features; state.stats = stats; state.meta = geo.metadata;
      drawFeatures(true);
      renderStats();
      const layer = state.fxLayer;
      if (geo.features.length && !f.bbox && layer) UI.maps["fx-map"].flyToBounds(layer.getBounds().pad(0.08), { maxZoom: 7, duration: UI.reduced() ? 0 : 0.9 });
      if (state.sub === "explore") sayExplore();
    } catch (err) {
      if (isOffline(err)) { state.loaded.explore = false; return loadExplore(); }
      UI.toast(`The fires could not be loaded. ${err.message}`);
    } finally { $("fx-apply").disabled = false; $("fx-apply").textContent = "Show fires"; }
  }
  function sayExplore() {
    const s = state.stats, m = state.meta, f = state.filters;
    if (!s) return;
    if (!s.total) return say("No fires match these filters. Try more days or switch a satellite back on.", "think");
    const predicted = m && m.count ? m.predicted_high_frp / m.count : null;
    say(`Between ${dateLabel(f.start_date)} and ${dateLabel(f.end_date)}, satellites saw <strong>${fmt(s.total)}</strong> fires. <strong>${pct(s.high_frp_share)}</strong> of them measured 10 MW or more.
      ${predicted != null ? `The model expected ${pct(predicted)} of the dots on the map to be severe.` : ""} Tap anywhere on the map and I'll score a fire there.`, "wow");
  }
  function drawFeatures(reveal) {
    const map = UI.maps["fx-map"];
    if (!map) return;
    const group = UI.layers["fx-map"], mode = colorMode(), feats = state.features;
    group.clearLayers();
    const radius = feats.length > 20000 ? 2.5 : feats.length > 5000 ? 3.2 : 4.2;
    state.fxLayer = L.geoJSON({ type: "FeatureCollection", features: feats }, {
      pointToLayer: (feat, latlng) => L.circleMarker(latlng, { radius, color: UI.dark() ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.7)", weight: 0.6, fillColor: featureColor(feat.properties, mode), fillOpacity: 0.85 }),
      onEachFeature: (feat, layer) => {
        layer.bindPopup(() => popup(feat), { maxWidth: 290 });
        layer.on("click", (e) => L.DomEvent.stopPropagation(e));
      },
    }).addTo(group);
    legend(mode);
    if (reveal && !UI.reduced() && window.anime) anime({ targets: map.getPane("overlayPane"), opacity: [0, 1], duration: 420, easing: "easeOutQuad" });
  }
  function popup(feat) {
    const p = feat.properties, [lon, lat] = feat.geometry.coordinates, i = state.features.indexOf(feat);
    const time = p.acq_time != null ? `${String(p.acq_time).padStart(4, "0").replace(/(\d\d)(\d\d)/, "$1:$2")} UTC` : "";
    const rows = [
      ["Measured power", p.frp != null ? `${p.frp} MW${p.frp >= 10 ? " (severe)" : ""}` : "Not recorded"],
      ["Fire Risk Score", p.risk_score != null ? `${Math.round(p.risk_score)} of 100 · ${p.risk_level}` : p.high_frp_probability != null ? `${(p.high_frp_probability * 100).toFixed(0)}% chance severe` : "Not scored"],
      ["Brightness", p.brightness != null ? `${p.brightness} K` : "Not recorded"],
      ["Satellite", `${SOURCES[p.satellite_source] || p.satellite_source || "Unknown"}, ${p.daynight === "N" ? "night" : "day"} pass`],
      ["Weather", p.weather_matched ? "Matched to a nearby station" : "No station nearby"],
    ];
    return `<p class="fx-pop-title">${p.acq_date ? dateLabel(p.acq_date) : "Fire"} ${time}</p><p class="fx-pop-sub">${lat.toFixed(3)}, ${lon.toFixed(3)}</p>
      <span class="fx-tag ${p.is_high_frp ? "hot" : ""}">${p.is_high_frp ? "Model says severe" : "Model says mild"}</span>
      <table class="fx-pop">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
      <button type="button" class="pill strong fx-pop-btn" data-score="${i}">Score it with its own numbers</button>`;
  }
  function renderStats() {
    const s = state.stats, m = state.meta;
    if (!s) return;
    const days = s.by_date || [], busiest = days.slice().sort((a, b) => b.count - a.count)[0];
    UI.facts("fx-glance", [
      { k: "Fires found", v: fmt(s.total), accent: true, d: m && m.truncated ? `the ${fmt(m.count)} most recent are on the map` : "all of them are on the map" },
      { k: "Measured severe", v: pct(s.high_frp_share), d: `gave off ${s.high_frp_threshold_mw} MW or more` },
      { k: "Model expects severe", v: m && m.count ? pct(m.predicted_high_frp / m.count) : "—", d: "of the fires on the map" },
      { k: "Busiest day", v: busiest ? dateLabel(busiest.date) : "—", d: busiest ? `${fmt(busiest.count)} fires, ${fmt(busiest.high_frp_count)} severe` : "" },
    ]);
    $("fx-map-sub").textContent = m && m.truncated ? `Showing the ${fmt(m.count)} most recent fires. Narrow the dates or raise the dot limit to see more.` : "Tap a dot for its details. Tap anywhere else to score a fire there.";
    dayChart(days);
    UI.bars("fx-sources", (s.by_source || []).map((r) => ({ name: SOURCES[r.source] || r.source, value: r.count })));
  }
  function dayChart(days) {
    const el = $("fx-days");
    d3.select(el).selectAll("*").remove();
    if (!days.length) { el.innerHTML = `<p class="empty">Nothing to chart yet.</p>`; return; }
    const W = el.clientWidth || 420, H = 200, m = { t: 8, r: 6, b: 26, l: 40 };
    const x = d3.scaleBand().domain(days.map((d) => d.date)).range([m.l, W - m.r]).padding(days.length > 60 ? 0.05 : 0.2);
    const y = d3.scaleLinear().domain([0, d3.max(days, (d) => d.count) || 1]).nice().range([H - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
    const every = Math.max(1, Math.ceil(days.length / 6));
    UI.axes(svg, x, y, W, H, m, { xticks: days.map((d) => d.date).filter((_, i) => i % every === 0), xfmt: dateLabel });
    const g = svg.selectAll(".d").data(days).join("g");
    g.append("rect").attr("x", (d) => x(d.date)).attr("width", x.bandwidth()).attr("rx", 2).attr("y", (d) => y(d.count)).attr("height", (d) => y(0) - y(d.count)).attr("fill", UI.css("--surface-2")).attr("stroke", UI.css("--line"));
    g.append("rect").attr("x", (d) => x(d.date)).attr("width", x.bandwidth()).attr("rx", 2).attr("y", (d) => y(d.high_frp_count)).attr("height", (d) => y(0) - y(d.high_frp_count)).attr("fill", UI.css("--hot"));
    g.append("rect").attr("x", (d) => x(d.date)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", "transparent")
      .on("mousemove", (e, d) => UI.showTip(`<div class="t-head">${dateLabel(d.date)}</div><div class="t-val">${fmt(d.count)} fires</div><div class="sub">${fmt(d.high_frp_count)} severe (${pct(d.count ? d.high_frp_count / d.count : 0)})</div>`, e))
      .on("mouseleave", UI.hideTip);
  }

  /* ---------------------------------------------------------------- score a fire */
  function setPin(lat, lon) {
    $("fs-lat").value = lat.toFixed(4); $("fs-lon").value = lon.toFixed(4);
    const map = UI.maps["fx-map"];
    if (!map) return;
    if (!state.pin) {
      const icon = L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="fx-pin"><span></span><span></span><b></b></div>' });
      state.pin = L.marker([lat, lon], { icon, draggable: true, title: "Your fire. Drag to move it.", zIndexOffset: 1000 }).addTo(map);
      state.pin.on("dragend", () => { const p = state.pin.getLatLng(); setPin(p.lat, p.lng); scoreNow(); });
    } else state.pin.setLatLng([lat, lon]);
  }
  const num = (id) => ($(id).value === "" ? null : Number($(id).value));
  function setSensor(sensor) {
    $("fs-sensor").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.sensor === sensor));
    const px = PIXELS[sensor];
    $("fs-scan").value = px ? px.scan : ""; $("fs-track").value = px ? px.track : "";
  }
  function fillFrom(feat) {
    const p = feat.properties, [lon, lat] = feat.geometry.coordinates;
    setPin(lat, lon);
    if (p.acq_date) $("fs-date").value = p.acq_date;
    $("fs-time").value = p.acq_time ?? "";
    $("fs-brightness").value = p.brightness ?? ""; $("fs-confidence").value = p.confidence ?? "";
    setSensor(p.satellite_source === "modis" ? "modis" : "viirs");
    $("fs-scan").value = p.scan ?? ""; $("fs-track").value = p.track ?? "";
    $("fs-type").value = String(p.type ?? 0);
  }
  function scoreNow() { $("fx-score").requestSubmit(); }
  async function score(e, measured) {
    if (e) e.preventDefault();
    const body = {
      latitude: num("fs-lat"), longitude: num("fs-lon"), acq_date: $("fs-date").value, acq_time: num("fs-time"),
      brightness: num("fs-brightness"), confidence: num("fs-confidence"), scan: num("fs-scan"), track: num("fs-track"), type: Number($("fs-type").value),
    };
    if (body.latitude == null || body.longitude == null || !body.acq_date) return UI.toast("Place the fire on the map and pick a date first.");
    $("fs-go").disabled = true;
    try {
      const r = await UI.post("/geodata/api/v1/predict", body);
      const box = $("fx-result"), first = box.hidden, risk = r.risk_score != null;
      const cut = risk && state.model && state.model.risk_levels ? state.model.risk_levels.cutoffs.High / 100 : r.decision_threshold;
      const p = risk ? r.risk_score / 100 : r.high_frp_probability;
      box.hidden = false; box.classList.toggle("hot", r.is_high_frp);
      $("fr-label").textContent = risk ? `${r.risk_level} risk` : (r.is_high_frp ? "Likely a severe fire" : "Likely a mild fire");
      $("fr-sub").textContent = risk
        ? `Fire Risk Score ${Math.round(r.risk_score)} of 100: about ${Math.round(r.risk_score)}% of fires like this turn severe (${r.high_frp_threshold_mw} MW or more).`
        : `Severe means ${r.high_frp_threshold_mw} MW or more. The model says "severe" above ${Math.round(r.decision_threshold * 100)}%.`;
      $("fr-cut").style.left = `${cut * 100}%`;
      const blanks = ["brightness", "confidence", "scan", "track"].filter((k) => body[k] == null);
      const caution = [];
      if (r.in_training_extent === false) caution.push("This place or date is outside what the model learned from, so treat the score as a rough guess.");
      if (blanks.length === 4) caution.push("You only gave the place and date, so this is the typical risk for a fire there, not this fire's own.");
      $("fr-caution").hidden = !caution.length; $("fr-caution").textContent = caution.join(" ");
      const w = r.weather || {};
      const kv = [["Weather", w.matched ? `Station ${Math.round(w.distance_km)} km away, same day` : "No weather station close enough that day"]];
      if (w.matched) kv.push(["Humidity", w.rh2m != null ? `${w.rh2m}%` : "—"], ["Rain", w.prectotcorr != null ? `${w.prectotcorr} mm` : "—"], ["Soil wetness", w.gwettop != null ? `${Math.round(w.gwettop * 100)}%` : "—"]);
      if (blanks.length) kv.push(["Left empty", blanks.map((k) => FEATURES[k].toLowerCase()).join(", ")]);
      $("fr-kv").innerHTML = kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
      if (first && !UI.reduced() && window.anime) anime({ targets: box, opacity: [0, 1], translateY: [8, 0], duration: 360, easing: "easeOutQuad" });
      const counter = { v: state.lastProb * 100 };
      if (window.anime && !UI.reduced()) {
        anime({ targets: counter, v: p * 100, duration: 700, easing: "easeOutExpo", update: () => { $("fr-prob").textContent = counter.v.toFixed(0); } });
        anime({ targets: $("fr-meter"), scaleX: [state.lastProb, p], duration: 700, easing: "easeOutExpo" });
      } else { $("fr-prob").textContent = (p * 100).toFixed(0); $("fr-meter").style.transform = `scaleX(${p})`; }
      state.lastProb = p;
      const chance = risk ? `Fire Risk Score <strong>${Math.round(r.risk_score)}</strong>, <strong>${r.risk_level.toLowerCase()}</strong> risk` : `<strong>${Math.round(p * 100)}%</strong> chance this is a severe fire`;
      if (measured != null) {
        const right = (p >= r.decision_threshold) === (measured >= 10);
        say(`${chance}. The satellite measured <strong>${measured} MW</strong>, so the model was ${right ? "right" : "wrong"} on this one.`, right ? "proud" : "worried");
      } else if (blanks.length === 4) say(`${chance}. I only know the place and the date, so it's a rough guess. Add the fire's brightness for a sharper answer.`, "think");
      else say(`${chance}. ${r.is_high_frp ? "If you saw this fire, keep your distance and report it." : "Probably a small burn, but fires can grow fast."}`, r.is_high_frp ? "worried" : "happy");
    } catch (err) {
      UI.toast(`The fire could not be scored. ${err.message}`);
    } finally { $("fs-go").disabled = false; }
  }

  async function loadModel() {
    try { state.model = await UI.api("/geodata/api/v1/model"); } catch (_) { return; }
    const info = state.model;
    if (!info.loaded) { $("fx-importance").innerHTML = `<p class="empty">The model isn't loaded.</p>`; return; }
    const imp = Object.entries(info.feature_importances || {}).sort((a, b) => b[1] - a[1]).slice(0, 7);
    UI.bars("fx-importance", imp.map(([k, v]) => ({ name: FEATURES[k] || k, value: v, label: `${Math.round(v * 100)}%` })));
    const ext = info.training_extent;
    $("fx-extent").textContent = ext
      ? `Trained on ${fmt(ext.rows)} fires from ${dateLabel(ext.start_date)} to ${dateLabel(ext.end_date)} ${ext.end_date.slice(0, 4)}${info.metrics && info.metrics.roc_auc ? `. On later fires it held back for testing, it ranked a severe fire above a mild one ${pct(info.metrics.roc_auc)} of the time` : ""}.`
      : "";
  }

  /* ---------------------------------------------------------------- ask */
  function markdown(text) {
    const inline = (l) => UI.esc(l).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
    const out = []; let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of text.split(/\n/)) {
      const line = raw.trimEnd(), b = line.match(/^\s*[-*•]\s+(.*)$/), n = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (b || n) { const kind = b ? "ul" : "ol"; if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline((b || n)[1])}</li>`); }
      else if (!line.trim()) close();
      else { close(); const h = line.match(/^#{1,6}\s+(.*)$/); out.push(h ? `<p><strong>${inline(h[1])}</strong></p>` : `<p>${inline(line)}</p>`); }
    }
    close();
    return out.join("");
  }
  async function loadAsk() {
    try { const s = await UI.api("/geodata/api/v1/ask/status"); state.ask.enabled = !!s.enabled; } catch (_) { state.ask.enabled = false; }
    $("fx-ask-card").hidden = !state.ask.enabled;
  }
  async function ask(question) {
    question = question.trim();
    if (question.length < 2 || state.ask.busy || !state.ask.enabled) return;
    state.ask.busy = true; $("fx-ask-go").disabled = true; $("fx-q").value = ""; $("fx-suggest").hidden = true;
    const turn = document.createElement("div");
    turn.className = "fx-turn";
    turn.innerHTML = `<p class="fx-q"></p><div class="fx-a pending">Looking it up…</div>`;
    turn.querySelector(".fx-q").textContent = question;
    $("fx-thread").appendChild(turn);
    const a = turn.querySelector(".fx-a");
    try {
      const r = await UI.post("/geodata/api/v1/ask", { question, history: state.ask.history.slice(-10) });
      a.classList.remove("pending"); a.innerHTML = markdown(r.answer || "No answer came back.");
      state.ask.history.push({ role: "user", content: question }, { role: "assistant", content: r.answer || "" });
      $("fx-ask-reset").hidden = false;
    } catch (err) { a.classList.remove("pending"); a.classList.add("failed"); a.textContent = `No answer. ${err.message}`; }
    finally { state.ask.busy = false; $("fx-ask-go").disabled = false; }
  }

  /* ================================================================ wiring */
  function wire() {
    $("fires-sub").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => switchSub(b.dataset.sub)));
    $("classic-map").href = `${location.protocol}//${location.hostname}:8000/`;   // the original GeoData map, same tab
    $("fx-form").addEventListener("submit", (e) => { e.preventDefault(); loadFires(); });
    $("fx-reset").addEventListener("click", () => { resetFilters(); loadFires(); });
    $("fx-color").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      $("fx-color").querySelectorAll("button").forEach((o) => o.classList.toggle("on", o === b));
      drawFeatures(false);
    }));
    $("fs-sensor").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setSensor(b.dataset.sensor)));
    $("fx-score").addEventListener("submit", (e) => score(e));
    $("fx-ask").addEventListener("submit", (e) => { e.preventDefault(); ask($("fx-q").value); });
    $("fx-q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask($("fx-q").value); } });
    $("fx-suggest").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));
    $("fx-ask-reset").addEventListener("click", () => { state.ask.history = []; $("fx-thread").innerHTML = ""; $("fx-ask-reset").hidden = true; $("fx-suggest").hidden = false; });
    UI.getMap("fx-map", [[20, 15], 2]).on("popupopen", (e) => {
      const btn = e.popup.getElement() && e.popup.getElement().querySelector("[data-score]");
      if (!btn) return;
      btn.addEventListener("click", () => {
        const feat = state.features[+btn.dataset.score];
        if (!feat) return;
        UI.maps["fx-map"].closePopup();
        fillFrom(feat);
        score(null, feat.properties.frp);
      });
    });
    UI.onTheme(() => {
      if (!mounted) return;
      renderToday(); renderOutlook();
      if (state.features.length) drawFeatures(false);
      if (state.stats) renderStats();
    });
    let t;
    addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (!mounted || $("fires-view").hidden) return; if (state.sev) calibration(state.sev); if (state.stats) dayChart(state.stats.by_date || []); }, 200); });
  }

  function mount() {
    const root = $("fires-view");
    root.innerHTML = TEMPLATE;
    mounted = true;
    wire();
  }

  function switchSub(name, { replace = true } = {}) {
    if (!SUBS.includes(name)) name = "today";
    state.sub = name;
    const root = $("fires-view");
    $("fires-sub").querySelectorAll("button").forEach((b) => { const on = b.dataset.sub === name; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    root.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.sub !== name; });
    root.dataset.sub = name;
    if (replace) history.replaceState(null, "", `#${name}`);
    // One Flick per pane, created on first view so its portrait is sized while visible.
    const host = root.querySelector(`.pane[data-sub="${name}"] [data-flick]`);
    if (!host.dlg) host.dlg = UI.flickCard(host, { size: 64 });
    flick = host.dlg;
    if (!UI.reduced() && window.anime) anime({ targets: root.querySelectorAll(`.pane[data-sub="${name}"] > *`), opacity: [0, 1], translateY: [10, 0], delay: anime.stagger(40), duration: 380, easing: "easeOutQuad" });
    UI.refreshMaps();
    if (!state.loaded[name]) {
      state.loaded[name] = true;
      if (name === "today") { UI.getMap("fsev-map"); say("Give me a second, I'm scoring the fires burning right now…", "think"); loadToday(); }
      if (name === "outlook") { UI.getMap("fout-map"); say("Looking four weeks ahead…", "think"); loadOutlook(); }
      if (name === "explore") { say("Opening the archive…", "think"); loadExplore(); }
    } else if (name === "today") sayToday();
    else if (name === "outlook") sayOutlook();
    else if (name === "explore" && !state.offline) sayExplore();
  }

  function show(sub) {
    if (!mounted) mount();
    switchSub(sub || state.sub, { replace: false });
  }

  const tour = [
    { at: "#fsev-map-card", mood: "think", say: "Every dot is a fire burning now, coloured by how likely our model thinks it's severe. Tap one and I'll tell you if the model got it right." },
    { at: "#fsev-trust-card", mood: "wink", say: "This is the honesty check. When the model said 80 to 100%, how many fires really were severe? Taller bars on the right mean it's doing its job." },
    { at: "#fsev-watch-card", mood: "worried", say: "The watch list: the fires the model worries about most right now. Tap one and the map flies there." },
  ];

  return { show, tour };
})();
window.Fires = Fires;
