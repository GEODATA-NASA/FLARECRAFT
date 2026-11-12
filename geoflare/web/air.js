/* GeoFlare Air: pick where you live, see how safe the air is near gas flares and factories, and what to do about it. */
const Air = (() => {
  const { $, fmt, api, css, esc, toast, facts, loadingFacts, bars, axes, getMap, layers } = UI;
  const PRESETS = [
    { name: "Assiut", country: "Egypt", lat: 27.18, lon: 31.18 },
    { name: "Basra", country: "Iraq", lat: 30.51, lon: 47.81 },
    { name: "Port Harcourt", country: "Nigeria", lat: 4.82, lon: 7.03 },
    { name: "Kuwait City", country: "Kuwait", lat: 29.37, lon: 47.98 },
    { name: "Houston", country: "United States", lat: 29.76, lon: -95.37 },
    { name: "Delhi", country: "India", lat: 28.61, lon: 77.21 },
  ];
  const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
  const LEVEL_COLOR = ["--label-3", "--good", "--fair", "--mild", "--mid", "--hot", "--purple"];
  const aqiColor = (v) => css(LEVEL_COLOR[v == null ? 0 : v <= 50 ? 1 : v <= 100 ? 2 : v <= 150 ? 3 : v <= 200 ? 4 : v <= 300 ? 5 : 6]);
  const state = { mounted: false, report: null, place: null, step: 0, playing: false, timer: null, industry: null, indCountry: null, live: null };
  let flick = null, searchTimer = null;

  /* ================================================================ picking a place */
  function mount() {
    state.mounted = true;
    flick = UI.flickCard($("air-flick"), { mood: "think" });
    $("air-presets").innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.name}</button>`).join("");
    $("air-presets").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => pick(PRESETS[+b.dataset.i])));
    const input = $("air-q"), list = $("air-results");
    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      searchTimer = setTimeout(async () => {
        const found = await api(`/api/places?q=${encodeURIComponent(q)}`).catch(() => []);
        list.innerHTML = found.length ? found.map((p, i) => `<button role="option" data-i="${i}"><strong>${esc(p.name)}</strong><span>${esc([p.admin, p.country].filter(Boolean).join(", "))}</span></button>`).join("")
          : `<p class="empty">No place called "${esc(q)}". Try a bigger town nearby.</p>`;
        list.hidden = false;
        list.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { list.hidden = true; input.value = found[+b.dataset.i].name; pick(found[+b.dataset.i]); }));
        list.found = found;
      }, 280);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && list.found && list.found.length) { e.preventDefault(); list.hidden = true; pick(list.found[0]); }
      if (e.key === "Escape") list.hidden = true;
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".air-search")) list.hidden = true; });
    $("air-locate").addEventListener("click", () => {
      if (!navigator.geolocation) { toast("This browser can't share your location. Type your town instead."); return; }
      $("air-locate").textContent = "Finding you…";
      navigator.geolocation.getCurrentPosition(
        (p) => { $("air-locate").textContent = "Use my location"; pick({ name: "Your location", lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) }); },
        () => { $("air-locate").textContent = "Use my location"; toast("We couldn't get your location. Type your town instead."); },
        { timeout: 10000, maximumAge: 600000 });
    });
    $("step-prev").addEventListener("click", () => { stop(); showStep(state.step - 1); });
    $("step-next").addEventListener("click", () => { stop(); showStep(state.step + 1); });
    $("step-play").addEventListener("click", () => (state.playing ? stop() : play()));
    UI.onTheme(() => { if (state.report) { renderMap(); renderForecast(); } renderIndustry(); });
    loadIndustry();
    flick.say("Where do you live? Type your town, tap <strong>Use my location</strong>, or try one of the places below. Basra and Port Harcourt sit right next to big gas flares.", "think");
  }

  async function pick(p) {
    state.place = p;
    const label = p.country && p.name !== p.country ? `${p.name}, ${p.country}` : p.name;
    history.replaceState(null, "", `/air#${p.lat.toFixed(3)},${p.lon.toFixed(3)},${encodeURIComponent(label)}`);
    document.querySelectorAll("#air-presets button").forEach((b) => b.classList.toggle("on", PRESETS[+b.dataset.i].name === p.name));
    stop();
    $("air-result").hidden = false;
    $("air-verdict").innerHTML = `<div class="verdict-loading"><span class="spinner"></span>Checking the air in ${esc(label)}…</div>`;
    flick.say(`Let me check ${esc(label)}. I'm asking the satellites about factories nearby, and the weather service about the air and wind…`, "think");
    $("air-result").scrollIntoView({ behavior: UI.reduced() ? "auto" : "smooth", block: "start" });
    let r;
    try { r = await api(`/api/air?lat=${p.lat}&lon=${p.lon}`); }
    catch (err) { $("air-verdict").innerHTML = `<p class="empty">We couldn't check the air here: ${esc(err.message)}</p>`; flick.say("Hmm, the air service didn't answer. Try again in a minute.", "worried"); return; }
    if (state.place !== p) return;
    r.label = label;
    state.report = r;
    renderVerdict(); renderMap(); renderPollutants(); renderForecast(); renderFacts(); renderSteps();
    explain();
  }

  /* ================================================================ the verdict */
  function renderVerdict() {
    const r = state.report, v = r.verdict, aqi = r.verdict.aqi, n = r.sites[0], m = r.main_site;
    const chips = [
      `<span class="chip-k">Air</span>${aqi == null ? "No reading" : `${esc(v.air.label)} · AQI ${aqi}`}`,
      `<span class="chip-k">Industry</span>${!n ? "None within 100 km" : `${r.site_count} site${r.site_count === 1 ? "" : "s"} · closest ${n.km.toFixed(0)} km`}`,
      `<span class="chip-k">Wind</span>${!r.wind || r.wind.speed_kmh == null ? "No data" : r.wind.speed_kmh < 3 ? "Calm" : `From the ${compass(r.wind.from_deg)}, ${r.wind.speed_kmh.toFixed(0)} km/h${v.downwind ? " · toward you" : v.downwind === false && m ? " · away from you" : ""}`}`,
    ];
    $("air-verdict").innerHTML = `
      <div class="gauge" aria-label="Air quality index ${aqi ?? "unknown"}">
        <svg viewBox="0 0 200 120"><path class="g-track" d="M20 110 A80 80 0 0 1 180 110"/><path class="g-fill" id="g-fill" d="M20 110 A80 80 0 0 1 180 110"/></svg>
        <div class="g-num"><strong id="g-num">0</strong><span>US AQI</span></div>
      </div>
      <div class="verdict-text">
        <p class="chapter">${esc(r.label)}${r.point.country && !r.label.includes(r.point.country) ? ` · ${esc(r.point.country)}` : ""}</p>
        <h2 class="lvl-${v.level}">${esc(v.title)}</h2>
        <p class="lede">${esc(v.line)}</p>
        <div class="verdict-chips">${chips.map((c) => `<span class="vchip">${c}</span>`).join("")}</div>
      </div>`;
    const fill = $("g-fill"), len = fill.getTotalLength(), share = Math.min(1, (aqi || 0) / 300), num = { v: 0 };
    fill.style.stroke = aqiColor(aqi);
    fill.style.strokeDasharray = `${len} ${len}`;
    fill.style.strokeDashoffset = len;
    anime({ targets: fill, strokeDashoffset: [len, len * (1 - share)], duration: UI.reduced() ? 0 : 1400, easing: "easeOutCubic" });
    anime({ targets: num, v: aqi || 0, round: 1, duration: UI.reduced() ? 0 : 1400, easing: "easeOutCubic", update: () => { $("g-num").textContent = aqi == null ? "—" : num.v; } });
  }

  /* Flick says the one or two things that matter, in plain words, then offers the steps. */
  function explain() {
    const r = state.report, v = r.verdict, m = r.main_site, w = r.worst, lines = [];
    if (v.aqi != null) lines.push(`The air in ${esc(r.label.split(",")[0])} is <strong>${esc(v.air.label.toLowerCase())}</strong> right now.`);
    if (w && w.times >= 1.5) lines.push(`The main problem is ${esc(w.name.split(" (")[0])}, about <strong>${w.times.toFixed(0)}×</strong> the safe level.`);
    const n = r.sites[0];
    if (!n) lines.push("Good news: no gas flares or factories glow within 100 km of you.");
    else if (v.downwind) lines.push(`And watch out: the wind is blowing from a site ${m.km.toFixed(0)} km to the ${compass(m.bearing)} that glowed ${m.weeks} weeks last year, straight toward you.`);
    else if (n.km <= 30) lines.push(`The closest industrial heat is ${n.km.toFixed(0)} km to the ${compass(n.bearing)}${v.downwind === false ? ", but today the wind carries the fumes away from you" : ""}.`);
    else lines.push(`The closest industrial heat is ${n.km.toFixed(0)} km away, far enough that it matters little on most days.`);
    lines.push(`Press <strong>▶</strong> and I'll show you what to do.`);
    flick.say(lines.join(" "), v.level >= 4 || v.downwind ? "worried" : v.level <= 1 ? "happy" : "think");
  }

  /* ================================================================ map around you */
  function renderMap() {
    const r = state.report, map = getMap("air-map", [[r.point.lat, r.point.lon], 8]), group = layers["air-map"];
    group.clearLayers();
    const here = [r.point.lat, r.point.lon];
    L.circle(here, { radius: r.radius_km * 1000, color: css("--accent"), weight: 1.5, dashArray: "5 6", fill: false }).addTo(group);
    const maxGlow = d3.max(r.sites, (s) => s.glow) || 1;
    for (const s of r.sites) {
      L.circleMarker([s.lat, s.lon], { radius: 4 + 9 * Math.sqrt(s.glow / maxGlow), color: s.lit_now ? css("--hot") : "transparent", weight: s.lit_now ? 3 : 0,
        fillColor: css("--flare"), fillOpacity: 0.8 })
        .bindTooltip(`${s.km.toFixed(0)} km ${compass(s.bearing)} · glowed ${s.weeks} of 52 weeks in ${r.year}${s.lit_now ? " · glowing today" : ""}`).addTo(group);
    }
    if (r.verdict.downwind && r.main_site) {
      L.polyline([[r.main_site.lat, r.main_site.lon], here], { color: css("--hot"), weight: 2.5, dashArray: "2 7", lineCap: "round" }).addTo(group);
    }
    L.marker(here, { icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="you-pin"><span></span></div>' }), zIndexOffset: 1000 })
      .bindTooltip(esc(r.label)).addTo(group);
    if (r.wind && r.wind.from_deg != null && r.wind.speed_kmh >= 3) {
      const to = (r.wind.from_deg + 180) % 360;
      L.marker(here, { interactive: false, icon: L.divIcon({ className: "", iconSize: [90, 90], iconAnchor: [45, 45],
        html: `<div class="wind-arrow" style="transform:rotate(${to}deg)"><svg viewBox="0 0 90 90"><path d="M45 78 V22 M45 12 L34 30 H56 Z"/></svg></div>` }) }).addTo(group);
    }
    map.setView(here, r.sites.length && r.sites[0].km < 40 ? 9 : 8);
    $("air-map-sub").textContent = r.site_count ? `${r.site_count} industrial heat source${r.site_count === 1 ? "" : "s"} within ${r.radius_km} km. Bigger dots glowed more; a red ring means glowing today.` : `No industrial heat within ${r.radius_km} km.`;
  }

  /* ================================================================ pollutants and forecast */
  const POLLUTANTS = [["pm2_5", "Fine particles", "PM2.5"], ["pm10", "Dust", "PM10"], ["nitrogen_dioxide", "Nitrogen dioxide", "NO₂"],
                      ["sulphur_dioxide", "Sulphur dioxide", "SO₂"], ["ozone", "Ozone", "O₃"], ["carbon_monoxide", "Carbon monoxide", "CO"]];
  const WHO = { pm2_5: 15, pm10: 45, nitrogen_dioxide: 25, sulphur_dioxide: 40, ozone: 100, carbon_monoxide: 4000 };
  function renderPollutants() {
    const a = state.report.air;
    if (!a) { $("air-pollutants").innerHTML = `<p class="empty">No air reading for this spot right now.</p>`; return; }
    const rows = POLLUTANTS.filter(([k]) => a.current[k] != null).map(([k, name, sym]) => ({ k, name, sym, v: a.current[k], ratio: a.current[k] / WHO[k] }));
    const max = Math.max(2, d3.max(rows, (r) => r.ratio));
    $("air-pollutants").innerHTML = rows.map((r) => `<div class="pol ${r.ratio >= 1 ? "over" : ""}">
        <span class="pol-name">${r.name}<small>${r.sym}</small></span>
        <span class="pol-track"><span class="pol-fill" data-w="${Math.min(100, (100 * r.ratio) / max).toFixed(1)}" style="background:${r.ratio >= 2 ? css("--hot") : r.ratio >= 1 ? css("--mid") : css("--good")}"></span>
          <i class="pol-who" style="left:${(100 / max).toFixed(1)}%" title="WHO guideline"></i></span>
        <span class="pol-val">${r.ratio >= 1 ? `${r.ratio.toFixed(1)}×` : `${Math.round(r.ratio * 100)}%`}<small>${fmt(r.v)} µg/m³</small></span></div>`).join("")
      + `<p class="sub pol-key"><i class="pol-who inline"></i>The line is the WHO 24-hour guideline. Past it, health risks rise.</p>`;
    anime({ targets: "#air-pollutants .pol-fill", width: (el) => `${el.dataset.w}%`, delay: anime.stagger(UI.reduced() ? 0 : 80), duration: UI.reduced() ? 0 : 700, easing: "easeOutCubic" });
  }
  function renderForecast() {
    const el = $("air-forecast"), a = state.report && state.report.air;
    d3.select(el).selectAll("*").remove();
    if (!a || !a.next || a.next.length < 3) return;
    const pts = a.next.filter((h) => h.aqi != null).map((h) => ({ t: new Date(h.time), v: h.aqi }));
    const W = el.clientWidth || 420, H = 130, m = { t: 8, r: 8, b: 24, l: 34 };
    const x = d3.scaleTime().domain(d3.extent(pts, (p) => p.t)).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, Math.max(110, d3.max(pts, (p) => p.v) * 1.1)]).nice().range([H - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
    [[0, 50, "--good"], [50, 100, "--fair"], [100, 150, "--mild"], [150, 200, "--mid"], [200, 300, "--hot"]].forEach(([lo, hi, c]) => {
      if (lo < y.domain()[1]) svg.append("rect").attr("x", m.l).attr("width", W - m.l - m.r).attr("y", y(Math.min(hi, y.domain()[1]))).attr("height", y(lo) - y(Math.min(hi, y.domain()[1]))).attr("fill", css(c)).attr("opacity", 0.1);
    });
    axes(svg, x, y, W, H, m, { yfmt: d3.format("d"), xfmt: d3.timeFormat("%a %Hh"), xticks: x.ticks(4) });
    svg.append("path").datum(pts).attr("fill", "none").attr("stroke", css("--accent")).attr("stroke-width", 2.4).attr("d", d3.line().x((p) => x(p.t)).y((p) => y(p.v)).curve(d3.curveMonotoneX));
    svg.append("circle").attr("cx", x(pts[0].t)).attr("cy", y(pts[0].v)).attr("r", 4.5).attr("fill", css("--accent"));
  }

  /* ================================================================ facts */
  const FACT_ICONS = {
    gauge: '<path d="M5 17a7 7 0 1 1 14 0"/><path d="M12 17l4-5"/>', clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    lungs: '<path d="M12 4v8M12 12c-2 0-3-2-5-2-2 0-3 3-3 6s1 4 3 4 3-1 4-3M12 12c2 0 3-2 5-2 2 0 3 3 3 6s-1 4-3 4-3-1-4-3"/>',
    factory: '<path d="M3 20V10l5 3V10l5 3V6h3v14z"/><path d="M17 6c0-2 2-2 2-4"/>', wind: '<path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3"/>',
    trend: '<path d="M4 16l5-5 4 4 7-7"/><path d="M15 8h5v5"/>', flare: '<path d="M12 21v-6M9 21h6M12 15c-3 0-4-3-2-6 0 2 1 2 1 2 0-3 2-5 3-7 1 3 3 5 2 8-1 2-2 3-4 3z"/>',
    leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15"/><path d="M5 19l7-7"/>',
  };
  function renderFacts() {
    $("air-facts").innerHTML = state.report.facts.map((f) => `<article class="afact ${f.tone}">
      <span class="afact-icon"><svg viewBox="0 0 24 24">${FACT_ICONS[f.icon] || FACT_ICONS.gauge}</svg></span>
      <div><span class="afact-tag">${{ good: "Good news", bad: "Watch out", warn: "Worth knowing", info: "Why it matters" }[f.tone]}</span>
      <h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div></article>`).join("");
    anime({ targets: "#air-facts .afact", opacity: [0, 1], translateY: [12, 0], delay: anime.stagger(UI.reduced() ? 0 : 70), duration: 420, easing: "easeOutQuad" });
    $("air-source").textContent = state.report.sources + (state.report.errors.length ? ` Not available right now: ${state.report.errors.join("; ")}.` : "");
  }

  /* ================================================================ animated precautions */
  const ART = {
    open: `<rect class="a-frame" x="40" y="20" width="80" height="80" rx="4"/><rect class="a-pane slide-l" x="44" y="24" width="35" height="72"/><rect class="a-pane slide-r" x="81" y="24" width="35" height="72"/>
           <path class="a-breeze" d="M10 50 q12 -8 24 0 t24 0 M14 66 q12 -8 24 0 t24 0"/>`,
    close: `<path class="a-smog" d="M6 46 q10 -10 20 0 t20 0 M4 64 q10 -10 20 0 t20 0"/><rect class="a-frame" x="44" y="20" width="80" height="80" rx="4"/>
            <rect class="a-pane shut-l" x="48" y="24" width="36" height="72"/><rect class="a-pane shut-r" x="84" y="24" width="36" height="72"/><circle class="a-check" cx="138" cy="28" r="12"/><path class="a-tick" d="M132 28l4 4 8-8"/>`,
    outside: `<circle class="a-sun" cx="118" cy="34" r="14"/><g class="a-rays"><path d="M118 10v-6M118 64v-6M94 34h-6M148 34h-6M101 17l-4-4M139 55l-4-4M101 51l-4 4M139 13l-4 4"/></g>
              <path class="a-hill" d="M0 110 q50 -40 100 -10 t60 -10 V120 H0z"/><g class="a-walker"><circle cx="52" cy="62" r="6"/><path d="M52 68v18M52 74l-8 6M52 74l8 4M52 86l-6 12M52 86l7 12"/></g>`,
    watch: `<circle class="a-face" cx="80" cy="60" r="40"/><path class="a-hand-h" d="M80 60V38"/><path class="a-hand-m" d="M80 60h24"/><circle cx="80" cy="60" r="3"/>`,
    sensitive: `<g class="a-walker slow"><circle cx="70" cy="40" r="8"/><path d="M70 48v26M70 56l-10 8M70 56l10 6M70 74l-8 18M70 74l9 18"/></g><path class="a-pause" d="M112 40v30M126 40v30"/>`,
    "indoor-sport": `<path class="a-house" d="M24 104V54L80 18l56 36v50z"/><g class="a-walker run"><circle cx="80" cy="54" r="6"/><path d="M80 60v18M80 66l-9 4M80 66l9 -4M80 78l-8 10M80 78l9 8"/></g><path class="a-tread" d="M56 96h48"/>`,
    inhaler: `<path class="a-inhaler" d="M66 30h22v44H66z M70 74h14l4 18H66z"/><g class="a-puff"><circle cx="104" cy="84" r="5"/><circle cx="118" cy="78" r="7"/><circle cx="134" cy="72" r="9"/></g>`,
    purifier: `<rect class="a-box" x="50" y="22" width="60" height="86" rx="10"/><g class="a-fan"><circle cx="80" cy="56" r="20"/><path d="M80 36v40M60 56h40M66 42l28 28M94 42l-28 28"/></g>
               <path class="a-flow" d="M118 40 q14 6 0 12 M118 62 q14 6 0 12 M42 40 q-14 6 0 12 M42 62 q-14 6 0 12"/>`,
    mask: `<circle class="a-head" cx="80" cy="56" r="34"/><circle cx="68" cy="48" r="3"/><circle cx="92" cy="48" r="3"/><path class="a-mask" d="M54 60 q26 -10 52 0 v12 q-26 22 -52 0z"/><path class="a-strap" d="M54 64 l-10 -10 M106 64 l10 -10"/>`,
    "check-on": `<rect class="a-phone" x="62" y="18" width="40" height="84" rx="8"/><circle cx="82" cy="92" r="3"/><path class="a-ring" d="M112 40 q8 10 0 20 M122 34 q14 16 0 32 M52 40 q-8 10 0 20 M42 34 q-14 16 0 32"/>`,
    "stay-in": `<path class="a-house" d="M24 104V54L80 18l56 36v50z"/><rect class="a-door" x="68" y="70" width="24" height="34"/><path class="a-heart" d="M80 58 l-10 -10 a6 6 0 0 1 10 -6 a6 6 0 0 1 10 6z"/>`,
    "no-smoke": `<path class="a-candle" d="M74 60h12v40H74z"/><path class="a-flame" d="M80 58c-6-6-2-12 0-16 2 4 6 10 0 16z"/><path class="a-smoke" d="M80 38 q-6 -8 0 -14 t0 -14"/>
                 <circle class="a-ban" cx="80" cy="64" r="44"/><path class="a-slash" d="M49 33l62 62"/>`,
    doctor: `<path class="a-heart big" d="M80 96 L44 60 a20 20 0 0 1 36 -24 a20 20 0 0 1 36 24z"/><path class="a-ecg" d="M14 64h40l8 -16 10 32 8 -16h66"/>`,
    report: `<path class="a-factory" d="M18 104V64l18 10V64l18 10V44h12v60z"/><path class="a-flare-flame" d="M60 40c-6-6-2-14 0-18 3 6 7 10 0 18z"/><path class="a-blacksmoke" d="M60 22 q10 -10 22 -6 t20 -8"/>
             <rect class="a-phone" x="110" y="40" width="30" height="58" rx="6"/><path class="a-ring" d="M146 52 q6 8 0 16"/>`,
  };
  function renderSteps() {
    const steps = state.report.steps;
    $("step-dots").innerHTML = steps.map((s, i) => `<button aria-label="Step ${i + 1}: ${esc(s.title)}" data-i="${i}"></button>`).join("");
    $("step-dots").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { stop(); showStep(+b.dataset.i); }));
    $("air-steps-sub").textContent = `${steps.length} steps, for the air you have today.`;
    showStep(0, true);
  }
  function showStep(i, quiet) {
    const steps = state.report.steps;
    if (i < 0 || i >= steps.length) { if (i >= steps.length) stop(); return; }
    state.step = i;
    const s = steps[i];
    $("step-stage").innerHTML = `<div class="step-art play"><svg viewBox="0 0 160 120" aria-hidden="true">${ART[s.key] || ART.watch}</svg></div>
      <div class="step-copy"><span class="step-num">Step ${i + 1} of ${steps.length}</span><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>`;
    $("step-dots").querySelectorAll("button").forEach((b, k) => b.classList.toggle("on", k === i));
    $("step-prev").disabled = i === 0;
    $("step-next").disabled = i === steps.length - 1;
    anime({ targets: "#step-stage > *", opacity: [0, 1], translateX: [18, 0], delay: anime.stagger(80), duration: UI.reduced() ? 0 : 420, easing: "easeOutQuad" });
    if (!quiet) { Voice.pop(); flick.say(`<strong>${esc(s.title)}.</strong> ${esc(s.text)}`, s.key === "doctor" || s.key === "report" ? "worried" : s.key === "outside" || s.key === "open" ? "happy" : "proud"); }
  }
  function play() {
    state.playing = true;
    $("step-play").innerHTML = "&#10073;&#10073;"; $("step-play").setAttribute("aria-label", "Pause the steps");
    $("air-steps-card").scrollIntoView({ behavior: UI.reduced() ? "auto" : "smooth", block: "center" });
    showStep(state.step >= state.report.steps.length - 1 ? 0 : state.step);
    const tick = () => {
      if (!state.playing) return;
      if (state.step + 1 >= state.report.steps.length) { stop(); flick.say("That's everything. Stay safe, and check again tomorrow: air changes every day.", "happy"); return; }
      showStep(state.step + 1);
      state.timer = setTimeout(tick, 5200);
    };
    state.timer = setTimeout(tick, 5200);
  }
  function stop() {
    state.playing = false;
    clearTimeout(state.timer);
    $("step-play").innerHTML = "&#9654;"; $("step-play").setAttribute("aria-label", "Play the steps");
  }

  /* ================================================================ the bigger picture: industry worldwide */
  async function loadIndustry() {
    loadingFacts("ind-glance", ["Industrial hotspots", "Sites", "Glows most", "Today"]);
    try { state.industry = await api("/api/industry"); } catch (err) { facts("ind-glance", [{ k: "Industry", v: "Unavailable", d: err.message }]); return; }
    api("/api/live?window=24h").then((v) => { state.live = v; renderIndustry(); }).catch(() => {});
    renderIndustry();
  }
  function renderIndustry() {
    const d = state.industry;
    if (!d) return;
    const total = (d.global.find((g) => g[0] === d.year) || [0, 0])[1], top = d.ranking[0];
    facts("ind-glance", [
      { k: `Industrial hotspots in ${d.year}`, v: fmt(total), d: "hot pixels at flares, refineries and plants" },
      { k: "Sites", v: fmt(d.site_count || d.sites.length), d: `places with industrial heat in ${d.year}; the ${fmt(d.sites.length)} brightest are on the map` },
      { k: "Glows most", v: top ? top[0] : "—", accent: !!top, d: top ? `${fmt(top[1])} hotspots in ${d.year}` : "" },
      { k: "Today", v: state.live ? fmt(state.live.industrial) : "…", d: "seen at known sites in the last day" },
    ]);
    getMap("ind-map", [[26, 40], 2]);
    const group = layers["ind-map"], maxN = d3.max(d.sites, (s) => s[2]) || 1;
    group.clearLayers();
    for (const [lat, lon, n, weeks, country] of d.sites) {
      L.circleMarker([lat, lon], { radius: 2 + 7 * Math.sqrt(n / maxN), stroke: false, fillColor: css("--flare"), fillOpacity: 0.75 })
        .bindTooltip(`${country && country !== "?" ? country + " · " : ""}${fmt(n)} hot pixels in ${d.year}, glowing in ${weeks} weeks. Tap to check the air here.`)
        .on("click", () => { pick({ name: `Near a site in ${country && country !== "?" ? country : "this area"}`, lat, lon }); scrollTo({ top: 0, behavior: "smooth" }); })
        .addTo(group);
    }
    bars("ind-ranking", d.ranking.map(([c, n]) => ({ name: c, value: n, on: c === state.indCountry })), { color: "flare", onClick: (r) => { state.indCountry = r.name; renderIndustry(); } });
    trend();
  }
  function trend() {
    const d = state.industry, el = $("ind-trend"), series = state.indCountry ? d.series[state.indCountry] : d.global;
    $("ind-trend-title").textContent = state.indCountry ? `${state.indCountry} over the years` : "The whole world over the years";
    d3.select(el).selectAll("*").remove();
    if (!series || series.length < 2) { d3.select(el).append("p").attr("class", "empty").text("Not enough years to draw a trend."); return; }
    const W = el.clientWidth || 480, H = 220, m = { t: 10, r: 10, b: 26, l: 44 };
    const x = d3.scaleLinear().domain(d3.extent(series, (s) => s[0])).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, d3.max(series, (s) => s[1]) * 1.1]).nice().range([H - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
    axes(svg, x, y, W, H, m, { xfmt: d3.format("d"), xticks: series.map((s) => s[0]).filter((v, i) => i % 3 === 0) });
    svg.append("path").datum(series).attr("fill", "none").attr("stroke", css("--flare")).attr("stroke-width", 2.6).attr("d", d3.line().x((s) => x(s[0])).y((s) => y(s[1])).curve(d3.curveMonotoneX));
    svg.selectAll("circle").data(series).join("circle").attr("cx", (s) => x(s[0])).attr("cy", (s) => y(s[1])).attr("r", 3.5).attr("fill", css("--flare"));
  }

  /* ================================================================ router hook */
  async function show(sub) {
    if (!state.mounted) mount();
    UI.refreshMaps();
    const m = sub && decodeURIComponent(sub).match(/^(-?[\d.]+),(-?[\d.]+)(?:,(.*))?$/);
    if (m && (!state.place || Math.abs(state.place.lat - +m[1]) > 1e-3 || Math.abs(state.place.lon - +m[2]) > 1e-3)) {
      pick({ name: m[3] || "This spot", lat: +m[1], lon: +m[2] });
    }
  }

  const tour = [
    { at: ".air-search", mood: "happy", say: "Type where you live, or let your browser share your location. Nothing is stored." },
    { at: "#air-presets", mood: "wink", say: "No idea where to start? <strong>Basra</strong> and <strong>Port Harcourt</strong> sit next to some of the world's biggest gas flares." },
    { at: "#ind-map-card", mood: "think", say: "Down here is every factory and flare that glowed in 2025. Tap any dot and I'll check the air around it." },
  ];

  return { show, pick, tour };
})();
window.Air = Air;
