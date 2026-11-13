/* GeoFlare, the live story: the scenes, in speaking order. Coordinates are in the 1600 x 1000 stage. */
"use strict";
const EMBER = "#FF8A3D", GREY = "#8E8E93";

/* The yearly hotspot chart (scene: the problem, and again in harmonization). Returns handles to animate. */
function yearChart(s, x, y, w, hgt) {
  const svg = s.add(`<svg width="${w}" height="${hgt}" style="left:${x}px;top:${y}px;overflow:visible"></svg>`);
  const c = { svg, bars: [], ready: false, jumpX: 0, jumpTop: 0, jumpBase: 0 };
  s.need("intro", (d) => {
    const A = d.annual, n = A.years.length, m = { l: 70, r: 10, t: 20, b: 44 }, iw = w - m.l - m.r, ih = hgt - m.t - m.b;
    const X = d3.scaleBand().domain(A.years).range([0, iw]).padding(0.22), Y = d3.scaleLinear().domain([0, d3.max([...A.naive, ...A.hi]) * 1.04]).range([ih, 0]);
    const g = d3.select(svg).append("g").attr("transform", `translate(${m.l},${m.t})`);
    Y.ticks(5).forEach((t) => {
      g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", Y(t)).attr("y2", Y(t)).attr("stroke", "#2A303B").attr("stroke-width", 1);
      g.append("text").attr("x", -12).attr("y", Y(t) + 5).attr("text-anchor", "end").attr("fill", "#8E8E93").attr("font-size", 15).text(t ? `${t / 1e6}M` : "0");
    });
    A.years.forEach((yr, i) => {
      if (i % 4 === 0 || yr === d.viirs_start) g.append("text").attr("x", X(yr) + X.bandwidth() / 2).attr("y", ih + 28).attr("text-anchor", "middle").attr("fill", yr === d.viirs_start ? EMBER : "#8E8E93").attr("font-size", 15).attr("font-weight", yr === d.viirs_start ? 700 : 400).text(yr);
      const early = yr < d.viirs_start;
      const whisk = g.append("line").attr("x1", X(yr) + X.bandwidth() / 2).attr("x2", X(yr) + X.bandwidth() / 2).attr("y1", Y(A.hi[i])).attr("y2", Y(A.lo[i])).attr("stroke", "#F5EFE6").attr("stroke-width", 2).attr("stroke-linecap", "round").attr("opacity", 0);
      const bar = g.append("rect").attr("x", X(yr)).attr("width", X.bandwidth()).attr("rx", 5).attr("y", ih).attr("height", 0).attr("fill", early ? GREY : EMBER);
      c.bars.push({ node: bar.node(), whisk: whisk.node(), early, y: Y(A.naive[i]), hy: Y(A.harmonized[i]), base: ih });
    });
    const line = d3.line().x((v, i) => X(A.years[i]) + X.bandwidth() / 2).y((v) => Y(v)).curve(d3.curveMonotoneX);
    c.line = g.append("path").attr("d", line(A.harmonized)).attr("fill", "none").attr("stroke", "#F5EFE6").attr("stroke-width", 4).attr("stroke-linecap", "round").attr("opacity", 0).node();
    const k = A.years.indexOf(d.viirs_start);
    c.jumpX = x + m.l + X(d.viirs_start); c.jumpTop = y + m.t + Y(A.naive[k]); c.jumpBase = y + m.t + Y(A.naive[k - 1]); c.first = k; c.ratio = d.jump;
    c.ready = true; if (c.onready) c.onready();
  });
  c.grow = (step, onJump) => {
    const run = () => c.bars.forEach((b, i) => {
      tw({ targets: b.node, y: [b.base, b.y], height: [0, b.base - b.y], duration: 520, delay: i * step, easing: "easeOutCubic" });
      if (i === c.first && onJump) s.later(i * step + 260, onJump);
    });
    if (c.ready) run(); else c.onready = run;
  };
  c.lift = () => {                                                   // the early years, rebuilt in VIIRS units, each with its range
    c.bars.filter((b) => b.early).forEach((b, i) => {
      tw({ targets: b.node, y: b.hy, height: b.base - b.hy, fill: "#D98A4E", duration: 900, delay: i * 110, easing: "easeOutBack" });
      tw({ targets: b.whisk, opacity: 0.45, duration: 400, delay: 500 + i * 110, easing: "linear" });
    });
    const len = c.line.getTotalLength();
    c.line.style.strokeDasharray = len; c.line.style.strokeDashoffset = len;
    tw({ targets: c.line, opacity: 1, strokeDashoffset: [len, 0], duration: 1800, delay: 900, easing: "easeInOutSine" });
  };
  return c;
}

/* The real app, running inside the stage. The highlight is re-measured every frame, so it stays on its target while the app moves or grows. */
function appWindow(s, { x, y, w, src, title = "GeoFlare" }) {
  const K = w / 1625, hgt = Math.round(912 * K);
  const win = s.add(`<div class="win" style="left:${x}px;top:${y}px;width:${w}px;height:${hgt + 34}px"><div class="bar"><i></i><i></i><i></i><span>${title}</span></div></div>`);
  const frame = h(`<iframe src="${src}" width="1625" height="912" style="transform:scale(${K});transform-origin:0 0" title="${title}"></iframe>`);
  win.appendChild(frame);
  frame.addEventListener("load", () => { try { frame.contentWindow.addEventListener("keydown", Show.key); } catch (e) { /* same server, so this never fails */ } });
  const app = { win, frame, target: null, radius: 24, K,
    doc: () => frame.contentDocument,
    at: (el) => { const r = el.getBoundingClientRect(); return [x + (r.left + r.width / 2) * K, y + 34 + (r.top + r.height / 2) * K]; },
    find(sel, then, { tries = 80, up = null, ready = null } = {}) {            // wait for something inside the app
      const doc = frame.contentDocument, hit = doc && doc.querySelector(sel), el = hit && up ? hit.closest(up) : hit;
      if (el && el.getBoundingClientRect().width > 0 && (!ready || ready(el))) then(el);
      else if (tries > 0 && s.alive) setTimeout(() => app.find(sel, then, { tries: tries - 1, up, ready }), 250);
    },
    track(el, radius = 24) { app.target = el; app.radius = radius; },
    untrack() { app.target = null; Spot.off(); } };
  s.loop(() => {
    const el = app.target; if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    const x0 = Math.max(x, x + r.left * K - 8), y0 = Math.max(y + 34, y + 34 + r.top * K - 8), x1 = Math.min(x + w, x + r.right * K + 8), y1 = Math.min(y + 34 + hgt, y + 34 + r.bottom * K + 8);
    if (x1 - x0 > 20 && y1 - y0 > 20) Spot.at(x0, y0, x1 - x0, y1 - y0, app.radius);
  });
  return app;
}

/* ================================================================ 00 the spark */
SCENES.push({ id: "spark", name: "", dark: true, beats: [],
  enter(s) {
    F.hide();
    s.add('<div class="ember" style="left:787px;top:487px"></div>');
    s.add('<div class="p-sub" style="left:500px;top:590px;width:600px;text-align:center;font-size:20px;opacity:.7">Press Space to begin</div>');
  } });

