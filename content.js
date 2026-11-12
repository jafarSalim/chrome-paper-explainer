// Content script: finds equations and figures on the page, shows an "Explain" pill on hover, and shows the
// answer in a glass card. All UI lives in a shadow root so the page's styles cannot break it (or vice versa).
(() => {
  if (window.__paperExplainer) return;
  window.__paperExplainer = true;

  const X = globalThis.PaperExtract;
  const R = globalThis.PaperRender;
  const paper = X.extractPaper(document);
  const digest = X.digest(paper);
  const url = (p) => chrome.runtime.getURL(p);

  // KaTeX fonts must be declared at document level to be usable inside the shadow root
  const fontLink = document.createElement("link");
  fontLink.rel = "stylesheet";
  fontLink.href = url("vendor/katex/katex.min.css");
  document.head.appendChild(fontLink);

  const host = document.createElement("div");
  host.id = "paper-explainer-root";
  host.style.cssText = "all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483000;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <link rel="stylesheet" href="${url("vendor/katex/katex.min.css")}">
    <link rel="stylesheet" href="${url("src/panel.css")}">
    <button class="pill" hidden><span class="spark">✦</span> Explain</button>
    <section class="card" hidden role="dialog" aria-live="polite">
      <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
      <header>
        <span class="kind"></span>
        <span class="title"></span>
        <button class="icon close" title="Close">✕</button>
      </header>
      <div class="preview"></div>
      <div class="answer"></div>
      <footer>
        <span class="meta"></span>
        <button class="icon copy" title="Copy the answer">⧉</button>
      </footer>
    </section>`;
  const pill = shadow.querySelector(".pill");
  const card = shadow.querySelector(".card");
  let current = null;
  let hideTimer = null;
  let lastText = "";

  const targets = [];
  paper.equations.forEach((e, i) => {
    if (!e.display) return;
    const el = e.el.closest("table.ltx_equation, table.ltx_equationgroup, .mwe-math-element, p") || e.el;
    const box = e.el.closest("table.ltx_equation, table.ltx_equationgroup") || e.el;
    targets.push({ el: box.getBoundingClientRect().width ? box : el, kind: "equation", index: i, data: e });
  });
  paper.figures.forEach((f, i) => targets.push({ el: f.el, kind: f.kind, index: i, data: f }));

  function place(el, node, dx = 0) {
    const r = el.getBoundingClientRect();
    node.style.top = `${window.scrollY + r.top + 6}px`;
    node.style.left = `${window.scrollX + r.right - 110 + dx}px`;
  }

  for (const t of targets) {
    t.el.addEventListener("mouseenter", () => {
      clearTimeout(hideTimer);
      current = t;
      pill.hidden = false;
      place(t.el, pill);
    });
    t.el.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(() => (pill.hidden = true), 600);
    });
  }
  pill.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  pill.addEventListener("click", () => current && explain(current));

  // inline formulas: double-click
  document.addEventListener("dblclick", (ev) => {
    const m = ev.target.closest && ev.target.closest("math");
    if (!m) return;
    const e = paper.equations.find((q) => q.el === m || q.el.contains(m) || m.contains(q.el));
    if (e) {
      ev.preventDefault();
      explain({ el: m, kind: "equation", index: paper.equations.indexOf(e), data: e });
    }
  });

  function header(t) {
    if (t.kind === "equation") return [`Equation`, t.data.number ? `(${t.data.number})` : t.data.display ? "" : "inline"];
    if (t.kind === "figure" || t.kind === "table") return [t.kind === "table" ? "Table" : "Figure", t.data.number.replace(/^(Figure|Table)\s*/i, "")];
    if (t.kind === "selection") return ["Passage", ""];
    return ["Paper", "summary"];
  }

  function taskFor(t) {
    if (t.kind === "equation") {
      const c = X.contextOf(t.data.el, paper);
      return { kind: "equation", tex: t.data.tex, number: t.data.number, before: c.before, after: c.after };
    }
    if (t.kind === "figure" || t.kind === "table") return { kind: "figure", number: t.data.number, caption: t.data.caption, mentions: t.data.mentions };
    if (t.kind === "selection") return { kind: "selection", text: t.text };
    return { kind: "summary" };
  }

  function showCard(t, anchorRect) {
    const [kind, title] = header(t);
    card.querySelector(".kind").textContent = kind;
    card.querySelector(".title").textContent = title;
    const prev = card.querySelector(".preview");
    if (t.kind === "equation") prev.innerHTML = `<div class="display">${R.tex(t.data.tex, true)}</div>`;
    else if (t.kind === "figure" || t.kind === "table") prev.innerHTML = `<p class="caption">${R.markdown(t.data.caption).replace(/^<p>|<\/p>$/g, "")}</p>`;
    else if (t.kind === "selection") prev.innerHTML = `<p class="caption">“${R.esc(t.text.slice(0, 280))}${t.text.length > 280 ? "…" : ""}”</p>`;
    else prev.innerHTML = `<p class="caption">${R.esc(paper.title)}</p>`;
    card.querySelector(".answer").innerHTML = `<div class="shimmer"><i></i><i></i><i></i></div>`;
    card.querySelector(".meta").textContent = "asking Claude…";
    card.hidden = false;
    const width = Math.min(560, window.innerWidth - 32);
    card.style.width = `${width}px`;
    const left = Math.max(16, Math.min(window.scrollX + anchorRect.left, window.scrollX + window.innerWidth - width - 16));
    card.style.left = `${left}px`;
    card.style.top = `${window.scrollY + anchorRect.bottom + 12}px`;
  }

  async function explain(t) {
    pill.hidden = true;
    const rect = t.rect || t.el.getBoundingClientRect();
    showCard(t, rect);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "explain", digest, task: taskFor(t) });
    } catch (e) {
      res = { ok: false, error: String(e.message || e) };
    }
    const ans = card.querySelector(".answer");
    if (!res || !res.ok) {
      ans.innerHTML = `<p class="error">${R.esc((res && res.error) || "No answer.")}</p>` +
        (res && /API key/.test(res.error || "") ? `<p><button class="link opts">Open the options</button></p>` : "");
      const o = ans.querySelector(".opts");
      if (o) o.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-options" }));
      card.querySelector(".meta").textContent = "";
      return;
    }
    lastText = res.text;
    ans.innerHTML = R.markdown(res.text);
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const u = res.usage || {};
    const cached = u.cache_read_input_tokens ? ` · ${u.cache_read_input_tokens.toLocaleString()} cached` : "";
    card.querySelector(".meta").textContent =
      `${res.model.replace("claude-", "")} · ${((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)).toLocaleString()} in${cached} · ${(u.output_tokens || 0).toLocaleString()} out · $${res.usd.toFixed(4)} · session $${res.session.usd.toFixed(4)}`;
    document.dispatchEvent(new CustomEvent("paper-explainer:answered", { detail: { kind: t.kind, usage: u, usd: res.usd, ms: res.ms } }));
  }

  card.querySelector(".close").addEventListener("click", () => (card.hidden = true));
  card.querySelector(".copy").addEventListener("click", () => navigator.clipboard.writeText(lastText).catch(() => {}));
  document.addEventListener("keydown", (e) => e.key === "Escape" && (card.hidden = true));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "paper-info") {
      sendResponse({
        title: paper.title,
        sections: paper.sections.map((s) => s.title),
        equations: paper.equations.map((e, i) => ({ i, tex: e.tex, number: e.number, display: e.display })),
        figures: paper.figures.map((f, i) => ({ i, kind: f.kind, number: f.number, caption: f.caption })),
        symbols: paper.symbols,
        digestChars: digest.length,
        ms: paper.ms,
      });
    } else if (msg.type === "explain-item") {
      const t = msg.kind === "equation"
        ? { el: paper.equations[msg.index].el, kind: "equation", index: msg.index, data: paper.equations[msg.index] }
        : { el: paper.figures[msg.index].el, kind: paper.figures[msg.index].kind, index: msg.index, data: paper.figures[msg.index] };
      t.el.scrollIntoView({ block: "center" });
      setTimeout(() => explain(t), 250);
    } else if (msg.type === "explain-selection") {
      const sel = window.getSelection();
      const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : { left: 40, bottom: 120 };
      explain({ el: document.body, rect, kind: "selection", text: msg.text });
    } else if (msg.type === "explain-summary") {
      const h = document.querySelector("h1") || document.body;
      h.scrollIntoView({ block: "start" });
      explain({ el: h, kind: "summary" });
    }
    return false;
  });
})();
