/* Flick, Team FLARECRAFT's guide: a little flame with a satellite in orbit around its head.
   Expressions, an animalese voice (Web Audio blips, one per letter) and a game-style dialogue box. */

/* ---------------------------------------------------------------- the character */
const Flick = (() => {
  let n = 0;
  function svg(size = 96, mood = "happy") {
    const id = `fk${++n}`;
    return `
    <svg class="flick" data-mood="${mood}" width="${size}" height="${size * 1.2}" viewBox="0 0 120 144" role="img" aria-label="Flick the fire guide">
      <defs>
        <linearGradient id="${id}b" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#d9480f"/><stop offset=".55" stop-color="#ff7a2f"/><stop offset="1" stop-color="#ffb347"/></linearGradient>
        <linearGradient id="${id}c" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#fff6dc"/></linearGradient>
      </defs>
      <ellipse class="fk-shadow" cx="60" cy="139" rx="26" ry="4" fill="rgba(0,0,0,.18)"/>
      <g class="fk-body">
        <path d="M60 8 C66 26 88 40 94 64 C100 88 94 116 74 128 C66 133 54 133 46 128 C26 116 20 90 28 68 C32 57 39 50 44 42 C45 52 49 58 54 60 C51 44 52 24 60 8 Z" fill="url(#${id}b)"/>
        <path d="M60 62 C67 73 80 82 80 100 C80 115 71 124 60 124 C49 124 40 115 40 100 C40 90 46 85 51 79 C53 85 55 88 59 88 C57 79 57 71 60 62 Z" fill="url(#${id}c)"/>
        <g class="fk-eyes">
          <g class="e-open"><ellipse cx="50" cy="95" rx="5.5" ry="7" fill="#2b1406"/><ellipse cx="70" cy="95" rx="5.5" ry="7" fill="#2b1406"/>
            <circle cx="52" cy="92" r="2" fill="#fff"/><circle cx="72" cy="92" r="2" fill="#fff"/></g>
          <g class="e-up"><ellipse cx="51" cy="93" rx="5.5" ry="7" fill="#2b1406"/><ellipse cx="71" cy="93" rx="5.5" ry="7" fill="#2b1406"/>
            <circle cx="53" cy="89" r="2" fill="#fff"/><circle cx="73" cy="89" r="2" fill="#fff"/></g>
          <g class="e-wide"><ellipse cx="50" cy="94" rx="7" ry="9" fill="#2b1406"/><ellipse cx="70" cy="94" rx="7" ry="9" fill="#2b1406"/>
            <circle cx="52.5" cy="90" r="3" fill="#fff"/><circle cx="72.5" cy="90" r="3" fill="#fff"/><circle cx="48" cy="97" r="1.3" fill="#fff"/><circle cx="68" cy="97" r="1.3" fill="#fff"/></g>
          <g class="e-happy" fill="none" stroke="#2b1406" stroke-width="3.2" stroke-linecap="round"><path d="M44 97 Q50 88 56 97"/><path d="M64 97 Q70 88 76 97"/></g>
          <g class="e-wink"><ellipse cx="50" cy="95" rx="5.5" ry="7" fill="#2b1406"/><circle cx="52" cy="92" r="2" fill="#fff"/>
            <path d="M64 96 Q70 90 76 96" fill="none" stroke="#2b1406" stroke-width="3.2" stroke-linecap="round"/></g>
        </g>
        <circle class="fk-cheek" cx="41" cy="106" r="4.5" fill="#ff4d5a" opacity=".32"/><circle class="fk-cheek" cx="79" cy="106" r="4.5" fill="#ff4d5a" opacity=".32"/>
        <g class="fk-mouth">
          <path class="m-smile" d="M52 106 Q60 114 68 106" stroke="#2b1406" stroke-width="2.8" fill="none" stroke-linecap="round"/>
          <path class="m-grin" d="M51 105 Q60 105 69 105 Q66 116 60 116 Q54 116 51 105 Z" fill="#2b1406"/>
          <path class="m-flat" d="M54 109 L66 108" stroke="#2b1406" stroke-width="2.8" stroke-linecap="round"/>
          <ellipse class="m-o" cx="60" cy="109" rx="4" ry="5" fill="#2b1406"/>
          <path class="m-wobble" d="M52 110 Q56 106 60 110 Q64 114 68 110" stroke="#2b1406" stroke-width="2.6" fill="none" stroke-linecap="round"/>
          <ellipse class="m-open" cx="60" cy="109" rx="6" ry="5.5" fill="#2b1406"/>
        </g>
        <g class="x-sweat"><path d="M88 74 Q93 82 88 86 Q83 82 88 74 Z" fill="#7cc8ff"/></g>
        <g class="x-sparkle" fill="#fff3b0"><path d="M18 40 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z"/><path d="M100 22 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z"/></g>
        <text class="x-question" x="92" y="40" font-size="26" font-weight="800" fill="#fff3b0">?</text>
      </g>
      <g transform="rotate(-16 60 52)">
        <ellipse cx="60" cy="52" rx="52" ry="13" fill="none" stroke="#8b97a6" stroke-width="1.2" stroke-dasharray="3 4" opacity=".8"/>
        <g><rect x="-3.5" y="-3" width="7" height="6" rx="1.2" fill="#dfe6ee"/>
          <rect x="-12" y="-2" width="7.5" height="4" rx=".6" fill="#3b82f6"/><rect x="4.5" y="-2" width="7.5" height="4" rx=".6" fill="#3b82f6"/>
          <animateMotion dur="5.5s" repeatCount="indefinite" path="M112 52 A52 13 0 1 1 8 52 A52 13 0 1 1 112 52"/></g>
      </g>
    </svg>`;
  }
  return { svg };
})();