/* ================================================================ 01 GeoFlare */
SCENES.push({ id: "title", name: "GeoFlare", who: "Beshoy Kamal", dark: true, beats: [],
  enter(s) {
    const cv = s.add('<canvas width="800" height="800" style="left:790px;top:90px;opacity:0"></canvas>'), globe = makeGlobe(cv, 330);
    globe.fires = 0;
    tw({ targets: cv, opacity: 1, duration: 1600, delay: 300, easing: "linear" });
    tw({ targets: globe, fires: 1, duration: 2600, delay: 900, easing: "easeInOutSine" });
    s.loop((t, dt) => { globe.rot[0] += dt * 5; globe.draw(); });
    const word = s.add(`<div class="title-word" style="left:92px;top:290px;color:#fff">${"Geo".split("").map((c) => `<span>${c}</span>`).join("")}${"Flare".split("").map((c) => `<span class="f">${c}</span>`).join("")}</div>`);
    tw({ targets: word.querySelectorAll("span"), opacity: [0, 1], translateY: [40, 0], duration: 700, delay: anime.stagger(95, { start: 500 }), easing: "easeOutExpo" });
    const sub = s.add('<div class="p-sub" style="left:100px;top:510px;width:640px;font-size:34px;color:#F5F5F7;opacity:0">The story of our planet\'s fires,<br>and the air around them.</div>');
    const ch = s.add('<div class="p-sub" style="left:100px;top:640px;width:640px;font-size:19px;opacity:0">NASA Space Apps 2026 · Harmonization of MODIS and VIIRS Hot Spots<br>Team FLARECRAFT · Assiut, Egypt</div>');
    tw({ targets: sub, opacity: 1, translateY: [20, 0], duration: 800, delay: 1500, easing: "easeOutCubic" });
    tw({ targets: ch, opacity: 1, duration: 800, delay: 2100, easing: "linear" });
    FX.burst(800, 500, 240, { speed: 950, life: 1.5, g: 0, r: 3.6 });
    F.place(800, 500, { s: 0.4, mood: "wow" });
    s.later(350, () => F.orbit(1190, 490, 440, 150, { dur: 2500, s: 0.7,
      done: () => F.to(210, 830, { s: 1, mood: "happy", dur: 900, done: () => F.say("Five minutes, one planet. Let's go!") }) }));
  } });

/* ================================================================ 02 who we are */
const TEAM = [["BA", "Beshoy AbdelMaseeh", "Database engineer<br>Data engineer"], ["BK", "Beshoy Kamal", "QA tester<br>Business analyst"], ["GE", "George Essam", "MLOps<br>AI engineer"], ["ME", "Mathew Emad", "Full-stack engineer<br>Forward-deployed engineer"], ["SA", "Sondos Alsayed", "Data analyst<br>Power BI analyst"]];   // names and roles as in the README's team table
SCENES.push({ id: "team", name: "Who we are", who: "Beshoy Kamal",
  enter(s) {
    s.add('<div class="p-h">Team <em>FLARECRAFT.</em> From Assiut.</div>');
    s.cards = TEAM.map(([ini, name, role], i) => s.add(`<div class="p-card person" style="left:${96 + i * 288}px;top:290px;width:264px;opacity:0"><i>${ini}</i><b>${name}</b><span>${role}</span></div>`));
    F.to(170, 850, { mood: "happy", dur: 800 });
    s.cards.forEach((c, i) => tw({ targets: c, opacity: [0, 1], translateX: [170 - (228 + i * 288), 0], translateY: [420, 0], rotate: [-24, 0], scale: [0.3, 1], duration: 800, delay: 500 + i * 170, easing: "easeOutBack" }));
    s.later(1500, () => F.say("Science and fun aren't opposites. That's our motto."));
  },
  beats: [(s) => {                                                   // roles, one by one, as Flick hops along the row
    F.hush();
    s.cards.forEach((c, i) => s.later(i * 560, () => {
      const cx = 228 + i * 288;
      F.to(cx, 850, { dur: 480, arc: 70, mood: "happy" });
      tw({ targets: c, translateY: -22, duration: 280, easing: "easeOutCubic" });
      tw({ targets: c.querySelector("span"), opacity: 1, duration: 400, easing: "linear" });
      FX.burst(cx, 680, 16, { speed: 220, life: 0.6 });
      s.later(520, () => tw({ targets: c, translateY: 0, duration: 380, easing: "easeOutBounce" }));
    }));
  }] });

/* ================================================================ 03 meet Flick */
SCENES.push({ id: "flick", name: "Meet Flick", who: "Beshoy Kamal", beats: [],
  enter(s) {
    s.add('<div class="p-h">Meet <em>Flick,</em> our guide for today.</div>');
    const chips = ["Tells the story", "Explains every page", "Answers your questions"].map((t) => s.add(`<div class="p-chip" style="left:0;top:0;opacity:0">${t}</div>`));
    tw({ targets: chips, opacity: 1, duration: 600, delay: anime.stagger(250, { start: 900 }), easing: "linear" });
    const home = [[190, 420], [150, 740], [1130, 770]];
    s.loop((t) => chips.forEach((c, i) => { c.style.transform = `translate(${home[i][0] + Math.sin(t / 1400 + i * 2) * 14}px,${home[i][1] + Math.cos(t / 1100 + i * 2) * 12}px)`; }));
    F.to(800, 660, { s: 2.2, mood: "laugh", dur: 1000, arc: 220, done: () => { F.spin(); FX.burst(800, 620, 50, { speed: 520 }); F.say("Hi! I'm Flick. I'll be with you the whole way."); } });
  } });

/* ================================================================ 04 the problem */
SCENES.push({ id: "problem", name: "The problem", who: "Beshoy Kamal",
  enter(s) {
    s.add('<div class="p-h">The data exists. Nobody can <em>use it.</em></div>');
    s.ask = s.add('<div class="ask" style="opacity:0">Is the fire near me dangerous?</div>');
    tw({ targets: s.ask, opacity: 1, scale: [0.9, 1], duration: 700, delay: 300, easing: "easeOutCubic" });
    const spots = [[170, 300], [1150, 320], [1060, 800]];
    s.tiles = ["Fire archive", "Weather records", "Air quality"].map((t, i) => s.add(`<div class="p-chip" style="left:${spots[i][0]}px;top:${spots[i][1]}px;opacity:0;font-size:28px;padding:20px 32px">${t}</div>`));
    s.tiles.forEach((c, i) => tw({ targets: c, opacity: [0, 1], translateX: [700 - spots[i][0], 0], translateY: [470 - spots[i][1], 0], scale: [0.5, 1], duration: 1200, delay: 500 + i * 150, easing: "easeOutExpo" }));
    F.to(800, 720, { mood: "worried", dur: 700 });
    [[330, 480], [1290, 500], [1000, 720]].forEach(([x, y], i) => s.later(1500 + i * 900, () => F.to(x, y, { dur: 700, arc: 110, mood: "worried" })));
    s.later(4300, () => F.say("Three places to look, for one simple question."));
  },
  beats: [
    (s) => {                                                         // the stage goes dark: the record, year by year, and the leap in 2012
      $("#stage").classList.add("dark"); F.hush();
      tw({ targets: [s.ask, ...s.tiles], opacity: 0, duration: 400, easing: "linear" });
      s.chart = yearChart(s, 560, 250, 950, 620);
      s.big = s.add('<div class="p-num" style="left:96px;top:350px;font-size:210px;opacity:0;color:#FF8A3D">3.6×</div>');
      s.cap = s.add('<div class="p-sub" style="left:104px;top:570px;width:420px;font-size:30px;color:#F5F5F7;opacity:0">more hotspots,<br>overnight in 2012</div>');
      F.to(330, 850, { mood: "think", dur: 700 });
      s.chart.grow(70, () => {
        s.big.textContent = `${(Math.floor(s.chart.ratio.naive_ratio * 10) / 10).toFixed(1)}×`;
        tw({ targets: s.big, opacity: [0, 1], scale: [2.6, 1], duration: 650, easing: "easeOutExpo" });
        tw({ targets: s.cap, opacity: 1, duration: 500, delay: 400, easing: "linear" });
        tw({ targets: s.chart.svg, translateX: [18, 0], duration: 600, easing: "easeOutElastic(1, .3)" });
        FX.burst(s.chart.jumpX, s.chart.jumpTop, 90, { speed: 600, life: 1.1 });
        F.mood("wow"); F.hop(); s.later(600, () => F.say("Did Earth catch fire in 2012?"));
      });
    },
    (s) => {                                                         // the same fire through both eyes
      tw({ targets: [s.big, s.cap], opacity: 0, duration: 350, easing: "linear" });
      s.chart.svg.style.transformOrigin = "0 0";
      tw({ targets: s.chart.svg, translateX: -480, translateY: 70, scale: 0.68, duration: 900, easing: "easeInOutCubic" });
      const lit = { modis: ["1,1", "1,2"], viirs: ["3,3", "3,4", "4,2", "4,3", "4,4", "4,5", "5,3", "5,4", "2,4", "5,5"] };
      const grid = (x, n, cell, set, color) => {
        const g = s.add(`<svg width="340" height="340" style="left:${x}px;top:300px;overflow:visible"><circle cx="175" cy="180" r="95" fill="#FF8A3D" opacity=".28" filter="blur(26px)"/></svg>`);
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
          const on = set.includes(`${r},${c}`), rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          rect.setAttribute("x", c * cell + 2); rect.setAttribute("y", r * cell + 2); rect.setAttribute("width", cell - 4); rect.setAttribute("height", cell - 4); rect.setAttribute("rx", Math.min(8, cell / 5));
          rect.setAttribute("fill", on ? color : "none"); rect.setAttribute("stroke", "#3A4150"); rect.setAttribute("stroke-width", 1.5); rect.style.opacity = 0;
          g.appendChild(rect);
          tw({ targets: rect, opacity: 1, duration: 300, delay: 500 + (r * n + c) * (240 / n) + (on ? 700 : 0), easing: "linear" });
        }
      };
      grid(860, 3, 113, lit.modis, GREY); grid(1230, 8, 42.5, lit.viirs, EMBER);
      const l1 = s.add('<div class="lens" style="left:860px;top:660px;width:340px;color:#A1A1A6;opacity:0"><b style="color:#F5F5F7">2 hotspots</b>MODIS · 1 km squares</div>');
      const l2 = s.add('<div class="lens" style="left:1230px;top:660px;width:340px;color:#FF8A3D;opacity:0"><b>10 hotspots</b>VIIRS · 375 m squares</div>');
      tw({ targets: [l1, l2], opacity: 1, translateY: [16, 0], duration: 600, delay: anime.stagger(500, { start: 1300 }), easing: "easeOutCubic" });
      s.add('<div class="p-kicker" style="left:860px;top:250px;color:#A1A1A6">The same fire, through both eyes</div>');
      F.to(760, 890, { mood: "happy", dur: 800 });
      s.later(2000, () => F.say("No. The satellite's eye got sharper."));
    }] });

