// Side panel: a map of the paper in the active tab. Clicking an item scrolls to it and explains it.
const R = globalThis.PaperRender;
const $ = (id) => document.getElementById(id);

async function activeTab() {
  // ?tab=<id> pins the panel to one tab (used when the panel is opened as a page, e.g. in tests)
  const pinned = Number(new URLSearchParams(location.search).get("tab"));
  if (pinned) return chrome.tabs.get(pinned);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function item(html, onClick) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.innerHTML = html;
  b.addEventListener("click", onClick);
  li.appendChild(b);
  return li;
}

async function refresh() {
  const tab = await activeTab();
  if (!tab) return;
  let info;
  try {
    info = await chrome.tabs.sendMessage(tab.id, { type: "paper-info" });
  } catch (_) {
    info = null;
  }
  if (!info) return;
  $("title").textContent = info.title;
  const display = info.equations.filter((e) => e.display);
  $("n-eq").textContent = info.equations.length;
  $("n-fig").textContent = info.figures.length;
  $("n-sec").textContent = info.sections.length;
  const eqs = $("eqs");
  eqs.innerHTML = "";
  (display.length ? display : info.equations.slice(0, 12)).forEach((e) =>
    eqs.appendChild(item(`<span class="num">${e.number ? `(${e.number})` : "·"}</span>${R.tex(e.tex, false)}`, () =>
      chrome.tabs.sendMessage(tab.id, { type: "explain-item", kind: "equation", index: e.i }))));
  if (!eqs.children.length) eqs.innerHTML = '<li class="muted">no equations with LaTeX source on this page</li>';
  const figs = $("figs");
  figs.innerHTML = "";
  info.figures.forEach((f) =>
    figs.appendChild(item(`<span class="num">${R.esc(f.number)}</span><span class="cap">${R.esc(f.caption.slice(0, 110))}${f.caption.length > 110 ? "…" : ""}</span>`, () =>
      chrome.tabs.sendMessage(tab.id, { type: "explain-item", kind: "figure", index: f.i }))));
  if (!figs.children.length) figs.innerHTML = '<li class="muted">none found</li>';
  $("symbols").innerHTML = info.symbols.map((s) => `<span class="chip">${R.tex(s.symbol, false)}<small>×${s.equations}</small></span>`).join("") || '<span class="muted">none</span>';
  const s = await chrome.runtime.sendMessage({ type: "session", tabId: tab.id });
  if (s && s.calls) {
    $("cost").textContent = `${s.calls} question${s.calls > 1 ? "s" : ""} · $${s.usd.toFixed(4)}\n${(s.input + s.cacheRead + s.cacheWrite).toLocaleString()} tokens in (${s.cacheRead.toLocaleString()} read from cache) · ${s.output.toLocaleString()} out`;
  }
}

$("summary").addEventListener("click", async () => {
  const tab = await activeTab();
  chrome.tabs.sendMessage(tab.id, { type: "explain-summary" }).catch(() => {});
});
$("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, info) => info.status === "complete" && refresh());
chrome.storage.onChanged.addListener(refresh);
setInterval(refresh, 4000);
refresh();
