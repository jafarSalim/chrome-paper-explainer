// A small, safe Markdown renderer for answers: paragraphs, lists, **bold**, *italic*, `code`, and LaTeX
// between $...$ or $$...$$ rendered with KaTeX when it is loaded. Everything else is escaped.
(function (root) {
  "use strict";

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function tex(src, display) {
    const k = root.katex;
    if (k) {
      try {
        return k.renderToString(src, { displayMode: display, throwOnError: false, output: "htmlAndMathml", strict: "ignore" });
      } catch (_) {
        /* fall through */
      }
    }
    return `<code class="tex">${esc(src)}</code>`;
  }

  function inline(s) {
    // split out math first so * and _ inside formulas are left alone
    const parts = [];
    const re = /\$\$([^$]+)\$\$|\$([^$\n]+?)\$/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      parts.push({ t: s.slice(last, m.index) });
      parts.push({ math: m[1] || m[2], display: !!m[1] });
      last = re.lastIndex;
    }
    parts.push({ t: s.slice(last) });
    return parts
      .map((p) =>
        p.math !== undefined
          ? tex(p.math.trim(), p.display)
          : esc(p.t)
              .replace(/`([^`]+)`/g, "<code>$1</code>")
              .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
              .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>"),
      )
      .join("");
  }

  function markdown(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p dir="auto">${inline(para.join(" "))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag} dir="auto">${list.items.map((i) => `<li dir="auto">${inline(i)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const display = line.trim().match(/^\$\$(.*)$/);
      if (display) {
        flushPara();
        flushList();
        let body = display[1];
        while (!/\$\$\s*$/.test(body) && i + 1 < lines.length) body += "\n" + lines[++i];
        out.push(`<div class="display">${tex(body.replace(/\$\$\s*$/, "").trim(), true)}</div>`);
        continue;
      }
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const h = line.match(/^\s*#{1,4}\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, items: [] };
        }
        list.items.push((ul || ol)[1]);
      } else if (h) {
        flushPara();
        flushList();
        out.push(`<h4>${inline(h[1])}</h4>`);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara();
    flushList();
    return out.join("\n");
  }

  const api = { markdown, esc, tex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PaperRender = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