/* ================================================================ 05 how we fix it: the real app, live, and you can use it */
SCENES.push({ id: "fix", name: "How we fix it", who: "Mathew Emad",
  enter(s) {
    s.add('<div class="p-h">Pick a place. <em>Get the answer.</em></div>');
    const from = [[120, 300], [110, 520], [130, 740]];
    const tiles = ["Fire archive", "Weather records", "Air quality"].map((t, i) => s.add(`<div class="p-chip" style="left:${from[i][0]}px;top:${from[i][1]}px">${t}</div>`));
    tiles.forEach((c, i) => tw({ targets: c, translateX: 690 - from[i][0] - 80, translateY: 520 - from[i][1], scale: 0.2, opacity: [1, 0], duration: 800, delay: 400 + i * 120, easing: "easeInCubic" }));
    if (SNAP) { s.shot = s.add('<div class="win" style="left:130px;top:205px;width:1120px;height:663px"><div class="bar"><i></i><i></i><i></i><span>GeoFlare · pictures of the app</span></div><img src="img/history_world.jpg" width="1120" height="629" alt=""></div>'); }
    else s.app = appWindow(s, { x: 130, y: 205, w: 1120, src: "/fires#history", title: Mode.replay ? "GeoFlare · the real app, on saved data" : "GeoFlare · the real app, running now" });
    s.later(1250, () => FX.burst(690, 520, 120, { speed: 700, life: 1 }));
    tw({ targets: s.shot || s.app.win, opacity: [0, 1], scale: [0.2, 1], duration: 900, delay: 1250, easing: "easeOutBack" });
    F.to(1440, 905, { mood: "proud", s: 0.75, dur: 800 });
    s.later(2400, () => F.say(SNAP ? "One place for fires, air and answers." : "One place for fires, air and answers. And this is the real app."));
  },
  beats: [(s) => {                                                   // Flick types a place for you; after that the window is yours to use
    F.hush();
    if (s.shot) {                                                    // the folder copy: Flick goes to the search box in the picture, and the picture answers
      const [fx, fy] = SNAP.search || [0.5, 0.3];
      F.to(130 + fx * 1120 + 250, 239 + fy * 629 + 60, { dur: 700, s: 0.6, arc: 120, mood: "happy", done: () => s.later(900, () => {
        s.shot.querySelector("img").src = "img/history_egypt.jpg"; FX.burst(130 + fx * 1120, 239 + fy * 629, 36, { speed: 320, life: 0.7 });
        F.to(1440, 905, { dur: 700, s: 0.75, mood: "wink", done: () => F.say("I typed Egypt, and there's the answer.") });
      }) });
      return;
    }
    s.app.find("#search", (box) => {
      box.scrollIntoView({ block: "center" });
      const [bx, by] = s.app.at(box);
      F.to(bx + 250, by + 60, { dur: 700, s: 0.6, arc: 120, mood: "happy", done: () => {
        box.value = ""; "Egypt".split("").forEach((ch, i) => s.later(i * 130, () => { box.value += ch; }));
        s.later(900, () => {
          box.dispatchEvent(new Event("change", { bubbles: true }));
          FX.burst(bx, by, 36, { speed: 320, life: 0.7 });
          s.app.find("#dash-flick", (card) => { card.scrollIntoView({ block: "center" }); s.app.track(card, 22); }, { ready: (card) => /Egypt/.test(card.textContent) });
          F.to(1440, 905, { dur: 700, s: 0.75, mood: "wink", done: () => F.say("I typed Egypt. Now you try any place.") });
        });
      } });
    });
  }] });

