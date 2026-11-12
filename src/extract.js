// Reads a paper out of a web page: title, abstract, sections, equations (as LaTeX), figures and the
// sentences that mention them. Works on arXiv HTML and ar5iv (LaTeXML), on pandoc/MathML pages and on
// Wikipedia. Pure DOM code: runs in the content script and, under jsdom, in the tests.
(function (root) {
  "use strict";

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  /** LaTeX source of a MathML <math> element, or "" if the page did not keep it. */
  function texOf(math) {
    const tidy = (s) => clean(s).replace(/^\{\\displaystyle\s*(.*)\}$/, "$1")
      .replace(/\\(?:label|tag)\*?\{[^}]*\}|\\nonumber|\\notag/g, "").replace(/[\s,;.]+$/, "").trim();
    const alt = math.getAttribute("alttext"); // LaTeXML (arXiv HTML, ar5iv) and Wikipedia
    if (alt) return tidy(alt);
    const ann = math.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
    return ann ? tidy(ann.textContent) : "";
  }

  function textWithoutMath(el) {
    // math becomes $tex$ so the context sent to the model keeps it
    const copy = el.cloneNode(true);
    copy.querySelectorAll("math").forEach((m) => {
      const t = texOf(m);
      m.replaceWith(copy.ownerDocument.createTextNode(t ? ` $${t}$ ` : " "));
    });
    copy.querySelectorAll("annotation, script, style, .ltx_note_outer, .mwe-math-fallback-image-inline, .mwe-math-fallback-image-display").forEach((n) => n.remove());
    return clean(copy.textContent);
  }

  function paragraphs(doc) {
    const sel = doc.querySelectorAll(".ltx_para p.ltx_p, .ltx_para, #mw-content-text p, article p, main p, body p");
    const seen = new Set();
    const out = [];
    sel.forEach((p) => {
      if ([...seen].some((s) => s.contains(p) || p.contains(s))) return;
      if (p.closest("figure, figcaption, .ltx_bibliography, #refs, .references, .csl-bib-body, .reflist, .ltx_abstract, .abstract, nav, footer, table.ltx_equation")) return;
      const t = textWithoutMath(p);
      if (t.length >= 40) {
        seen.add(p);
        out.push({ el: p, text: t });
      }
    });
    return out;
  }

  function equations(doc) {
    const out = [];
    doc.querySelectorAll("math").forEach((m, i) => {
      if (m.parentElement && m.parentElement.closest("math")) return;
      const tex = texOf(m);
      if (!tex) return;
      const display = m.getAttribute("display") === "block" || !!m.closest("table.ltx_equation, table.ltx_equationgroup, .ltx_equation, dd > .mwe-math-element, .display");
      const host = m.closest("table.ltx_equation, table.ltx_equationgroup") || m;
      const tagEl = host.querySelector ? host.querySelector(".ltx_tag_equation, .ltx_tag") : null;
      const number = tagEl ? clean(tagEl.textContent).replace(/[()]/g, "") : "";
      const id = host.id || m.id || `math-${i}`;
      out.push({ id, index: i, tex, display, number, el: m });
    });
    return out;
  }

  function figures(doc, paras) {
    const out = [];
    doc.querySelectorAll("figure").forEach((f, i) => {
      if (f.parentElement && f.parentElement.closest("figure")) return; // subfigures belong to their parent
      const cap = f.querySelector(":scope > figcaption, :scope > .ltx_caption, figcaption");
      const caption = cap ? textWithoutMath(cap) : "";
      const tag = cap ? cap.querySelector(".ltx_tag_figure, .ltx_tag_table, .ltx_tag") : null;
      let number = tag ? clean(tag.textContent).replace(/[:.]$/, "") : "";
      const isTable = f.classList.contains("ltx_table") || /^table/i.test(number) || !!f.querySelector(":scope > table");
      if (!number) number = `${isTable ? "Table" : "Figure"} ${out.filter((x) => x.kind === (isTable ? "table" : "figure")).length + 1}`;
      const n = (number.match(/\d+/) || [""])[0];
      const word = isTable ? "(?:Table|Tab\\.)" : "(?:Figure|Fig\\.|Figs\\.)";
      const re = n ? new RegExp(`${word}\\s*~?\\s*${n}(?![\\d])`, "i") : null;
      const mentions = re ? paras.filter((p) => re.test(p.text)).map((p) => p.text).slice(0, 4) : [];
      const img = f.querySelector("img");
      out.push({ id: f.id || `figure-${i}`, kind: isTable ? "table" : "figure", number, caption: caption.replace(/^(Figure|Fig\.|Table)\s*\d+[:.]?\s*/i, ""), mentions, image: img ? img.getAttribute("src") : "", el: f });
    });
    // plain HTML tables with a <caption> (pandoc and many sites) that are not inside a <figure>
    doc.querySelectorAll("table > caption").forEach((cap, i) => {
      const t = cap.parentElement;
      if (t.closest("figure")) return;
      const k = out.filter((x) => x.kind === "table").length + 1;
      const re = new RegExp(`(?:Table|Tab\\.)\\s*~?\\s*${k}(?![\\d])`, "i");
      out.push({ id: t.id || (t.parentElement && t.parentElement.id) || `table-${i}`, kind: "table", number: `Table ${k}`,
        caption: textWithoutMath(cap), mentions: paras.filter((p) => re.test(p.text)).map((p) => p.text).slice(0, 4), image: "", el: t });
    });
    return out;
  }

  function sections(doc) {
    const heads = doc.querySelectorAll("section.ltx_section > h2, section.ltx_section > .ltx_title, h1:not(.title):not(.ltx_title_document):not(#firstHeading), h2, h3");
    const out = [];
    const seen = new Set();
    heads.forEach((h) => {
      if (seen.has(h) || h.closest("nav, .ltx_bibliography, #toc, .toc, footer")) return;
      seen.add(h);
      if (h.closest("header") && h.tagName === "H1") return;
      const title = clean(h.textContent).replace(/^\d+(\.\d+)*\s*/, "").replace(/\[edit\]$/, "");
      if (!title || /^(contents|references|bibliography|navigation menu)$/i.test(title)) return;
      if (out.length === 0 && h.tagName === "H1" && doc.querySelectorAll("h1").length === 1) return; // the page title
      out.push({ id: h.id || (h.parentElement && h.parentElement.id) || "", title, level: h.tagName === "H3" ? 2 : 1, el: h });
    });
    return out;
  }

  /** The most frequent symbols across all equations: a starting point for a glossary. */
  function symbols(eqs, limit = 12) {
    const count = new Map();
    for (const e of eqs) {
      const src = e.tex.replace(/\\(?:text|operatorname|textrm|mbox)\{[^}]*\}/g, " ");
      const toks = src.match(/\\(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega)(?![A-Za-z])(?:_(?:\{(?:[^{}]|\{[^{}]*\})*\}|[A-Za-z0-9]))?|(?<![\\A-Za-z])[A-Za-z](?![A-Za-z])(?:_(?:\{(?:[^{}]|\{[^{}]*\})*\}|[A-Za-z0-9]))?/g) || [];
      for (const t of new Set(toks)) {
        if (/^(d|e|i)$/.test(t)) continue;
        count.set(t, (count.get(t) || 0) + 1);
      }
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([symbol, equations]) => ({ symbol, equations }));
  }

  function extractPaper(doc) {
    const t0 = (root.performance || Date).now();
    const title = clean((doc.querySelector("h1.ltx_title_document, .ltx_title_document, h1.title, header h1, h1#firstHeading, h1") || {}).textContent || doc.title);
    const abs = doc.querySelector(".ltx_abstract, .abstract, #abstract, blockquote.abstract");
    const abstract = abs ? textWithoutMath(abs).replace(/^Abstract\.?\s*/i, "") : "";
    const paras = paragraphs(doc);
    const eqs = equations(doc);
    const figs = figures(doc, paras);
    const secs = sections(doc);
    return {
      title,
      abstract,
      sections: secs,
      paragraphs: paras,
      equations: eqs,
      figures: figs,
      symbols: symbols(eqs),
      ms: (root.performance || Date).now() - t0,
    };
  }

  /** The paragraph text around an element (for an equation: the sentence before and after it). */
  function contextOf(el, paper, chars = 900) {
    const host = el.closest(".ltx_para, p, dd, dl, table.ltx_equation, table.ltx_equationgroup, figure") || el;
    const idx = paper.paragraphs.findIndex((p) => p.el === host || p.el.contains(host) || host.contains(p.el));
    let before = "";
    let after = "";
    if (idx >= 0 && paper.paragraphs[idx].el.contains(el)) {
      // the element sits inside the paragraph: split the paragraph's text at it
      const mark = "\u2063EQ\u2063";
      const copy = paper.paragraphs[idx].el.cloneNode(true);
      const path = [];
      for (let n = el; n && n !== paper.paragraphs[idx].el; n = n.parentNode) path.unshift([...n.parentNode.childNodes].indexOf(n));
      let target = copy;
      for (const i of path) target = target.childNodes[i];
      target.replaceWith(copy.ownerDocument.createTextNode(mark));
      const t = textWithoutMath(copy);
      [before, after] = t.split(mark);
      after = (after || "") + " " + ((paper.paragraphs[idx + 1] || {}).text || "");
    } else if (idx >= 0) {
      before = paper.paragraphs[idx].text;
      after = (paper.paragraphs[idx + 1] || {}).text || "";
    } else {
      const all = paper.paragraphs;
      // pick the closest paragraphs in document order
      const pos = all.findIndex((p) => host.compareDocumentPosition(p.el) & 4 /* FOLLOWING */);
      before = pos > 0 ? all[pos - 1].text : pos === -1 && all.length ? all[all.length - 1].text : "";
      after = pos >= 0 ? all[pos].text : "";
    }
    return { before: clean(before).slice(-chars), after: clean(after).slice(0, chars) };
  }

  /** A compact text version of the whole paper, sent once and cached by the API. */
  function digest(paper, maxChars = 60000) {
    const parts = [`TITLE: ${paper.title}`];
    if (paper.abstract) parts.push(`ABSTRACT: ${paper.abstract}`);
    if (paper.sections.length) parts.push("SECTIONS: " + paper.sections.map((s) => s.title).join(" | "));
    const eqLines = paper.equations.filter((e) => e.display).map((e) => `(${e.number || "-"}) ${e.tex}`);
    if (eqLines.length) parts.push("DISPLAYED EQUATIONS:\n" + eqLines.join("\n"));
    if (paper.figures.length) parts.push("FIGURES AND TABLES:\n" + paper.figures.map((f) => `${f.number}: ${f.caption}`).join("\n"));
    parts.push("TEXT:\n" + paper.paragraphs.map((p) => p.text).join("\n\n"));
    const s = parts.join("\n\n");
    return s.length > maxChars ? s.slice(0, maxChars) + "\n[… truncated]" : s;
  }

  const api = { extractPaper, contextOf, digest, texOf, symbols };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PaperExtract = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
