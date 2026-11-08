/* GeoFlare shared UI helpers, used by the Dashboard (app.js), Fires (fires.js) and Air (air.js). */
const UI = (() => {
  const $ = (id) => document.getElementById(id);
  const fmt = d3.format(",.0f"), short = d3.format(".2~s");
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------ network */
  let inflight = 0;
  const busy = (on) => { inflight += on ? 1 : -1; const b = $("busy"); if (b) b.classList.toggle("on", inflight > 0); };
  async function api(url, options) {
    busy(true);
    try {
      const r = await fetch(url, options);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const detail = typeof body.detail === "string" ? body.detail
          : Array.isArray(body.detail) ? body.detail.map((d) => `${d.loc.slice(-1)[0]}: ${d.msg}`).join("; ") : r.statusText;
        throw new Error(detail || `The server answered ${r.status}.`);
      }
      return await r.json();
    } finally { busy(false); }
  }
  const post = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  /* ------------------------------------------------------------ look */
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const dark = () => css("color-scheme") === "dark";
  const ramp = () => d3.interpolateRgbBasis(css("--cal-ramp").split(",").map((s) => s.trim()));
  const sevColor = (p) => (p >= 0.6 ? css("--hot") : p >= 0.3 ? css("--mid") : css("--mild"));
  const place = (country, lat, lon) => country || `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /* ------------------------------------------------------------ feedback */
  function showTip(html, e) {
    const tip = $("tooltip");
    tip.innerHTML = html; tip.style.opacity = 1;
    tip.style.left = `${Math.min(e.clientX + 16, innerWidth - 290)}px`; tip.style.top = `${Math.min(e.clientY + 16, innerHeight - 150)}px`;
  }
  const hideTip = () => { $("tooltip").style.opacity = 0; };
  function toast(text) {
    const t = $("toast"); t.textContent = text; t.classList.add("on");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("on"), 3800);
  }

  /* ------------------------------------------------------------ blocks */
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
  function axes(svg, x, y, W, H, m, { yfmt = short, xticks, xfmt } = {}) {
    svg.append("g").attr("class", "axis grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(yfmt).tickSize(-(W - m.l - m.r))).call((g) => g.select(".domain").remove());
    const bottom = d3.axisBottom(x).tickSize(0);
    if (xticks) bottom.tickValues(xticks);
    if (xfmt) bottom.tickFormat(xfmt);
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(bottom).call((g) => g.select(".domain").remove()).selectAll("text").attr("dy", "1.2em");
  }

  /* ------------------------------------------------------------ maps (one registry, so a theme switch restyles every map) */
  const maps = {}, layers = {};
  function baseLayer() {
    return L.tileLayer(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark() ? "Dark" : "Light"}_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
      { attribution: "Basemap &copy; Esri · Fires: NASA FIRMS", maxZoom: 12 });
  }
  function getMap(id, view = [[15, 10], 1.5], options = {}) {
    if (!maps[id]) {
      maps[id] = L.map(id, { worldCopyJump: true, preferCanvas: true, zoomSnap: 0.5, ...options }).setView(...view);
      maps[id].base = baseLayer().addTo(maps[id]);
      layers[id] = L.layerGroup().addTo(maps[id]);
    }
    setTimeout(() => maps[id].invalidateSize(), 50);
    return maps[id];
  }
  const refreshMaps = () => Object.values(maps).forEach((m) => setTimeout(() => m.invalidateSize(), 60));
  function restyleMaps() { Object.values(maps).forEach((m) => { m.base.remove(); m.base = baseLayer().addTo(m); m.base.bringToBack(); }); }

  /* ------------------------------------------------------------ theme listeners */
  const themeHandlers = [];
  const onTheme = (fn) => themeHandlers.push(fn);
  const themeChanged = () => { restyleMaps(); themeHandlers.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); };

  /* An inline "Flick says" card inside the page: never floats over content. */
  function flickCard(el, { size = 64, mood = "happy" } = {}) {
    el.classList.add("dlg", "flick-card");
    el.innerHTML = `<div class="dlg-portrait"></div><div class="dlg-body"><div class="dlg-name">Flick</div><div class="dlg-text" aria-live="polite"></div></div>
      <div class="dlg-controls"><button class="dlg-btn dlg-sound"></button></div>`;
    const d = new Dialogue(el, { size });
    d.mood(mood);
    return d;
  }

  return { $, fmt, short, pct, MONTHS, MONTHS_LONG, reduced, api, post, css, dark, ramp, sevColor, place, esc, showTip, hideTip, toast,
           facts, loadingFacts, bars, axes, maps, layers, getMap, refreshMaps, onTheme, themeChanged, flickCard };
})();