/* ================================================================ 06 the data */
SCENES.push({ id: "data", name: "The data", who: "Mathew Emad", dark: true, beats: [],
  enter(s) {
    s.add('<div class="p-h" style="color:#fff">Straight from NASA. <em>Free and open.</em></div>');
    const cv = s.add('<canvas width="560" height="560" style="left:30px;top:330px"></canvas>'), globe = makeGlobe(cv, 215);
    const flow = s.add('<canvas width="1600" height="1000" style="left:0;top:0"></canvas>'), ctx = flow.getContext("2d");
    const src = [["MODIS", 660, 250], ["VIIRS", 905, 215], ["Weather", 1150, 250], ["Live feed", 420, 480]];
    const nums = [[23, (v) => `${Math.round(v)}`, "years of fire records, 2003–2025"], [40, (v) => `≈ ${Math.round(v)} M`, "detections in 2025 alone"], [4.15, (v) => `${v.toFixed(2)} M`, "weather readings from NASA POWER"], [24, (v) => `${Math.round(v)} h`, "live feed, straight from NASA"]];
    const chips = src.slice(0, 3).map(([t, x, y]) => s.add(`<div class="p-chip" style="left:${x}px;top:${y}px;opacity:0">${t}</div>`));
    tw({ targets: chips, opacity: [0, 1], translateY: [-30, 0], duration: 600, delay: anime.stagger(200, { start: 300 }), easing: "easeOutBack" });
    const counts = nums.map(([v, f, label], i) => s.add(`<div class="count" style="left:${570 + i * 255}px;top:650px;width:240px;opacity:0"><b class="p-num" style="font-size:64px;white-space:nowrap">${f(0)}</b><span>${label}</span></div>`));
    const streams = [];                                              // source -> its counter, as a curved river of dots
    const open = (k, target) => streams.push({ x0: src[k][1] + 60, y0: src[k][2] + 50, x1: 620 + target * 255, y1: 650, dots: [] });
    [[0, 0], [1, 1], [2, 2], [3, 3]].forEach(([k, target], i) => s.later(700 + i * 550, () => {
      open(k, target);
      tw({ targets: counts[target], opacity: 1, duration: 500, easing: "linear" });
      countTo(counts[target].querySelector("b"), nums[target][0], { text: nums[target][1], dur: 1500 });
    }));
    s.loop((t, dt) => {
      globe.rot[0] += dt * 7; globe.draw();
      ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = "lighter";
      for (const st of streams) {
        if (Math.random() < (P.calm ? 0.25 : 0.7)) st.dots.push({ t: 0, v: 0.45 + Math.random() * 0.35, o: (Math.random() - 0.5) * 34 });
        st.dots = st.dots.filter((d) => (d.t += dt * d.v) < 1);
        const cx = (st.x0 + st.x1) / 2 + 60, cy = Math.min(st.y0, st.y1) + 40;
        for (const d of st.dots) {
          const u = 1 - d.t, x = u * u * st.x0 + 2 * u * d.t * cx + d.t * d.t * st.x1 + d.o * Math.sin(d.t * 3.14), y = u * u * st.y0 + 2 * u * d.t * cy + d.t * d.t * st.y1;
          ctx.fillStyle = `rgba(255,${150 + (d.o > 0 ? 60 : 0)},70,${Math.sin(d.t * 3.14) * 0.9})`; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.283); ctx.fill();
        }
      }
    });
    F.to(1400, 470, { mood: "happy", s: 0.85, dur: 900 });
    s.later(3200, () => F.say("The data is free. Making it usable is the real work."));
  } });

/* ================================================================ 07 clean data */
SCENES.push({ id: "clean", name: "Clean data", who: "George Essam",
  enter(s) {
    s.add('<div class="p-h">Raw files become <em>one clean table.</em></div>');
    s.add('<div style="left:80px;top:760px;width:1440px;height:6px;border-radius:3px;background:var(--line)"></div>');
    const G = [["Collect", "NASA FIRMS archives<br>NASA POWER weather API"], ["Clean", "Three satellites, one schema<br>Weather matched within 100 km"], ["Store", "PostgreSQL + PostGIS<br>Docker + Airflow, refreshed daily"]];
    s.gates = G.map(([t, d], i) => s.add(`<div class="gate" style="left:${470 + i * 330}px;top:430px"><b>${t}</b><span>${d}</span></div>`));
    const colors = [GREY, "#E8590C", "#0A84FF"], widths = [150, 96, 190, 120, 70, 170, 110, 200, 86];
    s.rows = widths.map((w, i) => s.add(`<div style="left:${110 + (i % 3) * 34}px;top:${476 + i * 30}px;width:${w}px;height:16px;border-radius:8px;background:${colors[i % 3]};opacity:0"></div>`));
    tw({ targets: s.rows, opacity: [0, 1], translateX: [-120, 0], duration: 600, delay: anime.stagger(60, { start: 400 }), easing: "easeOutCubic" });
    F.to(250, 925, { mood: "think", s: 0.62, dur: 800 });
    s.later(1400, () => F.say("Three satellites, three shapes of data. Watch."));
  },
  beats: [
    (s) => { F.hush(); s.gates[0].classList.add("on"); s.rows.forEach((r, i) => tw({ targets: r, left: 690 + (i % 3) * 30, duration: 900, delay: i * 55, easing: "easeInOutCubic" })); F.to(420, 925, { dur: 800, s: 0.62, mood: "think" }); },
    (s) => {
      s.gates[1].classList.add("on");
      s.rows.forEach((r, i) => tw({ targets: r, left: 1016, width: 150, backgroundColor: "#E8590C", duration: 950, delay: i * 60, easing: "easeInOutCubic" }));
      const stamp = s.add('<div class="stamp" style="left:826px;top:268px">CLEAN</div>');
      F.to(700, 925, { dur: 800, s: 0.62, mood: "happy", done: () => { F.hop(); FX.burst(1090, 600, 40, { speed: 320, life: 0.7 }); tw({ targets: stamp, opacity: [0, 1], scale: [2.4, 1], duration: 420, easing: "easeOutExpo" }); F.say("Three satellites, one language."); } });
    },
    (s) => {
      F.hush(); s.gates[2].classList.add("on");
      const head = s.add('<div style="left:1352px;top:470px;width:170px;height:22px;border-radius:8px 8px 0 0;background:#1D1D1F;opacity:0"></div>');
      s.rows.forEach((r, i) => tw({ targets: r, left: 1352, top: 500 + i * 26, width: 170, height: 20, borderRadius: 3, duration: 950, delay: i * 70, easing: "easeInOutCubic" }));
      tw({ targets: head, opacity: 1, duration: 500, delay: 800, easing: "linear" });
      F.to(1040, 925, { dur: 800, s: 0.62, mood: "proud", done: () => F.say("One table, and it refreshes itself every day.") });
    }] });

/* ================================================================ 08 Power BI: Sondos, on the second laptop */
SCENES.push({ id: "pbi", name: "Power BI", who: "Sondos Alsayed", dark: true, beats: [],
  enter(s) {
    s.add('<div class="handover" style="top:150px"><div class="p-kicker" style="color:#A1A1A6;margin-bottom:22px">Power BI</div><div class="big" style="color:#fff">The whole year,<br><em>at a glance.</em></div></div>');
    const ic = s.add('<div class="screen-ic" style="left:650px;top:470px;opacity:0"></div>');
    s.add('<div class="p-sub" style="left:300px;top:726px;width:1000px;text-align:center;color:#D2D2D7">Sondos has the real dashboard, live, on the second laptop.</div>');
    F.to(330, 890, { mood: "wow", dur: 800, done: () => {
      FX.burst(800, 565, 110, { speed: 620, life: 1, g: 0 });
      tw({ targets: ic, opacity: [0, 1], scale: [0.3, 1], duration: 700, easing: "easeOutBack" });
      F.say("Time for the real dashboard!");
    } });
    s.later(1700, () => { if (!P.instant) anime({ targets: ic, scale: [1, 1.05], direction: "alternate", loop: true, duration: 1200, easing: "easeInOutSine" }); });
  } });

/* The same dashboard as saved pictures, one key away (D), for a day the second laptop fails. Not part of the normal run. */
const PBI = (x, y, w, hgt) => [x * 0.8333, 50 + y * 0.8333, w * 0.8333, hgt * 0.8333];
SCENES.push({ id: "dashboard", name: "Power BI (saved pictures)", who: "Sondos Alsayed", dark: true, hidden: true, then: "model",
  enter(s) {
    s.img = s.add('<img src="' + ROOT + 'img/pbi_overview.jpg" width="1600" height="900" style="left:0;top:50px" alt="">');
    s.add('<span class="p-live p-saved" style="left:24px;top:14px">SAVED PICTURE</span>');
    F.to(1480, 880, { s: 0.8, mood: "happy", dur: 700 });
  },
  beats: [
    () => { Spot.at(...PBI(40, 146, 352, 150)); F.say("About forty million detections in 2025."); },
    () => { Spot.at(...PBI(784, 146, 352, 150)); F.say("More than a quarter of them severe."); },
    () => { Spot.at(...PBI(40, 316, 1220, 420)); F.say("Day by day, with the peak in August and September."); },
    (s) => { s.img.src = ROOT + "img/pbi_map.jpg"; Spot.at(...PBI(40, 146, 420, 270)); F.say("Pick a month, and the map follows."); }] });

