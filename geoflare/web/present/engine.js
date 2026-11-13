/* GeoFlare, the live story: the stage engine.
   A scene is { id, name, who, dark, enter(s), beats: [fn(s), ...] }. enter() draws the scene and plays its opening;
   each press of Space / → / the clicker plays the next beat, so the animation always waits for the speaker.
   Going back rebuilds the scene and replays its beats instantly (P.instant), which keeps every beat a plain forward function. */
"use strict";
const W = 1600, H = 1000;
const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const P = { instant: false, calm: false, voice: true };
const SCENES = [];
/* Opened straight from a folder (the flash-drive copy), data.js supplies everything the server would: window.SNAPSHOT.
   ROOT is where the stage's own files are: beside the page in the folder copy, under /present/ on the server. */
const SNAP = window.SNAPSHOT || null, ROOT = SNAP ? "" : "/present/";
/* Mode.replay is the date of the saved data when the stage is not live: the folder copy, or the flash-drive server replaying saved answers. */
const Mode = { replay: SNAP ? SNAP.savedOn || "earlier" : null };

/* A tween that jumps straight to its end when a scene is being rebuilt. */
function tw(o) { return anime(P.instant ? { ...o, duration: 0, delay: 0, endDelay: 0 } : o); }
/* A number that counts up into an element. */
function countTo(el, to, { from = 0, dur = 1400, text = fmt } = {}) {
  const o = { v: from };
  tw({ targets: o, v: to, duration: dur, easing: "easeOutExpo", update: () => { el.textContent = text(o.v); }, complete: () => { el.textContent = text(to); } });
  if (P.instant) el.textContent = text(to);
}

