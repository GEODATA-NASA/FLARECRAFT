/* The GeoFlare story, told by Flick, with the viewer as a character in it.
   Plot: fires are burning right now -> where do YOU live? -> a year of fire -> a mystery (fires "jump" in 2012; you guess)
   -> the clue (a sharper satellite) -> our fix -> today's fires -> a game (beat our AI at spotting the most dangerous fire)
   -> a twist (some dots never move: gas flares and factories) -> back to YOU (your air today, and what to do) -> the apps.
   Flick is the only narrator. The screen shows a short headline, a few big numbers and the picture he talks about; he points
   at things on the globe and the charts. Next steps through his lines like a game; Back goes to the previous line. */
const Story = (() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("globe"), ctx = canvas.getContext("2d"), svg = d3.select("#story-figure");
  const copy = $("story-copy"), ticker = $("story-ticker");
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.4);
  const path = d3.geoPath(projection, ctx);
  const graticule = d3.geoGraticule10();
  const fmt = d3.format(",.0f");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BAND = 196;                                   // the dialogue band; nothing else lives below this line
  const HOME = { lon: 31.19, lat: 27.18, name: "Assiut" };
  const PLACES = [
    { name: "Assiut", lat: 27.18, lon: 31.18 }, { name: "Basra", lat: 30.51, lon: 47.81 }, { name: "Houston", lat: 29.76, lon: -95.37 },
    { name: "Delhi", lat: 28.61, lon: 77.21 }, { name: "Port Harcourt", lat: 4.82, lon: 7.03 },
  ];

  let W = 0, H = 0, R = 0, land = null, data = null, live = null, severity = null, outlook = null, pixels = { modis: 2, viirs: 10 };
  let scene = -1, line = 0, onDone = null, running = false, raf = null, weekTimer = null, dialogue = null, refreshTimer = null;
  const view = { rot: [-20, -12], spin: 0.06, globe: 1, cx: 0.66, week: 0, cumulative: 0,
                 archive: 0, live: 0, severity: 0, outlook: 0, flares: 0, pin: 0, mark: 0 };
  let marks = [], pin = { ...HOME };            // what Flick is pointing at on the globe
  let me = null, meAir = null, game = null, guess = null;   // the viewer's place, its air, and the game

  /* ------------------------------------------------------------------ globe */
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = Math.min(W * 0.31, (H - BAND) * 0.46);
  }
  function dot(x, y, r, core, halo) {
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, r * 1.9, 0, 6.283); ctx.fill();
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, 6.283); ctx.fill();
  }
  const sevColor = (p, a) => (p >= 0.6 ? `rgba(255,59,48,${a})` : p >= 0.3 ? `rgba(255,149,0,${a})` : `rgba(255,214,10,${a})`);
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function draw() {
    const r = R * view.globe, cx = W * view.cx, cy = (H - BAND) / 2 + 8;
    projection.scale(r).translate([cx, cy]).rotate(view.rot);
    ctx.clearRect(0, 0, W, H);
    const halo = ctx.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.22);
    halo.addColorStop(0, "rgba(255,140,60,0.10)"); halo.addColorStop(1, "rgba(255,140,60,0)");
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, r * 1.22, 0, 6.283); ctx.fill();
    ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = "#0e1217"; ctx.fill();
    ctx.beginPath(); path(graticule); ctx.strokeStyle = "rgba(245,239,230,0.05)"; ctx.lineWidth = 0.6; ctx.stroke();
    if (land) { ctx.beginPath(); path(land); ctx.fillStyle = "#171d24"; ctx.fill(); ctx.strokeStyle = "rgba(245,239,230,0.16)"; ctx.lineWidth = 0.5; ctx.stroke(); }
    ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = "rgba(245,239,230,0.14)"; ctx.lineWidth = 1; ctx.stroke();

    const centre = [-view.rot[0], -view.rot[1]], k = r / 420;
    const visible = (lon, lat) => d3.geoDistance([lon, lat], centre) < 1.5;
    ctx.globalCompositeOperation = "lighter";
    if (view.archive > 0.01 && data && data.frames.length) {
      for (const [lat, lon, v] of data.frames[view.week % data.frames.length] || []) {
        if (!visible(lon, lat)) continue;
        const [x, y] = projection([lon, lat]);
        dot(x, y, Math.min(7, 0.7 + Math.sqrt(v) * 0.16) * k, `rgba(255,236,190,${0.75 * view.archive})`, `rgba(255,${Math.min(200, 90 + v * 0.6) | 0},40,${0.5 * view.archive})`);
      }
    }
    if (view.live > 0.01 && live) {
      for (const [lat, lon, n, ind] of live.globe) {
        if (ind || !visible(lon, lat)) continue;
        const [x, y] = projection([lon, lat]);
        dot(x, y, Math.min(7, 0.8 + Math.sqrt(n) * 0.35) * k, `rgba(255,240,200,${0.8 * view.live})`, `rgba(255,120,40,${0.5 * view.live})`);
      }
    }
    if (view.severity > 0.01 && severity) {
      for (const [lat, lon, p] of severity.points) {
        if (!visible(lon, lat)) continue;
        const [x, y] = projection([lon, lat]);
        dot(x, y, (1.4 + p * 3.2) * k, sevColor(p, 0.95 * view.severity), sevColor(p, 0.35 * view.severity));
      }
    }
    if (view.outlook > 0.01 && outlook) {
      for (const [lat, lon, usual, p] of outlook.points) {
        if (!visible(lon, lat)) continue;
        const [x, y] = projection([lon, lat]);
        dot(x, y, Math.min(6, 0.8 + Math.sqrt(usual) * 0.22) * k, sevColor(p, 0.9 * view.outlook), sevColor(p, 0.3 * view.outlook));
      }
    }
    if (view.flares > 0.01 && data) {
      const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 380);
      for (const [lat, lon, n] of data.industrial) {
        if (!visible(lon, lat)) continue;
        const [x, y] = projection([lon, lat]);
        dot(x, y, Math.min(5, 0.6 + Math.sqrt(n) * 0.045) * k * pulse, `rgba(220,245,255,${0.9 * view.flares})`, `rgba(90,200,250,${0.3 * view.flares})`);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    if (view.pin > 0.01 && visible(pin.lon, pin.lat)) {
      const [x, y] = projection([pin.lon, pin.lat]), t = (performance.now() % 1800) / 1800;
      ctx.strokeStyle = `rgba(255,248,239,${(1 - t) * view.pin})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6 + t * 22, 0, 6.283); ctx.stroke();
      ctx.fillStyle = `rgba(255,248,239,${view.pin})`; ctx.beginPath(); ctx.arc(x, y, 5, 0, 6.283); ctx.fill();
      ctx.font = "700 15px Manrope, sans-serif";
      const pw = ctx.measureText(pin.name).width;
      ctx.fillStyle = `rgba(14,10,6,${0.8 * view.pin})`; roundRect(x + 10, y - 13, pw + 16, 26, 13); ctx.fill();
      ctx.fillStyle = `rgba(255,248,239,${view.pin})`; ctx.fillText(pin.name, x + 18, y + 5);
    }
    // Flick's pointers: dashed rings, with a label or a letter, so you know exactly where to look.
    if (view.mark > 0.01) {
      for (const m of marks) {
        if (!visible(m.lon, m.lat)) continue;
        const [x, y] = projection([m.lon, m.lat]), rr = (m.r || 60) * k * (1 + 0.04 * Math.sin(performance.now() / 300));
        ctx.save(); ctx.setLineDash([6, 7]); ctx.lineDashOffset = -performance.now() / 40;
        ctx.strokeStyle = `rgba(255,210,122,${0.95 * view.mark})`; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, 6.283); ctx.stroke(); ctx.restore();
        ctx.font = "800 15px Manrope, sans-serif";
        const tw = ctx.measureText(m.label).width, lx = Math.min(W - tw - 30, x + rr * 0.72 + 8), ly = y - rr * 0.72 - 8;
        ctx.fillStyle = `rgba(20,14,8,${0.85 * view.mark})`; roundRect(lx - 10, ly - 20, tw + 20, 30, 15); ctx.fill();
        ctx.fillStyle = `rgba(255,226,168,${view.mark})`; ctx.fillText(m.label, lx, ly);
      }
    }
  }

  function loop() {
    if (!running) return;
    if (!reduced) view.rot[0] += view.spin;
    draw();
    raf = requestAnimationFrame(loop);
  }
  function tweenView(props, ms = 1000) {
    return anime({ targets: view, ...props, duration: reduced ? 0 : ms, easing: "easeInOutQuad" }).finished;
  }
  function rotateTo(lon, lat, ms = 1800) {
    const i = d3.interpolate(view.rot.slice(), [-lon, -lat]), clock = { t: 0 };
    view.spin = 0;
    return anime({ targets: clock, t: 1, duration: reduced ? 0 : ms, easing: "easeInOutCubic", update: () => { view.rot = i(clock.t); } }).finished;
  }
  function fadeGlobe(opacity) { anime({ targets: canvas, opacity, duration: reduced ? 0 : 700, easing: "easeInOutQuad" }); }
  const layers = (on) => tweenView({ archive: 0, live: 0, severity: 0, outlook: 0, flares: 0, pin: 0, mark: 0, ...on }, 900);
  function point(lon, lat, label, r = 60) { marks = [{ lon, lat, label, r }]; tweenView({ mark: 1 }, 500); }
  function pointMany(list) { marks = list; tweenView({ mark: 1 }, 500); }
  const unpoint = () => tweenView({ mark: 0 }, 300);

  function playWeeks() {
    stopWeeks();
    if (!data || !data.frames.length) return;
    view.week = 0; view.cumulative = 0;
    weekTimer = setInterval(() => {
      const frame = data.frames[view.week % data.frames.length];
      view.cumulative += frame.reduce((s, p) => s + p[2], 0);
      const start = new Date(Date.UTC(data.year, 0, 1 + view.week * 7));
      ticker.innerHTML = `week of ${start.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}
        <strong>${fmt(view.cumulative)}</strong>fire hotspots so far`;
      view.week = (view.week + 1) % data.frames.length;
      if (view.week === 0) view.cumulative = 0;
    }, reduced ? 600 : 170);
  }
  function stopWeeks() { clearInterval(weekTimer); weekTimer = null; ticker.innerHTML = ""; }

  /* ------------------------------------------------------------------ figures */
  const box = () => ({ x0: W * 0.47, x1: W * 0.95, y0: H * 0.13, y1: H - BAND - 54, get w() { return this.x1 - this.x0; }, get h() { return this.y1 - this.y0; } });
  const clearFigure = () => svg.selectAll("*").remove();
  function ring(x, y, r, label, dx = 1) {
    const g = svg.append("g").attr("class", "fig-ring");
    g.append("circle").attr("cx", x).attr("cy", y).attr("r", r);
    g.append("text").attr("x", x + dx * (r + 10)).attr("y", y - r - 6).attr("text-anchor", dx > 0 ? "start" : "end").text(label);
    anime({ targets: g.node(), opacity: [0, 1], duration: reduced ? 0 : 400, easing: "easeOutQuad" });
  }

  function pixelFigure() {
    clearFigure();
    const b = box(), gap = 40, side = Math.min((b.w - gap) / 2, b.h * 0.78);
    const SMALL = [[0.42, 2.55], [2.62, 0.48], [2.35, 2.62], [0.6, 0.55]];
    const front = (x, y) => ((x - 1.55) / 0.62) ** 2 + ((y - 1.45) / 0.42) ** 2 < 1 || ((x - 1.05) / 0.25) ** 2 + ((y - 1.0) / 0.18) ** 2 < 1;
    const burning = (x, y) => front(x, y) || SMALL.some(([a, c]) => (x - a) ** 2 + (y - c) ** 2 < 0.07 ** 2);
    const panels = [
      { key: "modis", name: "The old eye · MODIS", res: "sees 1 km squares", n: 3, threshold: 0.05, small: false, x: b.x0 },
      { key: "viirs", name: "The new eye · VIIRS", res: "sees 375 m squares", n: 8, threshold: 0.6, small: true, x: b.x0 + side + gap },
    ];
    const y = b.y0 + (b.h - side) / 2;
    panels.forEach((p, i) => {
      const g = svg.append("g").attr("transform", `translate(${p.x},${y})`), cell = side / p.n, km = 3 / p.n;
      g.append("text").attr("class", "fig-title").attr("y", -32).text(p.name);
      g.append("text").attr("class", "fig-label").attr("y", -13).text(p.res);
      const res = 60, ground = [];
      for (let a = 0; a < res; a++) for (let c = 0; c < res; c++) if (burning((a + 0.5) * 3 / res, (c + 0.5) * 3 / res)) ground.push([a, c]);
      g.selectAll(".ground").data(ground).join("rect").attr("x", (d) => d[0] * side / res).attr("y", (d) => d[1] * side / res)
        .attr("width", side / res + 0.3).attr("height", side / res + 0.3).attr("fill", "#5a2412");
      let lit = 0;
      const cells = [];
      for (let a = 0; a < p.n; a++) for (let c = 0; c < p.n; c++) {
        let hits = 0;
        for (let s = 0; s < 12; s++) for (let t = 0; t < 12; t++) if (front((a + (s + 0.5) / 12) * km, (c + (t + 0.5) / 12) * km)) hits++;
        const hasSmall = SMALL.some(([x, yy]) => x >= a * km && x < (a + 1) * km && yy >= c * km && yy < (c + 1) * km);
        const on = hits / 144 > p.threshold || (p.small && hasSmall);
        if (on) lit++;
        cells.push({ a, c, on });
      }
      pixels[p.key] = lit;
      g.selectAll(".px").data(cells).join("rect").attr("class", "px").attr("x", (d) => d.a * cell + 1).attr("y", (d) => d.c * cell + 1)
        .attr("width", cell - 2).attr("height", cell - 2).attr("rx", 2).attr("fill", (d) => (d.on ? (i ? "#ff6a2b" : "#ffb347") : "transparent"))
        .attr("fill-opacity", 0).attr("stroke", "rgba(245,239,230,0.22)");
      g.append("text").attr("class", "fig-title big").attr("y", side + 38).text(`${lit} hotspot${lit === 1 ? "" : "s"}`);
      anime({ targets: g.selectAll(".px").filter((d) => d.on).nodes(), fillOpacity: [0, 0.85], delay: anime.stagger(reduced ? 0 : 70, { start: 400 + i * 500 }), duration: 500, easing: "easeOutQuad" });
    });
  }

  let record = null;
  function recordFigure(withFix) {
    clearFigure(); record = null;
    if (!data || !data.annual || data.annual.years.length < 3) return;
    const a = data.annual, b = box(), years = a.years;
    const x = d3.scaleBand().domain(years).range([b.x0 + 44, b.x1]).padding(0.18);
    const y = d3.scaleLinear().domain([0, d3.max([...a.naive, ...a.hi]) * 1.08]).range([b.y1, b.y0]).nice();
    record = { x, y, a, b };
    svg.append("g").attr("class", "fig-axis").attr("transform", `translate(${b.x0 + 44},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".2s")).tickSize(-(b.w - 44))).call((g) => g.select(".domain").remove());
    svg.append("g").attr("class", "fig-axis").attr("transform", `translate(0,${b.y1})`)
      .call(d3.axisBottom(x).tickValues(years.filter((d) => d % 4 === 3 || d === data.viirs_start)).tickSize(0)).call((g) => g.select(".domain").remove()).selectAll("text").attr("dy", "1.2em");
    svg.append("text").attr("class", "fig-label").attr("x", b.x0 + 44).attr("y", b.y0 - 22).text("Fire hotspots counted per year, whole planet");
    const bars = svg.selectAll(".bar").data(years.map((yr, i) => ({ yr, v: a.naive[i] }))).join("rect")
      .attr("x", (d) => x(d.yr)).attr("width", x.bandwidth()).attr("rx", 2).attr("y", b.y1).attr("height", 0)
      .attr("fill", (d) => (d.yr >= data.viirs_start ? "#ff6a2b" : "#8a8f98"));
    if (!withFix) {
      anime({ targets: bars.nodes(), y: (el) => y(d3.select(el).datum().v), height: (el) => b.y1 - y(d3.select(el).datum().v),
        delay: anime.stagger(reduced ? 0 : 45), duration: 700, easing: "easeOutCubic" });
      return;
    }
    bars.attr("y", (d) => y(d.v)).attr("height", (d) => b.y1 - y(d.v)).attr("fill-opacity", 0.22);
    const pts = years.map((yr, i) => [x(yr) + x.bandwidth() / 2, a.harmonized[i], a.lo[i], a.hi[i]]);
    svg.append("path").datum(pts).attr("fill", "rgba(255,179,71,0.18)").attr("d", d3.area().x((d) => d[0]).y0((d) => y(d[2])).y1((d) => y(d[3])).curve(d3.curveMonotoneX));
    const ln = svg.append("path").datum(pts).attr("fill", "none").attr("stroke", "#ffe2a8").attr("stroke-width", 2.6)
      .attr("d", d3.line().x((d) => d[0]).y((d) => y(d[1])).curve(d3.curveMonotoneX));
    const len = ln.node().getTotalLength();
    ln.attr("stroke-dasharray", `${len} ${len}`).attr("stroke-dashoffset", len);
    anime({ targets: ln.node(), strokeDashoffset: [len, 0], duration: reduced ? 0 : 1800, easing: "easeInOutSine" });
    svg.append("text").attr("class", "fig-title").attr("x", pts[0][0]).attr("y", y(pts[0][3]) - 14).attr("fill", "#ffe2a8").text("one record, one language");
  }
  function ringJump() {
    if (!record) return;
    const { x, y, a } = record, i = a.years.indexOf(data.viirs_start);
    if (i < 0) return;
    ring(x(data.viirs_start) + x.bandwidth() / 2, y(a.naive[i]) - 4, Math.max(26, x.bandwidth() * 1.6), `${data.viirs_start}: ×${(data.jump ? data.jump.naive_ratio : 4).toFixed(1)} overnight`);
  }

  /* ------------------------------------------------------------------ the viewer's place */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const myName = () => (me ? me.name : HOME.name);
  const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
  const airWord = (a) => (a && a.verdict ? a.verdict.air.label.toLowerCase() : "unknown");

  async function loadAir(p) {
    return fetch(`/api/air?lat=${p.lat}&lon=${p.lon}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  function airBox(a) {
    if (!a) return `<p class="story-note">The air service isn't answering right now. The app will try again.</p>`;
    const n = a.sites[0];
    return `<div class="story-stats"><div><strong>${a.verdict.aqi ?? "—"}</strong><span>air quality index, ${esc(airWord(a))}</span></div>
      <div><strong>${fmt(a.site_count)}</strong><span>flares and factories within 100 km${n ? `, closest ${n.km.toFixed(0)} km ${compass(n.bearing)}` : ""}</span></div></div>`;
  }

  async function pickMe(p, root) {
    me = { name: p.name, lat: +p.lat, lon: +p.lon };
    pin = me; meAir = null;
    layers({ flares: 1, archive: 0.1, pin: 1, globe: 1.6, cx: 0.66 });
    rotateTo(me.lon, me.lat, 1600);
    const out = root && root.querySelector("#story-me");
    if (out) out.innerHTML = `<p class="story-note">Looking around ${esc(me.name)}…</p>`;
    dialogue.say(`Let me look around <strong>${esc(me.name)}</strong>. I'm asking the satellites about factories, and a weather service about the air…`, "think");
    meAir = await loadAir(me);
    if (!me || me.name !== p.name) return;
    if (out) out.innerHTML = airBox(meAir);
    if (!meAir) { dialogue.say(`I couldn't reach the air service for ${esc(me.name)}. No problem, we'll try again at the end.`, "worried"); return; }
    const n = meAir.sites[0], lvl = meAir.verdict.level;
    dialogue.say(`${esc(me.name)}: the air is <strong>${esc(airWord(meAir))}</strong> right now (index ${meAir.verdict.aqi ?? "?"}). `
      + (n ? `${meAir.site_count} gas flares and factories sit within 100 km, the closest ${n.km.toFixed(0)} km to the ${compass(n.bearing)}.` : "No flares or factories within 100 km. Lucky you!")
      + " Keep that in mind. We'll come back to it.", lvl >= 4 ? "worried" : lvl <= 1 ? "happy" : "think");
  }

  function wireWhere(root) {
    const q = root.querySelector("#story-q"), results = root.querySelector("#story-results");
    let timer = null, found = [];
    const choose = (p) => { results.innerHTML = ""; q.value = p.name; pickMe(p, root); };
    q.addEventListener("input", () => {
      clearTimeout(timer);
      const text = q.value.trim();
      if (text.length < 2) { results.innerHTML = ""; return; }
      timer = setTimeout(async () => {
        found = await fetch(`/api/places?q=${encodeURIComponent(text)}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
        results.innerHTML = found.length ? found.slice(0, 4).map((p, i) => `<button data-i="${i}"><strong>${esc(p.name)}</strong> <span>${esc([p.admin, p.country].filter(Boolean).join(", "))}</span></button>`).join("")
          : `<p class="story-note">No place called "${esc(text)}". Try a bigger town nearby.</p>`;
        results.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => choose(found[+b.dataset.i])));
      }, 280);
    });
    q.addEventListener("keydown", (e) => { if (e.key === "Enter" && found.length) { e.preventDefault(); choose(found[0]); } });
    root.querySelectorAll("[data-place]").forEach((b) => b.addEventListener("click", () => choose(PLACES[+b.dataset.place])));
    const loc = root.querySelector("#story-locate");
    if (loc) loc.addEventListener("click", () => {
      if (!navigator.geolocation) { dialogue.say("Your browser can't share a location. Type your town instead!", "think"); return; }
      loc.textContent = "Finding you…";
      navigator.geolocation.getCurrentPosition((g) => { loc.textContent = "Use my location"; choose({ name: "Your location", lat: +g.coords.latitude.toFixed(3), lon: +g.coords.longitude.toFixed(3) }); },
        () => { loc.textContent = "Use my location"; dialogue.say("I couldn't find you. Type your town instead!", "think"); }, { timeout: 10000, maximumAge: 600000 });
    });
  }

  /* ------------------------------------------------------------------ the mystery quiz and the game */
  function wireQuiz(root) {
    root.querySelectorAll("[data-guess]").forEach((b) => b.addEventListener("click", () => {
      const sky = b.dataset.guess === "sky";
      root.querySelectorAll("[data-guess]").forEach((o) => { o.disabled = true; o.classList.toggle("picked", o === b); });
      dialogue.say(sky ? "Good instinct! Something did change, and it wasn't the fires. Press <strong>→</strong> and I'll show you the clue."
        : "That's what most people guess. Climate does push fires up, but not <strong>" + (data && data.jump ? n(data.jump.naive_ratio) : "4") + "×</strong> in a single year. Press <strong>→</strong> for the real reason.",
        sky ? "proud" : "wink");
    }));
  }

  function pickGame() {
    if (!severity || !severity.points || severity.points.length < 30) return null;
    const pts = severity.points.filter((p) => p[4] >= 2 && p[3] > 0);
    const deg = (a, b) => d3.geoDistance([a[1], a[0]], [b[1], b[0]]) * 180 / Math.PI;
    for (let t = 0; t < 40; t++) {
      const anchor = pts[Math.floor(Math.random() * pts.length)];
      const near = pts.filter((p) => deg(p, anchor) < 35);
      if (near.length < 3) continue;
      near.sort((a, b) => a[2] - b[2]);
      const trio = [near[near.length - 1], near[Math.floor(near.length / 2)], near[0]];
      if (trio[0][2] - trio[2][2] < 0.25) continue;                       // the AI must have a real opinion
      if (Math.min(deg(trio[0], trio[1]), deg(trio[0], trio[2]), deg(trio[1], trio[2])) < 5) continue;   // far enough apart to tell apart on the globe
      for (let i = trio.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [trio[i], trio[j]] = [trio[j], trio[i]]; }
      return { cards: trio.map((p, i) => ({ letter: "ABC"[i], lat: p[0], lon: p[1], p: p[2], frp: p[3], n: p[4], country: p[5] })), anchor };
    }
    return null;
  }
  function wireGame(root) {
    if (!game) return;
    root.querySelectorAll("[data-card]").forEach((b) => b.addEventListener("click", () => {
      if (guess != null) return;
      guess = +b.dataset.card;
      const truth = game.cards.reduce((best, c, i) => (c.frp > game.cards[best].frp ? i : best), 0);
      const ai = game.cards.reduce((best, c, i) => (c.p > game.cards[best].p ? i : best), 0);
      root.querySelectorAll("[data-card]").forEach((el) => {
        const c = game.cards[+el.dataset.card];
        el.disabled = true;
        el.classList.toggle("picked", +el.dataset.card === guess);
        el.classList.toggle("truth", +el.dataset.card === truth);
        el.querySelector(".gc-reveal").innerHTML = `AI chance <strong>${Math.round(c.p * 100)}%</strong> · measured <strong>${fmt(c.frp)} MW</strong>${+el.dataset.card === truth ? " · the fiercest" : ""}`;
      });
      const you = guess === truth, bot = ai === truth, L = game.cards;
      let say, mood;
      if (you && bot) { say = `You and the AI both picked <strong>${L[truth].letter}</strong>, and you were right: ${fmt(L[truth].frp)} MW. Nice eye!`; mood = "proud"; }
      else if (you) { say = `You got it, it's <strong>${L[truth].letter}</strong> at ${fmt(L[truth].frp)} MW, and the AI picked ${L[ai].letter}. Point to you!`; mood = "laugh"; }
      else if (bot) { say = `It was <strong>${L[truth].letter}</strong> at ${fmt(L[truth].frp)} MW. The AI picked it; you went for ${L[guess].letter}. The model reads heat, place and season, and that edge adds up.`; mood = "wink"; }
      else { say = `The fiercest was <strong>${L[truth].letter}</strong> at ${fmt(L[truth].frp)} MW. The AI said ${L[ai].letter}, you said ${L[guess].letter}, so we both missed this one. It's not magic: across today's fires it catches ${pct(severity.severe_caught)} of the severe ones.`; mood = "think"; }
      dialogue.say(say + " Press <strong>→</strong> to go on.", mood);
    }));
  }

  /* ------------------------------------------------------------------ the script */
  const n = (v, d = 1) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const stats = (items) => `<div class="story-stats">${items.map(([v, k]) => `<div><strong>${v}</strong><span>${k}</span></div>`).join("")}</div>`;
  const team = [["GE", "George Essam"], ["ME", "Mathew Emad"], ["SA", "Sondos Alsayed"]];
  const yearTotal = () => (data && data.annual ? data.annual.harmonized[data.annual.years.indexOf(data.year)] : null);
  const cov = () => data && data.validation && data.validation.length ? data.band_coverage : null;
  const APPS = [
    { view: "dashboard", name: "GeoFlare Dashboard", line: "Your place's fire calendar since 2003, today's fires, and the leaderboard." },
    { view: "fires", name: "GeoFlare Fires", line: "Which fires could turn severe, the next four weeks, and the full archive map." },
    { view: "air", name: "GeoFlare Air", line: "Is your air safe near flares and factories, and what to do about it." },
  ];
  const myStepList = () => (meAir && meAir.steps ? `<ol class="story-steps">${meAir.steps.slice(0, 3).map((s) => `<li><strong>${esc(s.title)}</strong><span>${esc(s.text)}</span></li>`).join("")}</ol>` : "");

  const scenes = [
    { chapter: "Team FLARECRAFT presents GeoFlare", title: () => "Right now, <em>fires</em> are burning.",
      stats: () => (live ? stats([[fmt(live.fires), "fire hotspots seen in the last day"], [fmt(live.severe), "of them giving off 10 MW or more"]]) : ""),
      enter: () => { clearFigure(); unpoint(); fadeGlobe(1); layers({ live: live ? 1 : 0, archive: live ? 0 : 0.7, cx: 0.66, globe: 1, spin: 0.07 }); },
      lines: [
        { mood: "happy", say: "Hi, I'm <strong>Flick</strong>, a little spark from Assiut, Egypt. I get to watch every fire on the planet, through NASA's satellites." },
        { mood: "wow", say: () => (live ? `Right now there are <strong>${fmt(live.fires)}</strong> of them. Every dot you see is a hotspot the satellites spotted since yesterday.` : "Right now there are thousands of them. Every dot is a hotspot the satellites spotted since yesterday.") },
        { mood: "wink", say: "Some are farms. Some are forests. And a few aren't fires at all. Stick with me and I'll show you which." },
      ] },
    { chapter: "First, a question", title: () => "Where do <em>you</em> live?",
      panel: () => `<div class="story-panel"><div class="story-ask"><input id="story-q" placeholder="Your town or city" autocomplete="off" aria-label="Your town or city"></div>
        <div id="story-results" class="story-results"></div>
        <div class="story-chips">${PLACES.map((p, i) => `<button data-place="${i}">${p.name}</button>`).join("")}<button id="story-locate" class="strong">Use my location</button></div>
        <div id="story-me"></div></div>`,
      wire: wireWhere,
      stats: () => "",
      enter: () => { clearFigure(); fadeGlobe(1); layers({ flares: me ? 1 : 0, archive: me ? 0.1 : 0.5, pin: me ? 1 : 0, cx: 0.66, globe: me ? 1.6 : 1, spin: 0.05 }); if (!me) { pin = { ...HOME }; } },
      lines: [
        { mood: "think", say: "Before we start, I'd like to know where home is for you. Type your town, tap one below, or let me find you. Or skip ahead with <strong>→</strong>." },
      ] },
    { chapter: "Chapter 1 · A year of fire", title: () => `${data ? data.year : "One year"}, one week at a time`,
      stats: () => (yearTotal() ? stats([[fmt(yearTotal()), `fire hotspots seen from space in ${data.year}`]]) : ""),
      enter: () => { clearFigure(); unpoint(); fadeGlobe(1); playWeeks(); layers({ archive: 1, cx: 0.66, globe: 1, spin: 0.08 }); },
      exit: stopWeeks,
      lines: [
        { mood: "wow", say: "This is every fire of 2025, week by week. Watch the counter in the corner climb!" },
        { mood: "think", say: "See that band sweeping across Africa? That's the dry season moving. Farmers and grasslands burn on a calendar.",
          beat: () => { rotateTo(20, -2, 1600).then(() => { view.spin = 0.02; point(24, -9, "Africa's dry-season fires", 130); }); } },
      ] },
    { chapter: "Chapter 2 · A mystery", title: () => `Then, in ${data ? data.viirs_start : 2012}, fires <em>jumped</em>`,
      panel: () => `<div class="story-panel"><p class="story-q">Did the planet really start burning more?</p>
        <div class="story-choices"><button data-guess="earth">Yes, something changed on Earth</button><button data-guess="sky">No, something changed up in the sky</button></div></div>`,
      wire: wireQuiz,
      stats: () => (data && data.jump ? stats([[`×${n(data.jump.naive_ratio)}`, "more fires, overnight"]]) : ""),
      enter: () => { unpoint(); fadeGlobe(0.1); layers({ archive: 0.2 }); recordFigure(false); },
      lines: [
        { mood: "think", say: "Satellites have counted fires every year since 2003. Here's the whole planet, year by year." },
        { mood: "worried", say: () => `Now look at ${data ? data.viirs_start : 2012}. The count leaps <strong>${data && data.jump ? n(data.jump.naive_ratio) : "4"} times</strong> in one year. Did Earth really catch fire? Take a guess, then press <strong>→</strong>.`,
          beat: ringJump },
      ] },
    { chapter: "Chapter 2 · The clue", title: () => "We got a <em>sharper eye</em>",
      stats: () => "",
      enter: () => { fadeGlobe(0.1); pixelFigure(); },
      lines: [
        { mood: "think", say: () => `In ${data ? data.viirs_start : 2012}, a new satellite camera called VIIRS joined the old one, MODIS. Same fire, two pairs of eyes.` },
        { mood: "laugh", say: () => `The old eye sees big 1 km squares and counts <strong>${pixels.modis}</strong> hotspots. The new eye sees 375 m squares and counts <strong>${pixels.viirs}</strong>. Glue the records together and you get a fake jump!` },
      ] },
    { chapter: "Chapter 3 · The fix", title: () => "So we taught a computer to <em>translate</em>",
      stats: () => (cov() ? stats([[`${data.validation.length}`, "years tested that it had never seen"], [`${Math.round(cov().month * 100)}%`, "of true values inside our 80% ranges"]]) : ""),
      enter: () => { fadeGlobe(0.1); recordFigure(true); },
      lines: [
        { mood: "proud", say: "Our model studied every week when both satellites flew together, and learned how many fires the new eye sees for whatever the old eye saw." },
        { mood: "happy", say: "Then it rebuilt the old years in the new eye's units. The fake jump is gone. We tested it on years it never saw, and gave every number an honest range. That's your fire diary: every place, every week since 2003." },
      ] },
    { chapter: "Chapter 4 · Today", title: () => (live ? `<em>${fmt(live.fires)}</em> fires, and counting` : "Fires burning <em>right now</em>"),
      stats: () => (live ? stats([[live.countries[0] ? live.countries[0].country : "—", "burning most today"], [live.biggest[0] ? `${fmt(live.biggest[0].frp)} MW` : "—", live.biggest[0] ? `the fiercest, in ${live.biggest[0].country || "open country"}` : "fiercest fire"]]) : ""),
      enter: () => { clearFigure(); unpoint(); fadeGlobe(1); layers({ live: live ? 1 : 0, archive: live ? 0 : 0.6, globe: 1.05, cx: 0.66, spin: 0.07 }); },
      lines: [
        { mood: () => (live ? "wow" : "worried"), say: () => (live ? `Back to today. This is the same planet, this very day. ${live.countries[0] ? `<strong>${live.countries[0].country}</strong> has the most, with ${fmt(live.countries[0].fires)} hotspots.` : ""}` : "NASA is still sending today's fires. They'll be in the app in a moment.") },
        { mood: "worried", say: "Most are small. But a few will grow into monsters. Can you tell which?" },
      ] },
    { chapter: "Chapter 4 · Beat the AI", title: () => "Which fire is the <em>fiercest</em>?",
      panel: () => (game ? `<div class="story-panel"><div class="story-cards">${game.cards.map((c, i) => `<button data-card="${i}"><span class="gc-letter">${c.letter}</span>
          <span class="gc-body"><strong>${esc(c.country || `${Math.abs(c.lat).toFixed(1)}°${c.lat >= 0 ? "N" : "S"}, ${Math.abs(c.lon).toFixed(1)}°${c.lon >= 0 ? "E" : "W"}`)}</strong>
          <small>${fmt(c.n)} hotspot${c.n === 1 ? "" : "s"} in this square</small><em class="gc-reveal"></em></span></button>`).join("")}</div></div>`
        : `<div class="story-panel"><p class="story-note">The AI model is asleep, so no game today. Start it with start.cmd and it will score today's fires.</p></div>`),
      wire: wireGame,
      stats: () => (severity ? stats([[pct(severity.auc), "of the time our AI ranks a severe fire above a mild one"]]) : ""),
      enter: () => {
        clearFigure(); fadeGlobe(1); guess = null; game = pickGame();
        layers({ severity: severity ? 0.35 : 0, live: severity ? 0 : 0.6, globe: game ? 1.7 : 1.05, cx: 0.66, spin: 0.02 });
        if (game) { const g = game; rotateTo(g.anchor[1], g.anchor[0], 1500).then(() => { if (game === g) pointMany(g.cards.map((c) => ({ lon: c.lon, lat: c.lat, label: c.letter, r: 26 }))); }); }
        else unpoint();
        render(scenes[scene]);
      },
      lines: [
        { mood: "think", say: "Our AI, GeoData, reads each fire's heat, place, season and weather and guesses how severe it will be. Severe means 10 megawatts or more." },
        { mood: "wink", say: () => (game ? "Let's see if you can beat it. Three fires are burning right now. Tap the one you think is giving off the most heat." : "My AI friend is asleep right now. Start it with start.cmd and I'll score today's fires for you.") },
      ] },
    { chapter: "Chapter 4 · Looking ahead", title: () => "Where to <em>watch</em> next",
      stats: () => (outlook && outlook.countries.length ? stats(outlook.countries.slice(0, 3).map((c) => [c.country, `about ${fmt(c.severe)} severe fires expected`])) : ""),
      enter: () => { clearFigure(); unpoint(); fadeGlobe(1); layers({ outlook: outlook ? 1 : 0, severity: outlook ? 0 : 0.8, globe: 1.05, cx: 0.66, spin: 0.05 }); },
      lines: [
        { mood: "worried", say: () => (outlook && outlook.countries.length ? `The AI also looks ahead. Mixed with 23 years of fire diary, it says the next four weeks need watching in <strong>${outlook.countries.slice(0, 3).map((c) => c.country).join(", ")}</strong>.` : "Mixed with 23 years of fire diary, the AI points to the places to watch over the next four weeks.") },
      ] },
    { chapter: "Chapter 5 · A twist", title: () => "Some of these dots <em>never move</em>",
      stats: () => (live ? stats([[fmt(live.industrial), "hot pixels at factories and flares in the last day"]]) : ""),
      enter: () => { clearFigure(); fadeGlobe(1); layers({ flares: 1, archive: 0.12, globe: 1.25, cx: 0.66 }); rotateTo(48, 27); },
      lines: [
        { mood: "think", say: "Wait. Look closer. These blue dots glow every single week, summer and winter. Fires don't do that." },
        { mood: "wow", say: "They're not wildfires. They're <strong>gas flares and factories</strong>, burning day and night. Satellites see them too. This isn't all satellites can do!",
          beat: () => point(48.5, 29.5, "Gas flares of the Gulf", 90) },
      ] },
    { id: "air", chapter: () => `Chapter 5 · Back to ${myName()}`, title: () => `Now, <em>your</em> air`,
      panel: () => `<div class="story-panel">${airBox(meAir)}${myStepList()}
        <div class="story-chips"><button class="strong" id="story-open-air">Open my full air report</button></div></div>`,
      wire: (root) => root.querySelector("#story-open-air").addEventListener("click", (e) => { e.stopPropagation(); const p = me || { ...HOME, lat: 27.18, lon: 31.18 }; finish({ view: "air", sub: `${p.lat},${p.lon},${encodeURIComponent(p.name)}`, tour: false }); }),
      stats: () => "",
      enter: async () => {
        clearFigure(); fadeGlobe(1); unpoint();
        const p = me || { name: "Assiut", lat: 27.18, lon: 31.18 };
        pin = { lon: p.lon, lat: p.lat, name: p.name };
        layers({ flares: 1, pin: 1, globe: 1.6, cx: 0.66 }); rotateTo(p.lon, p.lat);
        if (!meAir) { meAir = await loadAir(p); if (scenes[scene] && scenes[scene].id === "air") { render(scenes[scene]); sayLine(); } }
      },
      lines: [
        { mood: () => (meAir && meAir.verdict.level >= 4 ? "worried" : "think"), say: () => (meAir
            ? `So, ${esc(myName())}. Here's your air today: <strong>${esc(airWord(meAir))}</strong>, index ${meAir.verdict.aqi ?? "?"}. ${meAir.sites[0] ? `The closest flare or factory is ${meAir.sites[0].km.toFixed(0)} km to the ${compass(meAir.sites[0].bearing)}.` : "No flare or factory is within 100 km."}`
            : "Millions of people live right next to these flames. Flares that burn badly put soot, nitrogen dioxide and sulphur into the air they breathe.") },
        { mood: "proud", say: () => (meAir && meAir.steps && meAir.steps.length ? `Here's what I'd do today: <strong>${esc(meAir.steps[0].title.toLowerCase())}</strong>. ${esc(meAir.steps[0].text)}` : "That's why we built GeoFlare Air.") },
        { mood: "happy", say: "That's <strong>GeoFlare Air</strong>. Tap the button for the whole report, with the wind map and animated steps. Or press <strong>→</strong> to meet the team." },
      ] },
    { chapter: "Team FLARECRAFT · Assiut, Egypt", title: () => "Made by <em>three friends</em>",
      stats: () => `<div class="team">${team.map(([i, name]) => `<div class="member"><span class="avatar">${i}</span>${name}</div>`).join("")}</div>`,
      enter: () => { clearFigure(); fadeGlobe(1); pin = { ...HOME, lat: 27.18, lon: 31.18, name: "Assiut" }; layers({ archive: 0.45, pin: 1, globe: 1.1, cx: 0.66, spin: 0.05 }); rotateTo(HOME.lon, HOME.lat - 6, 1600); },
      lines: [
        { mood: "laugh", say: "These are my humans: George, Mathew and Sondos. They built all of this for NASA Space Apps 2026, to show that science and fun aren't opposites." },
      ] },
    { chapter: "Your turn", title: () => "Three apps. <em>One planet.</em>",
      stats: () => `<div class="story-apps">${APPS.map((a) => `<button class="story-app ${a.view}" data-app="${a.view}"><strong>${a.name}</strong><span>${a.line}</span></button>`).join("")}</div>`,
      enter: () => { clearFigure(); unpoint(); fadeGlobe(1); layers({ live: live ? 0.8 : 0, archive: live ? 0 : 0.8, flares: 0.4, globe: 1, cx: 0.66, spin: 0.06 }); },
      lines: [
        { mood: "happy", say: "Where to first? Tap one of the three, or press <strong>→</strong> and I'll start you on the Dashboard. I'll come along and help." },
      ] },
  ];

  /* ------------------------------------------------------------------ playing it */
  const val = (x) => (typeof x === "function" ? x() : x);
  function render(s) {
    const html = `<div class="kicker">${val(s.chapter)}</div><h1>${val(s.title)}</h1>${val(s.stats) || ""}${s.panel ? val(s.panel) : ""}`;
    if (copy.dataset.html === html) return;
    copy.dataset.html = html;
    anime({ targets: copy, opacity: [1, 0], translateY: [0, -8], duration: reduced ? 0 : 200, easing: "easeInQuad",
      complete: () => {
        copy.innerHTML = html;
        copy.querySelectorAll("[data-app]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); finish({ view: b.dataset.app, tour: true }); }));
        if (s.wire) s.wire(copy);
        anime({ targets: copy, opacity: [0, 1], translateY: [10, 0], duration: reduced ? 0 : 520, easing: "easeOutQuad" });
      } });
  }
  function sayLine() {
    const s = scenes[scene], l = s.lines[line];
    $("story-step").textContent = `${scene + 1}/${scenes.length}`;
    dialogue.say(val(l.say), val(l.mood));
    if (l.beat) l.beat();
    if (line > 0 && !s.wire) render(s);   // numbers can arrive late (live data); refresh them on each line
  }
  function go(i, atLine = 0) {
    if (i >= scenes.length) return finish({ view: "dashboard", tour: true });
    if (i < 0) return;
    if (i !== scene) {
      const prev = scenes[scene];
      if (prev && prev.exit) prev.exit();
      scene = i;
      document.querySelectorAll("#story-dots span").forEach((d, k) => d.classList.toggle("on", k === i));
      $("story-dlg").querySelector(".dlg-back").disabled = i === 0;
      Voice.pop();
      render(scenes[i]);
      scenes[i].enter && scenes[i].enter();
    }
    line = Math.min(atLine, scenes[i].lines.length - 1);
    sayLine();
  }
  const next = () => (line + 1 < scenes[scene].lines.length ? go(scene, line + 1) : go(scene + 1));
  const back = () => (line > 0 ? go(scene, line - 1) : scene > 0 ? go(scene - 1, scenes[scene - 1].lines.length - 1) : null);

  function finish(opts = {}) {
    if (!running) return;
    stopWeeks(); clearInterval(refreshTimer);
    document.removeEventListener("keydown", keys);
    anime({ targets: "#story", opacity: [1, 0], duration: reduced ? 0 : 600, easing: "easeInQuad",
      complete: () => { $("story").hidden = true; running = false; cancelAnimationFrame(raf); onDone && onDone(opts); } });
  }

  function keys(e) {
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;   // typing a town must not move the story
    if (["ArrowRight", " ", "Enter", "PageDown"].includes(e.key)) { e.preventDefault(); dialogue.advance(next); }
    else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); dialogue.finish(true); back(); }
    else if (e.key === "Escape") finish({ view: "dashboard" });
  }

  async function open(done) {
    onDone = done;
    $("story").hidden = false; $("story").style.opacity = 1;
    if (!dialogue) {
      dialogue = new Dialogue($("story-dlg"), { onNext: next, onBack: () => { dialogue.finish(true); back(); }, size: 112 });
      $("story-dlg").addEventListener("click", () => dialogue.advance(next));
      $("story-dots").innerHTML = scenes.map(() => "<span></span>").join("");
      document.querySelectorAll("#story-dots span").forEach((d, k) => d.addEventListener("click", (e) => { e.stopPropagation(); dialogue.finish(true); go(k); }));
      $("story-skip").addEventListener("click", () => finish({ view: "dashboard" }));
      addEventListener("resize", () => { if (running) size(); });
    }
    size(); running = true; loop();
    if (!land) {
      const [intro, world] = await Promise.all([
        fetch("/api/intro").then((r) => r.json()).catch(() => null),
        d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json").catch(() => null),
      ]);
      data = intro;
      if (world) land = topojson.feature(world, world.objects.land);
      if (data) data.band_coverage = await fetch("/api/meta").then((r) => r.json()).then((m) => m.band_coverage).catch(() => null);
    }
    // The present and the future arrive in the background; lines and numbers use them when they are ready.
    const grab = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    grab("/api/live").then((v) => { live = v; });
    grab("/api/live/severity").then((v) => { severity = v; });
    grab("/api/outlook").then((v) => { outlook = v; });
    // Scenes with no interactive panel refresh their numbers when data lands.
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { const s = scenes[scene]; if (running && s && !s.wire) render(s); }, 1500);
    scene = -1; go(0);
    document.addEventListener("keydown", keys);
  }

  return { open };
})();