/* ================================================================ 09 the AI model */
SCENES.push({ id: "model", name: "The AI model", who: "George Essam", dark: true,
  enter(s) {
    s.add('<div class="p-h" style="color:#fff">Which fires could <em>turn severe?</em></div>');
    s.add('<div class="p-card" style="left:96px;top:230px;width:900px;height:580px"></div>');
    const cv = s.add('<canvas width="900" height="580" style="left:96px;top:230px"></canvas>'), ctx = cv.getContext("2d");
    const proj = d3.geoEquirectangular().fitExtent([[24, 30], [876, 550]], { type: "Sphere" }), path = d3.geoPath(proj, ctx);
    s.proj = proj; s.scan = -1;
    const tint = (p) => (p >= 0.6 ? "232,89,12" : p >= 0.44 ? "237,122,53" : p >= 0.2 ? "243,162,111" : "248,205,179");
    s.loop(() => {
      ctx.clearRect(0, 0, 900, 580);
      if (Data.land) { ctx.beginPath(); path(Data.land); ctx.fillStyle = "#1C222B"; ctx.fill(); }
      if (Data.severity) for (const [lat, lon, p] of Data.severity.points) {
        const [x, y] = proj([lon, lat]), done = x < s.scan;
        ctx.fillStyle = done ? `rgba(${tint(p)},.92)` : "rgba(142,142,147,.55)";
        ctx.beginPath(); ctx.arc(x, y, done ? 2 + p * 3.2 : 2.2, 0, 6.283); ctx.fill();
      }
      if (s.scan > 0 && s.scan < 900) { const g = ctx.createLinearGradient(s.scan - 60, 0, s.scan, 0); g.addColorStop(0, "rgba(255,138,61,0)"); g.addColorStop(1, "rgba(255,138,61,.5)"); ctx.fillStyle = g; ctx.fillRect(s.scan - 60, 0, 60, 580); ctx.fillStyle = EMBER; ctx.fillRect(s.scan - 2, 0, 3, 580); }
    });
    s.add('<div class="p-kicker" style="left:120px;top:770px;color:#A1A1A6">' + (Mode.replay ? "Fires from our saved day · NASA" : "Today\'s fires · live from NASA") + '</div>');
    F.to(1280, 820, { mood: "think", dur: 800 });
    s.later(1200, () => F.say(Mode.replay ? "Every dot is a real fire, from the day we saved." : "Every dot is a fire burning today."));
  },
  beats: [
    (s) => {                                                         // the model reads every fire
      F.hush();
      const o = { x: 0 };
      tw({ targets: o, x: 900, duration: 2000, easing: "easeInOutCubic", update: () => { s.scan = o.x; }, complete: () => { s.scan = 900; } });
      if (P.instant) s.scan = 900;
      F.to(120, 200, { dur: 500, s: 0.6, arc: 60, mood: "wow", done: () => F.to(1000, 200, { dur: 2000, s: 0.6, arc: 0, trail: true,
        done: () => F.to(1280, 820, { s: 1, dur: 700, mood: "happy", done: () => F.say("Thousands of fires, scored in seconds.") }) }) });
    },
    (s) => {                                                         // one fire: the model's call, and what the satellite measured
      F.hush();
      const pick = Data.severity && Data.severity.watch.length ? Data.severity.watch.slice().sort((a, b) => b.frp - a.frp)[0] : { lat: -15, lon: 28, p: 0.9, frp: 120, country: "" };
      const [mx, my] = s.proj([pick.lon, pick.lat]);
      const ring = s.add(`<div style="left:${96 + mx - 22}px;top:${230 + my - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid #FF8A3D;opacity:0"></div>`);
      tw({ targets: ring, opacity: [0, 1], scale: [3, 1], duration: 700, easing: "easeOutExpo" });
      const R = 150, C = Math.PI * R, right = pick.frp >= 10;
      const card = s.add(`<div class="p-card" style="left:1040px;top:230px;width:464px;height:330px;opacity:0">
        <svg width="464" height="210" style="position:absolute;left:0;top:14px"><path d="M 82 190 A ${R} ${R} 0 0 1 382 190" fill="none" stroke="#2A303B" stroke-width="22" stroke-linecap="round"/>
        <path class="arc" d="M 82 190 A ${R} ${R} 0 0 1 382 190" fill="none" stroke="#FF8A3D" stroke-width="22" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
        <div class="p-num" style="position:absolute;left:0;right:0;top:110px;text-align:center;font-size:76px">0%</div>
        <div style="position:absolute;left:28px;right:28px;top:226px;text-align:center;font-size:19px;color:#A1A1A6;line-height:1.4">chance this fire turns severe${pick.country ? ` · ${pick.country}` : ""}<br>
        <b style="color:#F5F5F7">Satellite measured ${fmt(pick.frp)} MW${right ? ": it was severe" : ""}</b></div></div>`);
      tw({ targets: card, opacity: [0, 1], translateX: [50, 0], duration: 600, easing: "easeOutCubic" });
      tw({ targets: card.querySelector(".arc"), strokeDashoffset: C * (1 - pick.p), duration: 1400, delay: 300, easing: "easeOutElastic(1, .7)" });
      countTo(card.querySelector(".p-num"), pick.p * 100, { text: (v) => `${Math.round(v)}%`, dur: 1300 });
      F.to(1280, 860, { dur: 500, mood: right ? "proud" : "think" });
    },
    (s) => {                                                         // how good it is, in two numbers and four bars
      const m = Data.model || { auc: 0.893, recall: 0.813, levels: { Low: { actually_severe: 0.05 }, Medium: { actually_severe: 0.19 }, High: { actually_severe: 0.35 }, Extreme: { actually_severe: 0.77 } } };
      const a = s.add('<div class="count" style="left:1040px;top:590px;width:220px;opacity:0"><b class="p-num" style="font-size:64px">0</b><span style="font-size:17px">ROC-AUC on dates it never saw</span></div>');
      const b = s.add('<div class="count" style="left:1280px;top:590px;width:224px;opacity:0"><b class="p-num" style="font-size:64px">0%</b><span style="font-size:17px">of severe fires caught</span></div>');
      tw({ targets: [a, b], opacity: 1, duration: 500, delay: anime.stagger(250), easing: "linear" });
      countTo(a.querySelector("b"), m.auc, { text: (v) => v.toFixed(2), dur: 1200 }); countTo(b.querySelector("b"), m.recall * 100, { text: (v) => `${Math.round(v)}%`, dur: 1200 });
      ["Low", "Medium", "High", "Extreme"].forEach((k, i) => {
        const v = m.levels[k].actually_severe, hgt = 12 + v / 0.77 * 118, col = ["#F8CDB3", "#F3A26F", "#ED7A35", "#E8590C"][i];
        const bar = s.add(`<div style="left:${1040 + i * 118}px;top:${905 - hgt}px;width:100px;height:${hgt}px;border-radius:8px;background:${col};transform-origin:bottom;transform:scaleY(0)"></div>`);
        const lab = s.add(`<div style="left:${1040 + i * 118}px;top:${905 - hgt - 30}px;width:100px;text-align:center;font-size:20px;font-weight:700;color:#F5F5F7;opacity:0">${Math.round(v * 100)}%</div>`);
        s.add(`<div style="left:${1040 + i * 118}px;top:912px;width:100px;text-align:center;font-size:15px;color:#A1A1A6">${k}</div>`);
        tw({ targets: bar, scaleY: [0, 1], duration: 700, delay: 600 + i * 140, easing: "easeOutBack" });
        tw({ targets: lab, opacity: 1, duration: 300, delay: 1100 + i * 140, easing: "linear" });
      });
      F.to(330, 905, { dur: 700, s: 0.7, mood: "happy", done: () => F.say("A score from 0 to 100 that anyone can read.") });
    }] });