/* ---------------------------------------------------------------- data: fetched once, with a saved copy for a dead network */
const Data = { saved: {}, waiters: [], pending: {} };
function loadData(key, url, trim = (d) => d, timeout = 25000) {
  if (SNAP) { if (SNAP[key]) { Data[key] = SNAP[key]; Data.saved[key] = true; } return (Data.pending[key] = Promise.resolve()); }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
  return (Data.pending[key] = fetch(url, { signal: ctl.signal }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((d) => {
    Data[key] = trim(d);
    try { localStorage.setItem("present:" + key, JSON.stringify(Data[key])); } catch (e) { /* storage full or blocked: the live copy is enough */ }
  }).catch(() => {
    try { const c = localStorage.getItem("present:" + key); if (c) { Data[key] = JSON.parse(c); Data.saved[key] = true; } } catch (e) { /* no saved copy */ }
  }).finally(() => {
    clearTimeout(timer);
    Data.waiters = Data.waiters.filter((w) => { if (w.key !== key || !Data[key]) return w.key !== key; w.fn(Data[key]); return false; });
  }));
}
function bootData() {
  if (!SNAP) fetch("/health").then((r) => r.json()).then((d) => { if (d.status === "saved") Mode.replay = d.saved_on || "earlier"; }).catch(() => {});
  loadData("land", "/vendor/land-110m.json", (t) => topojson.feature(t, t.objects.land));
  loadData("live", "/api/live?window=24h", (d) => ({ fires: d.fires, severe: d.severe, satellite: d.satellite, newest: d.newest, globe: d.globe.filter((g) => !g[3]).map((g) => g.slice(0, 3)) }));
  loadData("intro", "/api/intro", (d) => ({ annual: d.annual, jump: d.jump, viirs_start: d.viirs_start, ratio: d.global_ratio, years_tested: d.validation.length }));
  loadData("severity", "/api/live/severity", (d) => ({ scored: d.scored, auc: d.auc, caught: d.severe_caught, points: d.points.map((p) => p.slice(0, 3)), watch: d.watchlist }), 120000);
  loadData("egypt", "/api/calendar?country=Egypt", (d) => ({ years: d.years, values: d.calendar.values, season: d.season, trend: d.trends.harmonized, unusual: d.unusual_months.slice(0, 3), annual: d.annual.harmonized }));
  loadData("model", "/geodata/api/v1/model", (d) => ({ auc: d.metrics.roc_auc, recall: d.metrics.at_decision_threshold.recall, levels: d.metrics.risk.levels_on_test }));
  loadData("meta", "/api/meta", (d) => ({ coverage: d.band_coverage.month }));
  loadData("industry", "/api/industry", (d) => ({ count: d.site_count, sites: d.sites.map((x) => x.slice(0, 2)) }));
  loadData("findings", "/api/findings", (d) => ({ season: d.rhythm.weekly_correlation, fw: d.rhythm.fires_by_week, iw: d.rhythm.industry_by_week, near: d.proximity.median_ratio,
    countries: d.proximity.countries_compared, trend: d.trends.world_change_correlation, wf: d.trends.world_fires, wi: d.trends.world_industry }));
}

/* ---------------------------------------------------------------- sparks: one canvas for every particle on the stage */
const FX = (() => {
  const ctx = $("#fx").getContext("2d");
  let parts = [], running = false, last = 0;
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = $("#stage").classList.contains("dark") ? "lighter" : "source-over";
    parts = parts.filter((p) => (p.life -= dt) > 0);
    for (const p of parts) {
      p.vy += (p.g || 0) * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= p.drag; p.vy *= p.drag;
      const a = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = `rgba(${p.c},${a * p.a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + 0.6 * a), 0, 6.283); ctx.fill();
    }
    if (parts.length) requestAnimationFrame(frame); else { running = false; ctx.clearRect(0, 0, W, H); }
  }
  function add(p) { if (P.instant) return; parts.push(p); if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } }
  return {
    burst(x, y, n = 60, { speed = 420, life = 0.9, r = 3.2, g = 260, c = "255,138,61" } = {}) {
      if (P.calm) n = Math.ceil(n / 3);
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * 6.283, v = speed * (0.25 + Math.random() * 0.75), l = life * (0.6 + Math.random() * 0.7);
        add({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: l, max: l, r: r * (0.5 + Math.random()), g, drag: 0.985, c: Math.random() < 0.3 ? "255,214,150" : c, a: 0.95 });
      }
    },
    trail(x, y) {
      if (P.calm && Math.random() < 0.6) return;
      const l = 0.45 + Math.random() * 0.3;
      add({ x: x + (Math.random() - 0.5) * 26, y: y + (Math.random() - 0.5) * 26, vx: (Math.random() - 0.5) * 40, vy: 30 + Math.random() * 50, life: l, max: l, r: 2 + Math.random() * 2.6, g: 60, drag: 0.98, c: "255,150,70", a: 0.8 });
    },
    clear() { parts = []; },
  };
})();

/* ---------------------------------------------------------------- Flick's spoken voice
   The browser's own speech engine, pitched up so he sounds small and bright. It prefers a natural child or young voice when the
   browser offers one (those need the internet) and falls back to a voice installed on the laptop, which works offline. */
const Talk = (() => {
  const synth = window.speechSynthesis;
  const WANT = [/\bAna\b.*Natural/i, /(Jenny|Aria|Michelle|Sonia|Libby|Maisie).*Natural/i, /Natural/i, /Zira|Samantha|Google US English|Female/i];
  let voice = null, local = null;
  function pick() {
    const all = synth.getVoices().filter((v) => /^en/i.test(v.lang));
    local = all.find((v) => v.localService && /Zira|Samantha|Female/i.test(v.name)) || all.find((v) => v.localService) || null;
    voice = WANT.map((re) => all.find((v) => re.test(v.name))).find(Boolean) || local || all[0] || null;
  }
  if (synth) { pick(); synth.addEventListener("voiceschanged", pick); }
  const FEEL = { happy: [0, 1.04], laugh: [0.12, 1.1], wow: [0.15, 1.1], wink: [0.05, 1.05], proud: [0.04, 1.02], think: [-0.1, 0.96], worried: [-0.06, 1.0] };
  const clips = {};                                                // line -> a recorded clip, made ahead of time (see audio/README.txt)
  let playing = null;
  (SNAP ? Promise.resolve(SNAP.lines || {}) : fetch("/present/audio/lines.json").then((r) => (r.ok ? r.json() : {}))).then((m) => { for (const [line, file] of Object.entries(m)) { const a = new Audio(ROOT + "audio/" + file); a.preload = "auto"; clips[line] = a; } }).catch(() => {});
  function say(text, mood = "happy", with_ = voice) {
    if (playing) { playing.pause(); playing = null; }
    if (clips[text]) { playing = clips[text]; playing.currentTime = 0; playing.play().catch(() => {}); return true; }
    if (!synth || !with_) return false;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/×/g, " times").replace(/·/g, ","));
    const [lift, rate] = FEEL[mood] || FEEL.happy, natural = /Natural/i.test(with_.name);
    u.voice = with_; u.lang = with_.lang; u.volume = 1; u.rate = rate;
    u.pitch = (natural ? 1.35 : 1.75) + lift;                        // installed voices are deeper, so they are lifted further
    u.onerror = (e) => { if (with_ !== local && local && e.error !== "interrupted" && e.error !== "canceled") say(text, mood, local); };   // no internet: use the installed voice
    synth.speak(u);
    return true;
  }
  return { say, stop() { if (playing) { playing.pause(); playing = null; } if (synth) synth.cancel(); }, get voice() { return voice ? voice.name : null; }, get clips() { return Object.keys(clips).length; } };
})();

/* ---------------------------------------------------------------- Flick: one on stage, always. He flies in arcs, leaves sparks, talks, and holds up name cards. */
const F = (() => {
  const node = $("#flick"), bubble = $("#bubble"), badge = $("#badge");
  node.innerHTML = Flick.svg(200, "happy");
  const face = node.querySelector("svg");
  const st = { x: 800, y: 500, s: 1, rot: 0, sx: 1, sy: 1, shown: false };
  let move = null, typing = null, badgeTimer = null;
  const paint = () => { node.style.transform = `translate(${st.x - 100}px,${st.y - 150}px) rotate(${st.rot}deg) scale(${st.s * st.sx},${st.s * st.sy})`; };
  const follow = () => {                                           // the bubble sits beside him, on whichever side has room
    const right = st.x < W * 0.56, bw = bubble.offsetWidth || 300, bh = bubble.offsetHeight || 80;
    const bx = right ? st.x + 86 * st.s : st.x - 86 * st.s - bw, by = clamp(st.y - 60 * st.s - bh / 2, 20, H - bh - 20);
    bubble.style.transform = `translate(${clamp(bx, 20, W - bw - 20)}px,${by}px)`;
    badge.style.transform = `translate(${clamp(st.x - badge.offsetWidth / 2, 10, W - badge.offsetWidth - 10)}px,${st.y - 175 * st.s - 30}px)`;
  };
  function show() { if (st.shown) return; st.shown = true; paint(); tw({ targets: node, opacity: 1, duration: 300, easing: "linear" }); }
  function stop() { if (move) { move.pause(); move = null; } }
  function land() {
    if (P.instant) { st.sx = st.sy = 1; st.rot = 0; paint(); return; }
    const o = { k: 0 };
    anime({ targets: o, k: 1, duration: 420, easing: "easeOutElastic(1, .55)", update: () => { st.sy = 0.86 + 0.14 * o.k; st.sx = 1.12 - 0.12 * o.k; st.rot *= 0.7; paint(); }, complete: () => { st.sx = st.sy = 1; st.rot = 0; paint(); } });
  }
  return {
    st,
    mood(m) { face.dataset.mood = m; },
    hide() { stop(); st.shown = false; tw({ targets: node, opacity: 0, duration: 250, easing: "linear" }); this.hush(); },
    place(x, y, { s = 1, mood } = {}) { stop(); Object.assign(st, { x, y, s, rot: 0, sx: 1, sy: 1 }); if (mood) this.mood(mood); paint(); show(); follow(); },
    /* Fly to a point along an arc. `arc` is how high the curve bows (negative bows downward). */
    to(x, y, { s = 1, mood, dur = 900, arc = 140, trail = true, done } = {}) {   // size returns to normal unless a scene asks otherwise
      stop(); show(); if (mood) this.mood(mood);
      if (P.instant) { this.place(x, y, { s }); if (done) done(); return; }
      const x0 = st.x, y0 = st.y, s0 = st.s, cx = (x0 + x) / 2, cy = Math.min(y0, y) - arc, o = { t: 0 };
      let px = x0;
      move = anime({ targets: o, t: 1, duration: dur, easing: "easeInOutCubic",
        update: () => {
          const t = o.t, u = 1 - t;
          st.x = u * u * x0 + 2 * u * t * cx + t * t * x; st.y = u * u * y0 + 2 * u * t * cy + t * t * y; st.s = s0 + (s - s0) * t;
          const vx = st.x - px; px = st.x;
          st.rot = clamp(vx * 1.4, -16, 16); st.sy = 1 + Math.min(0.12, Math.abs(vx) * 0.006); st.sx = 2 - st.sy;
          paint(); follow(); if (trail) FX.trail(st.x, st.y + 40 * st.s);
        },
        complete: () => { move = null; land(); follow(); if (done) done(); } });
    },
    /* One lap around a centre, on a tilted ring, then carry on. */
    orbit(cx, cy, rx, ry, { dur = 2200, s = 0.8, from = Math.PI, done } = {}) {
      stop(); show();
      if (P.instant) { if (done) done(); return; }
      const o = { a: 0 };
      move = anime({ targets: o, a: 1, duration: dur, easing: "easeInOutSine",
        update: () => { const ang = from + o.a * Math.PI * 2; st.x = cx + Math.cos(ang) * rx; st.y = cy + Math.sin(ang) * ry; st.s = s * (0.8 + 0.25 * (Math.sin(ang) + 1) / 2); st.rot = Math.cos(ang) * -10; paint(); FX.trail(st.x, st.y + 30); },
        complete: () => { move = null; st.rot = 0; if (done) done(); } });
    },
    hop() {
      if (P.instant) return;
      const y0 = st.y, o = { k: 0 };
      anime({ targets: o, k: 1, duration: 460, easing: "linear", update: () => { st.y = y0 - Math.sin(o.k * Math.PI) * 34; st.sy = 1 + Math.sin(o.k * Math.PI) * 0.08; st.sx = 2 - st.sy; paint(); follow(); }, complete: () => { st.y = y0; land(); } });
    },
    spin() { if (P.instant) return; const o = { k: 0 }; anime({ targets: o, k: 1, duration: 700, easing: "easeInOutQuad", update: () => { st.sx = Math.cos(o.k * Math.PI * 2); paint(); }, complete: () => { st.sx = 1; paint(); } }); },
    bow() { if (P.instant) return; const o = { k: 0 }; anime({ targets: o, k: 1, duration: 1100, easing: "easeInOutSine", update: () => { st.rot = Math.sin(o.k * Math.PI) * 24; paint(); }, complete: () => { st.rot = 0; paint(); } }); },
    say(text, mood) {
      if (mood) this.mood(mood);
      clearInterval(typing); anime.remove(bubble);                  // a fade-out still running from the last scene must not hide the new line
      const span = bubble.querySelector("span");
      if (P.instant) { span.textContent = text; bubble.style.opacity = 1; follow(); return; }
      span.textContent = text; follow(); span.textContent = "";       // measure the full line first so the bubble doesn't jump while typing
      tw({ targets: bubble, opacity: 1, duration: 220, easing: "linear" });
      const spoken = P.voice && Talk.say(text, face.dataset.mood);   // if the browser has no speech voice at all, the blips below stand in
      let i = 0;
      typing = setInterval(() => {
        span.textContent = text.slice(0, ++i);
        if (P.voice && !spoken && i % 2 === 0) Voice.blip(text[i - 1] || "", face.dataset.mood);
        if (i >= text.length) clearInterval(typing);
      }, 24);
    },
    hush() { clearInterval(typing); Talk.stop(); anime.remove(bubble); tw({ targets: bubble, opacity: 0, duration: 200, easing: "linear" }); },
    /* The handover: Flick holds up the next speaker's name for a moment. */
    card(name) {
      clearTimeout(badgeTimer);
      badge.innerHTML = `<small>Next up</small>${name}`; follow();
      if (P.instant) { badge.style.opacity = 0; return; }
      anime({ targets: badge, opacity: [0, 1], scale: [0.6, 1], duration: 500, easing: "easeOutBack" });
      badgeTimer = setTimeout(() => anime({ targets: badge, opacity: 0, duration: 400, easing: "linear" }), 2600);
    },
    follow,
  };
})();

/* ---------------------------------------------------------------- spotlight */
const Spot = {
  on: true, aimed: false,                                           // on = the presenter allows it; aimed = a scene is pointing at something
  at(x, y, w, h, r = 20) { const s = $("#spot").style; s.left = x + "px"; s.top = y + "px"; s.width = w + "px"; s.height = h + "px"; s.borderRadius = r + "px"; this.aimed = true; s.opacity = this.on ? 1 : 0; },
  off() { this.aimed = false; $("#spot").style.opacity = 0; },
  allow(on) { this.on = on; $("#spot").style.opacity = on && this.aimed ? 1 : 0; },   // switched off, the page underneath is clear and usable
};

/* ---------------------------------------------------------------- the night globe (the story's own look), drawn on a canvas */
function makeGlobe(canvas, R) {
  const ctx = canvas.getContext("2d"), cx = canvas.width / 2, cy = canvas.height / 2;
  const proj = d3.geoOrthographic().clipAngle(90).precision(0.5).scale(R).translate([cx, cy]), path = d3.geoPath(proj, ctx), grat = d3.geoGraticule10();
  const g = { rot: [-20, -8], fires: 1, draw() {
    proj.rotate(g.rot);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const halo = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.25);
    halo.addColorStop(0, "rgba(255,140,60,0.16)"); halo.addColorStop(1, "rgba(255,140,60,0)");
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, 6.283); ctx.fill();
    ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = "#0e1217"; ctx.fill();
    ctx.beginPath(); path(grat); ctx.strokeStyle = "rgba(245,239,230,0.05)"; ctx.lineWidth = 0.6; ctx.stroke();
    if (Data.land) { ctx.beginPath(); path(Data.land); ctx.fillStyle = "#171d24"; ctx.fill(); ctx.strokeStyle = "rgba(245,239,230,0.16)"; ctx.lineWidth = 0.6; ctx.stroke(); }
    ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = "rgba(245,239,230,0.14)"; ctx.lineWidth = 1; ctx.stroke();
    const centre = [-g.rot[0], -g.rot[1]], k = R / 420;
    ctx.globalCompositeOperation = "lighter";
    if (Data.live && g.fires > 0.01) for (const [lat, lon, n] of Data.live.globe) {
      if (d3.geoDistance([lon, lat], centre) > 1.5) continue;
      const [x, y] = proj([lon, lat]), r = Math.min(7, 0.8 + Math.sqrt(n) * 0.35) * k;
      ctx.fillStyle = `rgba(255,120,40,${0.5 * g.fires})`; ctx.beginPath(); ctx.arc(x, y, r * 1.9, 0, 6.283); ctx.fill();
      ctx.fillStyle = `rgba(255,240,200,${0.8 * g.fires})`; ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, 6.283); ctx.fill();
    }
    if (g.after) g.after(ctx, proj, centre, k);
    ctx.globalCompositeOperation = "source-over";
  } };
  return g;
}

/* ---------------------------------------------------------------- the show */
const Show = (() => {
  const stage = $("#stage"), layer = $("#scene"), chan = "BroadcastChannel" in window ? new BroadcastChannel("geoflare-present") : null;
  let i = 0, b = 0, cur = null, t0 = null, lastWho = null;
  const visible = () => SCENES.filter((s) => !s.hidden);
  function fit() { stage.style.transform = `translate(-50%,-50%) scale(${Math.min(innerWidth / W, innerHeight / H)})`; }

  function context(scene, root) {
    const timers = [], loops = [];
    const s = { scene, root, alive: true,
      add(html) { const e = h(html); root.appendChild(e); return e; },
      later(ms, fn) { if (P.instant) { fn(); return; } timers.push(setTimeout(() => { if (s.alive) fn(); }, ms)); },
      loop(fn) { let last = performance.now(); const tick = (t) => { if (!s.alive) return; fn(t, Math.min(0.05, (t - last) / 1000)); last = t; loops.push(requestAnimationFrame(tick)); }; loops.push(requestAnimationFrame(tick)); },
      need(key, fn) { if (Data[key]) fn(Data[key]); else Data.waiters.push({ key, fn: (d) => { if (s.alive) fn(d); } }); },
      kill() { s.alive = false; timers.forEach(clearTimeout); loops.forEach(cancelAnimationFrame); } };
    return s;
  }
  function hud() {
    const scene = SCENES[i], list = visible(), n = list.indexOf(scene);
    $("#hud").style.opacity = scene.id === "spark" ? 0 : 1;
    $("#hud-label b").textContent = n >= 0 ? String(n).padStart(2, "0") : "";
    $("#hud-label span").textContent = scene.name;
    $("#hud-who").textContent = scene.who || ""; $("#hud-who").style.display = scene.who ? "" : "none";
    $("#hud-dots").innerHTML = list.slice(1).map((s) => `<i class="${s === scene ? "on" : ""}"></i>`).join("");
  }
  function tell() { if (chan) chan.postMessage({ scene: SCENES[i].id, beat: b, started: t0 }); }

  /* Show scene n with its first `beats` presses already played. instant = no animation (used for back and jumps into the middle). */
  function go(n, beats = 0, instant = false) {
    n = clamp(n, 0, SCENES.length - 1);
    const scene = SCENES[n], old = cur;
    if (old) { old.kill(); const dead = old.root; if (old.scene.leave) old.scene.leave(old); anime({ targets: dead, opacity: 0, duration: 350, easing: "linear", complete: () => dead.remove() }); }
    Spot.off(); F.hush();
    i = n; b = 0;
    stage.classList.toggle("dark", !!scene.dark);
    const root = h('<div class="sc"></div>'); layer.appendChild(root);
    cur = context(scene, root);
    if (!t0 && n > 0) t0 = Date.now();
    const handover = scene.who && lastWho && scene.who !== lastWho && !instant; lastWho = scene.who || lastWho;
    P.instant = instant;
    if (!instant) anime({ targets: root, opacity: [0, 1], duration: 500, easing: "linear" });
    scene.enter(cur);
    while (b < beats && b < scene.beats.length) { P.instant = true; scene.beats[b++](cur); }
    P.instant = false;
    if (handover) cur.later(500, () => F.card(scene.who));
    hud(); tell();
  }
  const step = (dir) => { const list = visible(), k = list.indexOf(SCENES[i]); return k < 0 ? SCENES.indexOf(list.find((s) => SCENES.indexOf(s) > i) || list[list.length - 1]) : SCENES.indexOf(list[clamp(k + dir, 0, list.length - 1)]); };
  function next() {
    const scene = SCENES[i];
    if (b < scene.beats.length) { scene.beats[b++](cur); tell(); return; }
    const n = scene.then !== undefined ? SCENES.findIndex((s) => s.id === scene.then) : step(1);
    if (n !== i) go(n);
  }
  function back() {
    if (b > 0) { go(i, b - 1, true); return; }
    const n = step(-1); if (n !== i) go(n, SCENES[n].beats.length, true);
  }
  function key(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key, at = e.target;
    if (at && (at.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName)) && k !== "PageDown" && k !== "PageUp") return;
    if ([" ", "ArrowRight", "PageDown", "Enter"].includes(k)) { e.preventDefault(); next(); }
    else if (["ArrowLeft", "PageUp", "Backspace"].includes(k)) { e.preventDefault(); back(); }
    else if (/^[0-9]$/.test(k)) { const list = visible(); go(SCENES.indexOf(list[clamp(k === "0" ? 10 : +k, 0, list.length - 1)]), 0, false); }
    else if (k === "Home") go(0);
    else if (k === "End") go(SCENES.indexOf(visible()[visible().length - 1]));
    else if (k === "n" || k === "N") window.open(ROOT + "notes.html", "geoflare-notes", "width=760,height=900");
    else if (k === "m" || k === "M") setVoice(!P.voice);
    else if (k === "l" || k === "L") setSpot(!Spot.on);
    else if (k === "b" || k === "B") { const s = $("#black").style; s.opacity = s.opacity === "1" ? 0 : 1; }
    else if (k === "c" || k === "C") { P.calm = !P.calm; F.say(P.calm ? "Calm mode: fewer sparks." : "Full sparks."); }
    else if (k === "f" || k === "F") { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    else if (k === "d" || k === "D") { const n = SCENES.findIndex((s) => s.id === "dashboard"); if (n >= 0) go(n); }
    else if (k === "?" || k === "h" || k === "H") { const s = $("#help").style; s.opacity = s.opacity === "1" ? 0 : 1; }
  }
  function setVoice(on) {
    P.voice = on; if (!on) Talk.stop(); if (Voice.muted === on) Voice.toggle();
    $("#voice").setAttribute("aria-pressed", on); $("#voice").title = on ? "Flick's voice is on (M)" : "Flick's voice is off (M)";
    F.say(on ? "My voice is on!" : "I'll stay quiet.");
  }
  function setSpot(on) {
    Spot.allow(on);
    $("#dim").setAttribute("aria-pressed", on); $("#dim").title = on ? "Highlight and darkening are on (L)" : "Highlight and darkening are off (L)";
  }
  function start() {
    try { localStorage.setItem("geoflare-guide-off", "1"); } catch (e) { /* the app's own tours would cover the live demo */ }
    fit(); addEventListener("resize", fit); addEventListener("keydown", key);
    stage.addEventListener("click", (e) => { if (!e.target.closest("iframe, a, button")) next(); });
    $("#voice").addEventListener("click", () => setVoice(!P.voice));
    $("#dim").addEventListener("click", () => setSpot(!Spot.on));
    if (chan) chan.onmessage = (e) => { if (e.data === "hello") tell(); };
    bootData();
    const want = SCENES.findIndex((s) => s.id === location.hash.slice(1));
    go(want > 0 ? want : 0, 0, want > 0);
    $("#help").style.opacity = 1; setTimeout(() => { $("#help").style.opacity = 0; }, 6000);
  }
  return { start, next, back, go, key, get state() { return { scene: SCENES[i].id, beat: b, beats: SCENES[i].beats.length }; } };
})();