/* ---------------------------------------------------------------- the voice (animalese-style) */
const Voice = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem("flick-muted") === "1"; } catch (e) {}
  const unlock = () => {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
    } catch (e) { /* no audio available */ }
  };
  ["pointerdown", "keydown"].forEach((ev) => addEventListener(ev, unlock, { capture: true }));
  const PITCH = { happy: 600, wow: 720, laugh: 680, wink: 650, proud: 590, think: 500, worried: 450 };

  function tone(freq, dur, type = "triangle", vol = 0.07, slide = 1.15, delay = 0) {
    if (muted || !ctx || ctx.state !== "running") return;
    const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  return {
    blip(ch, mood = "happy") {
      const c = ch.toLowerCase();
      if (!/[a-z]/.test(c)) return;
      const base = PITCH[mood] || 600, step = ((c.charCodeAt(0) - 97) * 37) % 180;
      tone(base + step + Math.random() * 50, 0.055, "aeiou".includes(c) ? "sine" : "triangle", 0.06, 1.2);
    },
    hop() { tone(300, 0.12, "sine", 0.08, 2.4); },
    pop() { tone(900, 0.05, "square", 0.025, 0.6); },
    chime() { [660, 880, 1320].forEach((f, i) => tone(f, 0.14, "sine", 0.045, 1, i * 0.07)); },
    get muted() { return muted; },
    toggle() { muted = !muted; try { localStorage.setItem("flick-muted", muted ? "1" : "0"); } catch (e) {} return muted; },
  };
})();

/* ---------------------------------------------------------------- the dialogue box */
class Dialogue {
  /* host: an element with .dlg-portrait, .dlg-text, .dlg-next, .dlg-back, .dlg-sound inside. */
  constructor(host, { onNext, onBack, size = 104 } = {}) {
    this.host = host;
    this.text = host.querySelector(".dlg-text");
    host.querySelector(".dlg-portrait").innerHTML = Flick.svg(size);
    this.face = host.querySelector(".flick");
    this.typing = false;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = host.querySelector(".dlg-next"), back = host.querySelector(".dlg-back"), sound = host.querySelector(".dlg-sound");
    if (next) next.addEventListener("click", (e) => { e.stopPropagation(); this.advance(onNext); });
    if (back) back.addEventListener("click", (e) => { e.stopPropagation(); onBack && onBack(); });
    if (sound) {
      const paint = () => { sound.textContent = Voice.muted ? "🔇" : "🔊"; sound.setAttribute("aria-label", Voice.muted ? "Turn Flick's voice on" : "Mute Flick"); };
      sound.addEventListener("click", (e) => { e.stopPropagation(); Voice.toggle(); paint(); });
      paint();
    }
    host.querySelector(".dlg-portrait").addEventListener("click", (e) => { e.stopPropagation(); this.advance(onNext); });
  }

  /* Next press: finish the line first (like a game), then move on. */
  advance(onNext) {
    if (this.typing) this.finish();
    else if (onNext) onNext();
  }

  mood(m) { this.face.dataset.mood = m; }

  hop() {
    Voice.hop();
    if (this.reduced || !window.anime) return;
    anime.remove(this.face);
    anime({ targets: this.face, translateY: [0, -16, 0], scaleY: [1, 1.08, 0.94, 1], scaleX: [1, 0.94, 1.06, 1], duration: 520, easing: "easeOutQuad" });
  }

  say(html, mood = "happy") {
    this.finish(true);
    this.mood(mood);
    this.hop();
    this.text.innerHTML = html;
    this.host.classList.remove("done");
    const chars = [];
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const ch of child.textContent) {
            const span = document.createElement("span");
            span.className = "ch"; span.textContent = ch;
            frag.appendChild(span); chars.push(span);
          }
          child.replaceWith(frag);
        } else walk(child);
      }
    };
    walk(this.text);
    this.chars = chars; this.i = 0; this.typing = true;
    const speed = this.reduced ? 0 : 24;
    return new Promise((resolve) => {
      this.resolve = resolve;
      const step = () => {
        if (!this.typing) return;
        const burst = speed ? 1 : chars.length;
        for (let k = 0; k < burst && this.i < chars.length; k++, this.i++) {
          const span = chars[this.i];
          span.classList.add("on");
          if (this.i % 2 === 0) Voice.blip(span.textContent, this.face.dataset.mood);
        }
        this.face.classList.toggle("talking", this.i % 4 < 2);
        if (this.i >= chars.length) return this.finish();
        this.timer = setTimeout(step, ".,!?".includes(chars[this.i - 1].textContent) ? speed * 6 : speed);
      };
      step();
    });
  }

  finish(silent) {
    clearTimeout(this.timer);
    if (!this.typing) return;
    this.typing = false;
    (this.chars || []).forEach((s) => s.classList.add("on"));
    this.face.classList.remove("talking");
    this.host.classList.add("done");
    if (!silent && this.resolve) this.resolve();
  }
}