/* ================================================================ 10 harmonization */
SCENES.push({ id: "harmony", name: "Harmonization", who: "George Essam", dark: true,
  enter(s) {
    s.add('<div class="p-h" style="color:#fff">23 years, <em>one language.</em></div>');
    s.chart = yearChart(s, 80, 250, 920, 620);
    s.chart.grow(22);
    s.num = s.add('<div class="p-num" style="left:1060px;top:270px;font-size:150px">3.6×</div>');
    s.cap = s.add('<div class="p-sub" style="left:1066px;top:430px;width:440px;color:#D2D2D7">the jump in the raw record</div>');
    F.to(1330, 840, { mood: "think", dur: 800 });
    s.later(1300, () => F.say("Remember this jump?"));
  },
  beats: [
    (s) => {
      F.hush();
      const lift = () => { s.chart.lift(); const r = s.chart.ratio || { naive_ratio: 3.6, harmonized_ratio: 1.01 };
        countTo(s.num, r.harmonized_ratio, { from: r.naive_ratio, dur: 2200, text: (v) => `${v.toFixed(2)}×` }); };
      if (s.chart.ready) lift(); else s.need("intro", () => s.later(50, lift));
      s.cap.textContent = "after harmonization: the false jump is gone";
      F.to(330, 900, { dur: 800, s: 0.8, mood: "proud", done: () => { F.hop(); s.later(1500, () => F.say("Same fires, one unit. The jump is gone.")); } });
    },
    (s) => {
      F.hush();
      const n = (Data.intro && Data.intro.years_tested) || 14, first = (Data.intro && Data.intro.viirs_start) || 2012;
      s.add('<div class="p-kicker" style="left:1066px;top:540px;color:#A1A1A6">Tested honestly: each year hidden, then rebuilt</div>');
      for (let i = 0; i < n; i++) {
        const t = s.add(`<div class="yr" style="left:${1066 + (i % 7) * 62}px;top:${580 + Math.floor(i / 7) * 70}px;width:54px">${String(first + i).slice(2)}</div>`);
        s.later(250 + i * 90, () => { tw({ targets: t, rotateX: [90, 0], duration: 400, easing: "easeOutBack" }); t.classList.add("ok"); t.textContent = "✓"; });
      }
      const cov = s.add('<div class="count" style="left:1066px;top:740px;width:440px;opacity:0"><b class="p-num" style="font-size:80px">0%</b><span>of true values fall inside our 80% ranges</span></div>');
      tw({ targets: cov, opacity: 1, duration: 500, delay: 1500, easing: "linear" });
      s.later(1500, () => countTo(cov.querySelector("b"), ((Data.meta && Data.meta.coverage) || 0.8) * 100, { text: (v) => `${Math.round(v)}%`, dur: 1000 }));
      F.to(330, 900, { dur: 400, mood: "happy" });
      s.later(2600, () => F.say("An honest gain: 33% error, against 35% for one fixed factor."));
    }] });

/* ================================================================ 11 what we found */
SCENES.push({ id: "found", name: "What we found", who: "Sondos Alsayed",
  enter(s) {
    s.add('<div class="p-h">What the data <em>tells us.</em></div>');
    s.add('<div class="p-card" style="left:96px;top:250px;width:950px;height:560px"></div>');
    s.add('<div class="p-kicker" style="left:126px;top:274px">Egypt · every week since 2003</div>');
    const cv = s.add('<canvas width="890" height="470" style="left:126px;top:316px"></canvas>'), ctx = cv.getContext("2d");
    s.cw = 890 / 52; s.ch = 470 / 23; s.gx = 126; s.gy = 316;
    const ramp = d3.interpolateRgbBasis(["#FBEFE4", "#F8CDB3", "#ED7A35", "#B93E06", "#5E1F03"]);
    let shown = 0;
    s.need("egypt", (d) => {
      const max = d3.quantile(d.values.flat().filter((v) => v > 0).sort(d3.ascending), 0.985) || 1;
      const paint = (rows) => { for (let r = shown; r < rows; r++) for (let c = 0; c < 52; c++) { ctx.fillStyle = ramp(Math.min(1, Math.sqrt((d.values[r][c] || 0) / max))); ctx.fillRect(c * s.cw + 1, r * s.ch + 1, s.cw - 2, s.ch - 2); } shown = rows; };
      if (P.instant) paint(23); else { const o = { r: 0 }; anime({ targets: o, r: 23, duration: 1700, delay: 400, easing: "easeInOutSine", update: () => paint(Math.floor(o.r)), complete: () => paint(23) }); }
      s.years = d.years;
    });
    s.finds = [["Fire season", "Peaks in October: rice-straw burning"], ["Unusual months", "August 2015 was 2.2× the normal"], ["Long-term trend", "Up 13% per decade"]]
      .map(([k, t], i) => s.add(`<div class="p-card find" style="left:1090px;top:${250 + i * 132}px"><span>${k.toUpperCase()}</span><b>${t}</b></div>`));
    s.ring = s.add('<div style="left:0;top:0;width:10px;height:10px;border:4px solid #E8590C;border-radius:14px;opacity:0;transition:all .7s cubic-bezier(.2,.8,.2,1)"></div>');
    s.on = (i) => s.finds.forEach((f, k) => f.classList.toggle("on", k === i));
    s.mark = (x, y, w, hgt) => Object.assign(s.ring.style, { left: x + "px", top: y + "px", width: w + "px", height: hgt + "px", opacity: 1 });
    F.to(1310, 880, { mood: "think", s: 0.9, dur: 800 });
    s.later(2300, () => F.say("Every place has its own fire diary. This is Egypt's."));
  },
  beats: [
    (s) => { const pk = (Data.egypt ? Data.egypt.season.peak : 40); s.on(0); s.mark(s.gx + (pk - 2) * s.cw - 4, s.gy - 6, s.cw * 5 + 8, 470 + 12); F.say("October, every single year.", "happy"); },
    (s) => { const u = Data.egypt ? Data.egypt.unusual[0] : { year: 2015, month: 7 }, row = u.year - 2003, col = Math.floor(u.month * 52 / 12);
      s.on(1); s.mark(s.gx + col * s.cw - 6, s.gy + row * s.ch - 6, s.cw * 4.4 + 12, s.ch + 12); F.say("One August stood out: 2015.", "wow"); },
    (s) => {                                                         // the trend, drawn under the calendar
      s.on(2); s.ring.style.opacity = 0;
      const d = Data.egypt, vals = d ? d.annual : [6, 7, 8, 8, 8, 8, 8, 8, 8, 7, 9, 11, 12, 11, 10, 9, 9, 11, 9, 10, 10, 8, 6], line = d ? d.trend.line : [7, 9.6];
      const X = d3.scaleLinear().domain([0, vals.length - 1]).range([10, 440]), Y = d3.scaleLinear().domain([d3.min(vals) * 0.9, d3.max(vals)]).range([104, 12]);
      const path = d3.line().x((v, i) => X(i)).y((v) => Y(v)).curve(d3.curveMonotoneX)(vals);
      const svg = s.add(`<svg width="460" height="120" style="left:96px;top:836px;overflow:visible"><path d="${path}" fill="none" stroke="#A1A1A6" stroke-width="3" stroke-linecap="round"/>
        <line class="tr" x1="${X(0)}" y1="${Y(line[0])}" x2="${X(vals.length - 1)}" y2="${Y(line[1])}" stroke="#E8590C" stroke-width="5" stroke-linecap="round" stroke-dasharray="460" stroke-dashoffset="460"/><text x="10" y="126" font-size="15" fill="#6E6E73">Egypt's fires per year, 2003–2025, with the trend</text></svg>`);
      tw({ targets: svg, opacity: [0, 1], duration: 400, easing: "linear" });
      tw({ targets: svg.querySelector(".tr"), strokeDashoffset: 0, duration: 1100, delay: 300, easing: "easeInOutSine" });
      F.say("Slowly, steadily, more.", "think");
    }] });

