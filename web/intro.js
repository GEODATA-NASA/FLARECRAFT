/* Ember Almanac — the story of our planet's fires, told by Flick.
   Past (the harmonized calendar) -> present (live fires) -> future (severity) -> beyond fire (industry). */
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
  const HOME = { lon: 31.19, lat: 27.18, name: "Assiut, Egypt" };

  let W = 0, H = 0, R = 0, land = null, data = null, live = null, severity = null, outlook = null;
  let scene = -1, onDone = null, running = false, raf = null, weekTimer = null, dialogue = null;
  const view = { rot: [-20, -12], spin: 0.06, globe: 1, cx: 0.66, week: 0, cumulative: 0,
                 archive: 0, live: 0, severity: 0, outlook: 0, flares: 0, pin: 0 };

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
    if (view.pin > 0.01 && visible(HOME.lon, HOME.lat)) {
      const [x, y] = projection([HOME.lon, HOME.lat]), t = (performance.now() % 1800) / 1800;
      ctx.strokeStyle = `rgba(255,248,239,${(1 - t) * view.pin})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6 + t * 22, 0, 6.283); ctx.stroke();
      ctx.fillStyle = `rgba(255,248,239,${view.pin})`; ctx.beginPath(); ctx.arc(x, y, 5, 0, 6.283); ctx.fill();
      ctx.font = "700 15px Manrope, sans-serif"; ctx.fillText(HOME.name, x + 14, y + 5);
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
    const i = d3.interpolate(view.rot.slice(), [-lon, -lat]), clock = { t: 0 }, saved = view.spin;
    view.spin = 0;
    return anime({ targets: clock, t: 1, duration: reduced ? 0 : ms, easing: "easeInOutCubic",
      update: () => { view.rot = i(clock.t); }, complete: () => { view.spin = saved * 0.3; } }).finished;
  }
  function fadeGlobe(opacity) { anime({ targets: canvas, opacity, duration: reduced ? 0 : 700, easing: "easeInOutQuad" }); }
  const layers = (on) => tweenView({ archive: 0, live: 0, severity: 0, outlook: 0, flares: 0, pin: 0, ...on }, 900);

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

  function pixelFigure() {
    clearFigure();
    const b = box(), gap = 40, side = Math.min((b.w - gap) / 2, b.h * 0.78);
    const SMALL = [[0.42, 2.55], [2.62, 0.48], [2.35, 2.62], [0.6, 0.55]];
    const front = (x, y) => ((x - 1.55) / 0.62) ** 2 + ((y - 1.45) / 0.42) ** 2 < 1 || ((x - 1.05) / 0.25) ** 2 + ((y - 1.0) / 0.18) ** 2 < 1;
    const burning = (x, y) => front(x, y) || SMALL.some(([a, c]) => (x - a) ** 2 + (y - c) ** 2 < 0.07 ** 2);
    const panels = [
      { name: "MODIS · older", res: "1 km squares", n: 3, threshold: 0.05, small: false, x: b.x0 },
      { name: "VIIRS · newer", res: "375 m squares", n: 8, threshold: 0.6, small: true, x: b.x0 + side + gap },
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
      const pixels = [];
      for (let a = 0; a < p.n; a++) for (let c = 0; c < p.n; c++) {
        let hits = 0;
        for (let s = 0; s < 12; s++) for (let t = 0; t < 12; t++) if (front((a + (s + 0.5) / 12) * km, (c + (t + 0.5) / 12) * km)) hits++;
        const hasSmall = SMALL.some(([x, yy]) => x >= a * km && x < (a + 1) * km && yy >= c * km && yy < (c + 1) * km);
        const on = hits / 144 > p.threshold || (p.small && hasSmall);
        if (on) lit++;
        pixels.push({ a, c, on });
      }
      g.selectAll(".px").data(pixels).join("rect").attr("class", "px").attr("x", (d) => d.a * cell + 1).attr("y", (d) => d.c * cell + 1)
        .attr("width", cell - 2).attr("height", cell - 2).attr("rx", 2).attr("fill", (d) => (d.on ? (i ? "#ff6a2b" : "#ffb347") : "transparent"))
        .attr("fill-opacity", 0).attr("stroke", "rgba(245,239,230,0.22)");
      g.append("text").attr("class", "fig-title").attr("y", side + 32).text(`${lit} hotspot${lit === 1 ? "" : "s"}`);
      anime({ targets: g.selectAll(".px").filter((d) => d.on).nodes(), fillOpacity: [0, 0.85], delay: anime.stagger(reduced ? 0 : 70, { start: 400 + i * 500 }), duration: 500, easing: "easeOutQuad" });
    });
  }

  function recordFigure(withFix) {
    clearFigure();
    if (!data || !data.annual || data.annual.years.length < 3) return;
    const a = data.annual, b = box(), years = a.years;
    const x = d3.scaleBand().domain(years).range([b.x0 + 44, b.x1]).padding(0.18);
    const y = d3.scaleLinear().domain([0, d3.max([...a.naive, ...a.hi]) * 1.08]).range([b.y1, b.y0]).nice();
    svg.append("g").attr("class", "fig-axis").attr("transform", `translate(${b.x0 + 44},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".2s")).tickSize(-(b.w - 44))).call((g) => g.select(".domain").remove());
    svg.append("g").attr("class", "fig-axis").attr("transform", `translate(0,${b.y1})`)
      .call(d3.axisBottom(x).tickValues(years.filter((d) => d % 4 === 3 || d === data.viirs_start)).tickSize(0)).call((g) => g.select(".domain").remove()).selectAll("text").attr("dy", "1.2em");
    const bars = svg.selectAll(".bar").data(years.map((yr, i) => ({ yr, v: a.naive[i] }))).join("rect")
      .attr("x", (d) => x(d.yr)).attr("width", x.bandwidth()).attr("rx", 2).attr("y", b.y1).attr("height", 0)
      .attr("fill", (d) => (d.yr >= data.viirs_start ? "#ff6a2b" : "#8a8f98"));
    if (years[0] < data.viirs_start) {
      const vx = x(data.viirs_start) - x.step() * x.paddingInner() / 2;
      svg.append("line").attr("x1", vx).attr("x2", vx).attr("y1", b.y0 - 10).attr("y2", b.y1).attr("stroke", "rgba(245,239,230,0.4)").attr("stroke-dasharray", "3 4");
      svg.append("text").attr("class", "fig-label").attr("x", vx + 8).attr("y", b.y0 - 2).text(`VIIRS arrives · ${data.viirs_start}`);
    }
    if (!withFix) {
      anime({ targets: bars.nodes(), y: (el) => y(d3.select(el).datum().v), height: (el) => b.y1 - y(d3.select(el).datum().v),
        delay: anime.stagger(reduced ? 0 : 45), duration: 700, easing: "easeOutCubic" });
      return;
    }
    bars.attr("y", (d) => y(d.v)).attr("height", (d) => b.y1 - y(d.v)).attr("fill-opacity", 0.22);
    const pts = years.map((yr, i) => [x(yr) + x.bandwidth() / 2, a.harmonized[i], a.lo[i], a.hi[i]]);
    svg.append("path").datum(pts).attr("fill", "rgba(255,179,71,0.18)").attr("d", d3.area().x((d) => d[0]).y0((d) => y(d[2])).y1((d) => y(d[3])).curve(d3.curveMonotoneX));
    const line = svg.append("path").datum(pts).attr("fill", "none").attr("stroke", "#ffe2a8").attr("stroke-width", 2.6)
      .attr("d", d3.line().x((d) => d[0]).y((d) => y(d[1])).curve(d3.curveMonotoneX));
    const len = line.node().getTotalLength();
    line.attr("stroke-dasharray", `${len} ${len}`).attr("stroke-dashoffset", len);
    anime({ targets: line.node(), strokeDashoffset: [len, 0], duration: reduced ? 0 : 1800, easing: "easeInOutSine" });
    svg.append("text").attr("class", "fig-title").attr("x", pts[0][0]).attr("y", y(pts[0][3]) - 14).attr("fill", "#ffe2a8").text("harmonized record");
  }

  function calendarFigure() {
    clearFigure();
    if (!data || !data.calendar) return;
    const { years, values, observed } = data.calendar, b = box();
    const left = 44, cw = (b.w - left) / 52, ch = Math.min(16, (b.h - 30) / years.length);
    const all = values.flat().filter((v) => v > 0).sort(d3.ascending);
    const lo = Math.max(1, d3.quantile(all, 0.05) || 1), hi = d3.quantile(all, 0.995) || 1;
    const ramp = d3.interpolateRgbBasis(["#3d2416", "#7c2d12", "#c2410c", "#f97316", "#fdba74", "#fff1c9"]);
    const color = (v) => (v <= 0 ? "#1d2229" : ramp(Math.min(1, Math.max(0, Math.log(v / lo) / Math.log(hi / lo)))));
    const g = svg.append("g").attr("transform", `translate(${b.x0},${b.y0 + 22})`);
    g.append("text").attr("class", "fig-label").attr("x", left).attr("y", -10).text("The whole planet · each square is one week");
    ["Jan", "Apr", "Jul", "Oct"].forEach((m, i) => g.append("text").attr("class", "fig-label").attr("x", left + i * 13 * cw).attr("y", years.length * ch + 18).text(m));
    years.forEach((yr, r) => {
      const row = g.append("g").attr("class", "cal-row").attr("opacity", 0);
      row.append("text").attr("class", "fig-label").attr("x", left - 8).attr("y", r * ch + ch * 0.75).attr("text-anchor", "end").text(r % 2 ? "" : yr);
      values[r].forEach((v, w) => row.append("rect").attr("x", left + w * cw).attr("y", r * ch).attr("width", cw - 1).attr("height", ch - 1).attr("rx", 1.5).attr("fill", color(v))
        .attr("opacity", observed[r] ? 1 : 0.75));
    });
    anime({ targets: g.selectAll(".cal-row").nodes(), opacity: [0, 1], delay: anime.stagger(reduced ? 0 : 60), duration: 400, easing: "easeOutQuad" });
  }

  /* ------------------------------------------------------------------ scenes */
  const n = (v, d = 1) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const validation = () => {
    const rows = (data && data.validation) || [];
    return rows.length ? { model: d3.median(rows, (r) => r.model_month_mdape), global: d3.median(rows, (r) => r.global_month_mdape), years: rows.length } : null;
  };
  const stats = (items) => `<div class="story-stats">${items.map(([v, k]) => `<div><strong>${v}</strong><span>${k}</span></div>`).join("")}</div>`;
  const team = [["GE", "George Essam"], ["ME", "Mathew Emad"], ["SA", "Sondos Alsayed"]];

  const scenes = [
    { chapter: "Team FLARECRAFT presents",
      title: () => "Every day, satellites watch the Earth <em>burn</em>.",
      body: () => "This is the story of our planet's fires: what happened, what is burning right now, and what could come next.",
      flick: "Hi! I'm <strong>Flick</strong>, a little fire spirit with a satellite friend. Press <strong>→</strong> or click me to follow along!", mood: "happy",
      enter: async () => { clearFigure(); fadeGlobe(1); layers({ cx: 0.66, globe: 1, spin: 0.06 }); } },
    { chapter: "Chapter 1 · The past",
      title: () => "Each glow is a <em>week</em> of burning.",
      body: () => `This is ${data ? data.year : "one year"}, week by week. Savanna fires sweep Africa in the dry season, farmers burn crop leftovers across Asia, forests ignite in the northern summer.`,
      flick: "Whoa, look at all my cousins! Watch the counter go up.", mood: "wow",
      enter: async () => { clearFigure(); fadeGlobe(1); playWeeks(); layers({ archive: 1, cx: 0.66, globe: 1, spin: 0.08 }); }, exit: stopWeeks },
    { chapter: "Chapter 1 · The problem",
      title: () => "Two satellites, <em>two different stories</em>.",
      body: () => `The older satellite, MODIS, sees the ground in 1 km squares. The newer VIIRS sees 375 m squares, so for the same fires it counts about <strong>${n(data && data.global_ratio)}×</strong> more.`,
      flick: "Same fire, different eyes! MODIS lights up 2 squares, VIIRS lights up 10. Hmm...", mood: "think",
      enter: async () => { fadeGlobe(0.1); layers({ archive: 0.2 }); pixelFigure(); } },
    { chapter: "Chapter 1 · The fake jump",
      title: () => `Fire didn't multiply in ${data ? data.viirs_start : 2012}. <em>Our eyes got sharper.</em>`,
      body: () => (data && data.jump ? `Put the two records side by side and the planet seems to burn <strong>${n(data.jump.naive_ratio)}×</strong> more overnight. It didn't.`
        : "Put the two records side by side and fire seems to jump overnight. It didn't."),
      flick: "It's like putting on glasses and thinking the world suddenly got more detailed. Hehe!", mood: "laugh",
      enter: async () => { fadeGlobe(0.1); recordFigure(false); } },
    { chapter: "Chapter 1 · Our fix",
      title: () => "One record, in <em>one language</em>.",
      body: () => {
        const v = validation();
        return `A model learned how both satellites see the same fires, then translated the old years into the new satellite's language.${v
          ? stats([[`${n(v.model, 0)}%`, "typical error on years it never saw"], [`${n(v.global, 0)}%`, "with a simple fixed factor"]]) : ""}`;
      },
      flick: "We taught a computer to translate old-satellite into new-satellite. Bye bye, fake jump!", mood: "proud",
      enter: async () => { fadeGlobe(0.1); recordFigure(true); } },
    { chapter: "Chapter 1 · The fire calendar",
      title: () => "A fire diary for <em>every place</em> on Earth.",
      body: () => "Now every week since 2003 sits in one calendar. When does the season start? Which year was the worst? Was this month unusual?",
      flick: "Every little square is one week of fire. Pick any place and it gets its own calendar!", mood: "happy",
      enter: async () => { fadeGlobe(0.1); calendarFigure(); } },
    { chapter: "Chapter 2 · Right now",
      title: () => "These fires are burning <em>right now</em>.",
      body: () => (live ? `NASA's VIIRS satellites spotted these since ${live.oldest}. Fresh data arrives every few hours.`
        + stats([[fmt(live.fires), "fire hotspots"], [fmt(live.severe), "strong fires (10 MW+)"], [fmt(live.industrial), "factories & flares"]])
        : "Today's fires are still on their way from NASA. You'll find them in the <strong>Right now</strong> tab."),
      flick: () => (live ? "Wow, this isn't history anymore. These are happening as we speak!" : "Hmm, NASA is still sending today's fires. Let's keep going!"),
      mood: () => (live ? "wow" : "worried"),
      enter: async () => { clearFigure(); fadeGlobe(1); layers({ live: live ? 1 : 0, archive: live ? 0 : 0.6, globe: 1.05, cx: 0.66, spin: 0.07 }); } },
    { chapter: "Chapter 3 · How dangerous?",
      title: () => "Which fires could turn <em>severe</em>?",
      body: () => (severity ? "Our GeoData AI model, trained on 2025, reads each fire's heat, place and season. Today we checked it against what the satellites measured."
        + stats([[pct(severity.auc), "ranks a severe fire above a mild one"], [pct(severity.severe_caught), "of severe fires caught"], [fmt(severity.scored), "fires scored today"]])
        : "Our GeoData AI model estimates the chance each fire is severe (10 MW or more). Start the GeoData service to see it score today's fires."),
      flick: () => (severity ? "Red means likely severe, yellow means mild. And it was right most of the time today!" : "My model friend is asleep right now. Wake it up with start.cmd!"),
      mood: () => (severity ? "proud" : "worried"),
      enter: async () => { clearFigure(); fadeGlobe(1); layers({ severity: severity ? 1 : 0, live: severity ? 0 : 0.6, globe: 1.05, cx: 0.66, spin: 0.05 }); } },
    { chapter: "Chapter 3 · The next four weeks",
      title: () => "Where to <em>watch</em> next.",
      body: () => (outlook ? `For ${outlook.label}, the calendar knows where fires usually burn, and the model knows how fierce they tend to be. Together they point to the places to watch.`
        + stats(outlook.countries.slice(0, 3).map((c) => [c.country, `about ${fmt(c.severe)} severe fires expected`]))
        : "The calendar knows where fires usually burn in the coming weeks; the model knows how fierce they tend to be."),
      flick: "Big red spots are where firefighters should keep their eyes open these weeks. Stay safe out there!", mood: "worried",
      enter: async () => { clearFigure(); fadeGlobe(1); layers({ outlook: outlook ? 1 : 0, archive: outlook ? 0 : 0.5, globe: 1.05, cx: 0.66 }); } },
    { chapter: "Chapter 4 · Beyond fire",
      title: () => "Satellites see more than <em>wildfires</em>.",
      body: () => "Gas flares, refineries and steel plants glow all year. We recognise them from 23 years of history, keep them out of the fire counts, and map them as industrial heat.",
      flick: "Psst! This isn't all satellites can do. The blue lights aren't wildfires, they're gas flares and factories!", mood: "wink",
      enter: async () => { clearFigure(); fadeGlobe(1); layers({ flares: 1, archive: 0.15, globe: 1.25, cx: 0.66 }); rotateTo(48, 26); } },
    { chapter: "Team FLARECRAFT · Assiut, Egypt",
      title: () => "Science and fun <em>aren't opposites</em>.",
      body: () => `We look at the topics people tend to overlook, and turn real NASA data into something everyone can explore.
        <div class="team">${team.map(([i, name]) => `<div class="member"><span class="avatar">${i}</span>${name}</div>`).join("")}</div>`,
      flick: "And these are my humans! George, Mathew and Sondos built all of this for NASA Space Apps 2026.", mood: "laugh",
      enter: async () => { clearFigure(); fadeGlobe(1); layers({ archive: 0.45, pin: 1, globe: 1.1, cx: 0.66, spin: 0.05 }); rotateTo(31, 24, 1600); } },
    { chapter: "Your turn",
      title: () => "Explore our planet's fires <em>yourself</em>.",
      body: () => "The app has the same four chapters: <strong>History</strong>, <strong>Right now</strong>, <strong>Severity</strong> and <strong>Industry</strong>.",
      flick: "Press <strong>→</strong> once more and I'll show you around the app. Let's go!", mood: "happy",
      enter: async () => { clearFigure(); fadeGlobe(1); layers({ live: live ? 0.8 : 0, archive: live ? 0 : 0.8, flares: 0.4, globe: 1, cx: 0.66, spin: 0.06 }); } },
  ];

  async function go(i) {
    if (i >= scenes.length) return finish();
    if (i < 0 || i === scene) return;
    const prev = scenes[scene];
    if (prev && prev.exit) prev.exit();
    scene = i;
    const s = scenes[i], val = (x) => (typeof x === "function" ? x() : x);
    document.querySelectorAll("#story-dots span").forEach((d, k) => d.classList.toggle("on", k === i));
    $("story-dlg").querySelector(".dlg-back").disabled = i === 0;
    Voice.pop();
    anime({ targets: copy, opacity: [1, 0], translateY: [0, -8], duration: reduced ? 0 : 220, easing: "easeInQuad",
      complete: () => {
        copy.innerHTML = `<div class="kicker">${val(s.chapter)}</div><h1>${val(s.title)}</h1><div class="story-body">${val(s.body)}</div>`;
        anime({ targets: copy, opacity: [0, 1], translateY: [10, 0], duration: reduced ? 0 : 520, easing: "easeOutQuad" });
      } });
    dialogue.say(val(s.flick), val(s.mood));
    s.enter && s.enter();
  }

  function finish() {
    if (!running) return;
    stopWeeks();
    const sawAll = scene >= scenes.length - 1;
    document.removeEventListener("keydown", keys);
    anime({ targets: "#story", opacity: [1, 0], duration: reduced ? 0 : 600, easing: "easeInQuad",
      complete: () => { $("story").hidden = true; running = false; cancelAnimationFrame(raf); onDone && onDone({ tour: sawAll }); } });
  }

  function keys(e) {
    if (["ArrowRight", " ", "Enter", "PageDown"].includes(e.key)) { e.preventDefault(); dialogue.advance(() => go(scene + 1)); }
    else if (["ArrowLeft", "PageUp"].includes(e.key)) go(scene - 1);
    else if (e.key === "Escape") finish();
  }

  async function open(done) {
    onDone = done;
    $("story").hidden = false; $("story").style.opacity = 1;
    if (!dialogue) {
      dialogue = new Dialogue($("story-dlg"), { onNext: () => go(scene + 1), onBack: () => go(scene - 1), size: 112 });
      $("story-dlg").addEventListener("click", () => dialogue.advance(() => go(scene + 1)));
      $("story-dots").innerHTML = scenes.map(() => "<span></span>").join("");
      document.querySelectorAll("#story-dots span").forEach((d, k) => d.addEventListener("click", (e) => { e.stopPropagation(); go(k); }));
      $("story-skip").addEventListener("click", finish);
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
    }
    // Present and future arrive in the background; scenes use them when they are ready.
    const grab = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    grab("/api/live").then((v) => { live = v; });
    grab("/api/live/severity").then((v) => { severity = v; });
    grab("/api/outlook").then((v) => { outlook = v; });
    scene = -1; go(0);
    document.addEventListener("keydown", keys);
  }

  return { open };
})();
