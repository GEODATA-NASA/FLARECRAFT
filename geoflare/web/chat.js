/* Ask Flick: the data assistant as a chat that opens from the bottom-right corner, on every page.
   Answers come from the GeoData assistant (port 8000) through the same-origin proxy. */
(() => {
const $ = UI.$, chat = { history: [], enabled: false, busy: false };
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
  try { const s = await UI.api("/geodata/api/v1/ask/status"); chat.enabled = !!s.enabled; } catch (_) { chat.enabled = false; }
  $("chat-fab").hidden = !chat.enabled;   // no assistant, no button
}
async function ask(question) {
  question = question.trim();
  if (question.length < 2 || chat.busy || !chat.enabled) return;
  chat.busy = true; $("fx-ask-go").disabled = true; $("fx-q").value = ""; $("fx-suggest").hidden = true;
  const turn = document.createElement("div");
  turn.className = "fx-turn";
  turn.innerHTML = `<p class="fx-q"></p><div class="fx-a pending">Looking it up…</div>`;
  turn.querySelector(".fx-q").textContent = question;
  $("fx-thread").appendChild(turn); turn.scrollIntoView({ block: "end" });
  const a = turn.querySelector(".fx-a");
  try {
    const r = await UI.post("/geodata/api/v1/ask", { question, history: chat.history.slice(-10) });
    a.classList.remove("pending"); a.innerHTML = markdown(r.answer || "No answer came back.");
    chat.history.push({ role: "user", content: question }, { role: "assistant", content: r.answer || "" });
    $("fx-ask-reset").hidden = false;
  } catch (err) { a.classList.remove("pending"); a.classList.add("failed"); a.textContent = `No answer. ${err.message}`; }
  finally { chat.busy = false; $("fx-ask-go").disabled = false; }
}

function toggle(open) {
  $("chat").hidden = !open; $("chat-fab").setAttribute("aria-expanded", open);
  if (open) $("fx-q").focus();
}
$("chat-face").innerHTML = Flick.svg(40);
$("chat-fab").addEventListener("click", () => toggle($("chat").hidden));
$("chat-close").addEventListener("click", () => { toggle(false); $("chat-fab").focus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("chat").hidden) { toggle(false); $("chat-fab").focus(); } });
$("fx-ask").addEventListener("submit", (e) => { e.preventDefault(); ask($("fx-q").value); });
$("fx-q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask($("fx-q").value); } });
$("fx-suggest").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));
$("fx-ask-reset").addEventListener("click", () => { chat.history = []; $("fx-thread").innerHTML = ""; $("fx-ask-reset").hidden = true; $("fx-suggest").hidden = false; });
loadAsk();
})();