/* ================================================================ 12 fire and air: the hotspots that never move */
const mini = (a, b) => {                                             // two series, each scaled to its own range, as two small lines
  const line = (v, col) => { const lo = d3.min(v), hi = d3.max(v); return `<path d="${d3.line().x((d, i) => 6 + i * 178 / (v.length - 1)).y((d) => 82 - (d - lo) / (hi - lo || 1) * 72).curve(d3.curveMonotoneX)(v)}" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round"/>`; };
  return `<svg width="190" height="90">${line(a, "#FF8A3D")}${line(b, "#F5F5F7")}</svg>`;
};
SCENES.push({ id: "air", name: "Fire and air", who: "Mathew Emad", dark: true,
  enter(s) {
    s.add('<div class="p-h" style="color:#fff">Some hotspots <em>never move.</em></div>');
    const cv = s.add('<canvas width="580" height="580" style="left:40px;top:236px"></canvas>'), globe = makeGlobe(cv, 228), ind = { a: 0 };
    globe.fires = 0.4; globe.rot = [-48, -24];
    globe.after = (ctx, proj, centre, k) => {                        // the industrial sites, in white, over the fires in ember
      if (!Data.industry || ind.a <= 0.01) return;
      ctx.fillStyle = `rgba(245,245,247,${0.9 * ind.a})`;
      for (const [lat, lon] of Data.industry.sites) { if (d3.geoDistance([lon, lat], centre) > 1.5) continue; const [x, y] = proj([lon, lat]); ctx.beginPath(); ctx.arc(x, y, 2.4 * k + 0.8, 0, 6.283); ctx.fill(); }
    };
    tw({ targets: ind, a: 1, duration: 1600, delay: 700, easing: "easeInOutSine" });
    s.loop((t, dt) => { globe.rot[0] += dt * 4; globe.draw(); });
    const n = s.add('<div class="count" style="left:740px;top:232px;width:770px;opacity:0"><b class="p-num" style="font-size:92px;color:#F5F5F7">0</b><span style="max-width:none;font-size:23px;margin-top:10px">gas flares, refineries and factories glowing in 2025.<br>They are not wildfires, so we count them apart.</span></div>');
    tw({ targets: n, opacity: 1, duration: 600, delay: 900, easing: "linear" });
    s.need("industry", (d) => s.later(900, () => countTo(n.querySelector("b"), d.count, { dur: 1600 })));
    s.add('<div class="p-kicker" style="left:100px;top:192px;color:#A1A1A6"><span style="color:#FF8A3D">●</span> ' + (Mode.replay ? "fires on our saved day" : "fires today") + ' &nbsp; <span style="color:#F5F5F7">●</span> industrial heat</div>');
    s.test = (i, q, v, cap, art) => {
      const c = s.add(`<div class="p-card test" style="left:740px;top:${438 + i * 138}px;opacity:0">${art}<span>${q}</span><b class="p-num">${v}</b><p>${cap}</p></div>`);
      tw({ targets: c, opacity: [0, 1], translateX: [60, 0], duration: 600, easing: "easeOutCubic" });
    };
    F.to(150, 905, { mood: "think", s: 0.7, dur: 800 });
    s.later(2200, () => F.say("These glow all year, in the very same spot."));
  },
  beats: [
    (s) => { const d = Data.findings || { season: 0.52, fw: [1, 2, 3, 2, 1], iw: [1, 1.4, 1.8, 1.5, 1] };
      s.test(0, "SAME SEASON?", `r = ${d.season.toFixed(2)}`, "Both peak in the northern summer, mostly because satellites see the north best then.", mini(d.fw, d.iw));
      F.say("Same season? Yes, but that's the summer sky talking.", "think"); },
    (s) => { const d = Data.findings || { near: 1.6, countries: 159 };
      const dots = [[62, 40], [74, 52], [56, 58], [80, 36], [70, 66], [88, 50], [50, 44], [66, 30], [92, 62], [150, 20], [168, 70], [130, 78]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5" fill="#FF8A3D"/>`).join("");
      s.test(1, "CLOSE TOGETHER?", `${d.near.toFixed(1)}×`, `more fires next to industry, across ${d.countries} countries. But farms and towns cluster there too.`, `<svg width="190" height="90"><rect x="16" y="32" width="26" height="26" rx="5" fill="#F5F5F7"/>${dots}</svg>`);
      F.say("Close together? Yes, but so are farms and towns.", "think"); },
    (s) => { const d = Data.findings || { trend: 0.2, wf: [3, 2, 3, 2, 3], wi: [1, 2, 3, 4, 5] };
      s.test(2, "MOVE TOGETHER?", `r = ${d.trend.toFixed(2)}`, "When flaring rose, fires barely followed (2012 to 2025).", mini(d.wf, d.wi));
      F.say("Move together? Barely.", "worried"); },
    (s) => {
      const v = s.add('<div style="left:740px;top:868px;width:820px;font-size:29px;white-space:nowrap;font-weight:800;letter-spacing:-.02em;color:#fff;opacity:0">Two separate problems. <span style="color:#FF8A3D">They meet in the air we breathe.</span></div>');
      tw({ targets: v, opacity: [0, 1], translateY: [20, 0], duration: 700, easing: "easeOutCubic" });
      F.to(150, 905, { dur: 300, s: 0.7, mood: "happy", done: () => { F.hop(); FX.burst(150, 870, 50, { speed: 420 }); F.say("So we built GeoFlare Air. Let me show you."); } });
    }] });

/* ================================================================ 13 live demo: the real app, inside the stage */
SCENES.push({ id: "live", name: "Live demo", who: "Mathew Emad",
  enter(s) {
    const X = 150, Y = 150;
    const open = () => {                                             // the real app if today's feed arrived, else the copy saved earlier
      const saved = s.saved = !!Data.saved.live;
      s.add(`<span class="p-live ${saved ? "p-saved" : ""}" style="left:${X}px;top:104px">${saved ? "SAVED COPY" : "LIVE"}</span>`);
      s.add(`<div class="p-sub" style="left:${X + (saved ? 178 : 82)}px;top:101px;font-size:21px">GeoFlare, ${saved ? (SNAP ? "pictures only. For the working app, close this and open Run GeoFlare.cmd" : "from a copy saved earlier") : "running right now"}</div>`);
      if (saved) {
        const win = s.add(`<div class="win" style="left:${X}px;top:${Y}px;width:1300px;height:764px"><div class="bar"><i></i><i></i><i></i><span>GeoFlare</span></div></div>`);
        s.pic = h('<img src="' + ROOT + 'img/fires.jpg" width="1300" height="730" alt="">'); win.appendChild(s.pic); return;
      }
      if (Mode.replay) { s.root.querySelector(".p-live").textContent = "SAVED DATA"; s.root.querySelector(".p-live").classList.add("p-saved"); s.root.querySelector(".p-live + .p-sub").style.left = X + 178 + "px";
        s.root.querySelector(".p-live + .p-sub").textContent = `GeoFlare, the real app, on data saved ${Mode.replay}`; }
      s.app = appWindow(s, { x: X, y: Y, w: 1300, src: "/fires#today" });
      tw({ targets: s.app.win, opacity: [0, 1], duration: 600, easing: "linear" });
      s.app.find('a.pill[href="/fires#severe"]', (el) => { el.scrollIntoView({ block: "center" }); s.pill = el; s.app.track(el, 30); });
    };
    if (Data.live || !Data.pending.live) open(); else Data.pending.live.then(() => { if (s.alive) open(); });
    F.to(1510, 900, { s: 0.75, mood: "happy", dur: 800 });
    s.later(1500, () => F.say(s.saved || Mode.replay ? "These are the fires from our saved copy." : "These are today's fires, live from NASA."));
  },
  beats: [
    (s) => {
      if (s.app) s.app.untrack(); FX.burst(F.st.x, F.st.y, 30, { speed: 300, life: 0.6 });
      if (s.pic) s.pic.src = ROOT + "img/severe.jpg"; else if (s.pill) s.pill.click(); else if (s.app) s.app.frame.contentWindow.location.hash = "#severe";
      F.say("One press. The AI picks the fires to watch.", "proud");
    },
    (s) => {
      if (s.pic) s.pic.src = ROOT + "img/air.jpg";
      else if (s.app) { s.app.untrack(); s.app.frame.src = "/air#27.18,31.18,Assiut";
        s.later(700, () => s.app.find("#air-verdict > *", (el) => { el.scrollIntoView({ block: "center" }); s.app.track(el, 24); }, { up: "#air-verdict" })); }
      F.say("Assiut's air, right now, and what to do today.", "happy");
    },
    (s) => {                                                         // the chat opens and waits: the question is the speaker's to type or pick
      if (s.pic) s.pic.src = ROOT + "img/chat.jpg";
      else if (s.app) { s.app.untrack(); const doc = s.app.doc(), fab = doc.getElementById("chat-fab"); if (fab && doc.getElementById("chat").hidden) fab.click();
        s.later(450, () => s.app.find("#chat", (el) => { s.app.track(el, 26); const q = doc.getElementById("fx-q"); if (q) q.focus(); })); }
      tw({ targets: s.add('<div class="p-sub" style="left:330px;top:924px;font-size:17px;opacity:0">Typing goes to the chat. To move on, click anywhere outside the window, or use the clicker.</div>'), opacity: 1, duration: 500, delay: 1200, easing: "linear" });
      F.to(120, 905, { dur: 700, s: 0.75, mood: "laugh", done: () => { F.say("Ask me anything. Type your question."); s.later(4500, () => F.hush()); } });
    }] });

/* ================================================================ 14 business model */
SCENES.push({ id: "business", name: "Business model", who: "Beshoy Kamal",
  enter(s) {
    s.add('<div class="p-h">Who needs this, and <em>what they get.</em></div>');
    const svg = s.add('<svg width="1600" height="1000" style="left:0;top:0"></svg>');
    const hub = s.add('<div class="hub" style="left:675px;top:300px;opacity:0">One<br>place</div>');
    tw({ targets: hub, opacity: [0, 1], scale: [0.2, 1], duration: 800, delay: 200, easing: "easeOutBack" });
    const who = [["Environmental projects", 150, 280], ["Power companies", 1130, 280], ["Farm owners", 200, 470], ["People near forests", 1150, 470], ["Fire brigades", 705, 620]];
    who.forEach(([t, x, y], i) => {
      const c = s.add(`<div class="p-chip" style="left:${x}px;top:${y}px;opacity:0">${t}</div>`), cx = x + (t.length * 13 + 48) / 2, cy = y + 30;
      const ln = document.createElementNS("http://www.w3.org/2000/svg", "line"), len = Math.hypot(800 - cx, 425 - cy);
      [["x1", cx], ["y1", cy], ["x2", 800], ["y2", 425], ["stroke", "#E8590C"], ["stroke-width", 3], ["stroke-dasharray", len], ["stroke-dashoffset", len], ["opacity", .55]].forEach(([k, v]) => ln.setAttribute(k, v));
      svg.appendChild(ln);
      tw({ targets: c, opacity: [0, 1], scale: [0.5, 1], translateX: [(cx < 800 ? -120 : 120), 0], duration: 600, delay: 900 + i * 420, easing: "easeOutBack" });
      tw({ targets: ln, strokeDashoffset: 0, duration: 500, delay: 1200 + i * 420, easing: "easeOutCubic" });
    });
    F.to(1480, 680, { s: 0.7, mood: "wink", dur: 800 });
    s.later(3400, () => F.say("One place. Minutes instead of days."));
  },
  beats: [
    (s) => {
      F.hush();
      ["Fire and weather reports for any place and period", "Clean data, ready for studies", "Fast and accurate: straight from NASA's API", "Pick the exact spot on the map"]
        .forEach((t, i) => { const c = s.add(`<div class="p-card offer" style="left:${96 + i * 355}px;top:770px;opacity:0"><i>${i + 1}</i>${t}</div>`); (s.offers = s.offers || []).push(c);
          tw({ targets: c, opacity: [0, 1], translateY: [50, 0], duration: 600, delay: i * 130, easing: "easeOutCubic" }); });
    },
    (s) => {                                                         // and what the air side adds
      tw({ targets: s.offers || [], opacity: 0, translateY: -30, duration: 350, easing: "easeInCubic" });
      const k = s.add('<div class="p-kicker" style="left:96px;top:726px;width:1400px;opacity:0">GeoFlare Air measures dust, fine particles, SO₂, NO₂, CO and ozone. That is useful for</div>');
      tw({ targets: k, opacity: 1, duration: 500, delay: 250, easing: "linear" });
      ["New housing: choose a site where the air is clean", "Factories: catch a sudden rise and tighten safety", "Health tourism: show that the air here is clean"]
        .forEach((t, i) => tw({ targets: s.add(`<div class="p-card offer" style="left:${96 + i * 475}px;top:770px;width:450px;opacity:0"><i>${i + 1}</i>${t}</div>`), opacity: [0, 1], translateY: [50, 0], duration: 600, delay: 350 + i * 130, easing: "easeOutCubic" }));
      F.say("And clean air is worth money too.", "happy");
    },
    (s) => { tw({ targets: s.add('<div class="earn" style="top:912px;opacity:0"><b>Free</b> for the public &nbsp;·&nbsp; <b>Subscriptions</b> for companies: alerts, reports, API &nbsp;·&nbsp; <b>Open-source</b> core</div>'), opacity: 1, translateY: [16, 0], duration: 600, easing: "easeOutCubic" }); }] });

/* ================================================================ 15 thank you */
SCENES.push({ id: "thanks", name: "Thank you", who: "Beshoy Kamal", dark: true, beats: [],
  enter(s) {
    const cv = s.add('<canvas width="800" height="800" style="left:800px;top:100px;opacity:0"></canvas>'), globe = makeGlobe(cv, 330);
    tw({ targets: cv, opacity: 1, duration: 1200, easing: "linear" });
    s.loop((t, dt) => { globe.rot[0] += dt * 5; globe.draw(); });
    const big = s.add('<div class="title-word" style="left:92px;top:270px;color:#fff;font-size:170px"><span>Thank&nbsp;</span><span class="f">you.</span></div>');
    tw({ targets: big.querySelectorAll("span"), opacity: [0, 1], translateY: [40, 0], duration: 800, delay: anime.stagger(250, { start: 300 }), easing: "easeOutExpo" });
    const names = s.add('<div class="names" style="left:100px;top:480px;width:700px;font-size:23px;line-height:1.5;opacity:0">Beshoy&nbsp;AbdelMaseeh · Beshoy&nbsp;Kamal · George&nbsp;Essam · Mathew&nbsp;Emad · Sondos&nbsp;Alsayed</div>');
    const repo = s.add('<div class="p-sub" style="left:100px;top:596px;width:700px;font-size:22px;opacity:0">Team FLARECRAFT · Assiut, Egypt · github.com/GEODATA-NASA</div>');
    tw({ targets: [names, repo], opacity: 1, duration: 700, delay: anime.stagger(300, { start: 1200 }), easing: "linear" });
    F.to(230, 830, { mood: "laugh", dur: 900, done: () => { F.bow(); s.later(1200, () => F.say("Questions? Press a number to revisit any scene.")); } });
  } });

Show.start();
