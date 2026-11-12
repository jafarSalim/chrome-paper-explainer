const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const X = require("../src/extract.js");
const C = require("../src/claude.js");
const R = require("../src/render.js");

const load = (f) => new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8")).window.document;
const PAGES = ["arxiv-latexml.html", "sample-pandoc.html"];
const LOS = "H_{\\mathrm{LOS}} = \\frac{(m+1)A}{2\\pi d^2}\\cos^m(\\phi)\\,T_s\\,g(\\psi)\\cos(\\psi)";

for (const page of PAGES) {
  test(`${page}: title, abstract, sections, equations, figures`, () => {
    const p = X.extractPaper(load(page));
    assert.equal(p.title, "Deep-Learning Channel Estimation for Indoor Visible Light Communication with OFDM");
    assert.match(p.abstract, /^Visible light communication \(VLC\)/);
    assert.deepEqual(p.sections.map((s) => s.title), ["Introduction", "System Model", "Estimators", "Results", "Conclusion"]);
    assert.equal(p.equations.length, 10);
    const display = p.equations.filter((e) => e.display);
    assert.equal(display.length, 1);
    assert.equal(display[0].tex, LOS, "LaTeX source recovered, without \\label");
    assert.deepEqual(p.figures.map((f) => f.number).sort(), ["Figure 1", "Figure 2", "Figure 3", "Table 1"]);
    for (const f of p.figures) assert.equal(f.mentions.length, 1, `${f.number} is mentioned once in the text`);
    assert.match(p.figures.find((f) => f.number === "Figure 2").caption, /^Mean-square error of the channel estimate/);
  });

  test(`${page}: equation context is split at the equation`, () => {
    const p = X.extractPaper(load(page));
    const e = p.equations.find((q) => q.display);
    const c = X.contextOf(e.el, p);
    assert.match(c.before, /line-of-sight gain follows the Lambertian model/);
    assert.match(c.after, /^where \$m\$ is the Lambertian order/);
    assert.ok(!c.before.includes("where $m$"), "text after the equation is not in 'before'");
  });

  test(`${page}: digest keeps math as LaTeX and leaves out the reference list`, () => {
    const p = X.extractPaper(load(page));
    const d = X.digest(p);
    assert.match(d, /DISPLAYED EQUATIONS:\n\(1?-?\) ?H_\{\\mathrm\{LOS\}\}/);
    assert.match(d, /\$1\.39\\times10\^\{-4\}\$|\$1\.39 \\times 10\^\{-4\}\$/);
    assert.ok(!/Komine, Toshihiko|Komine, T\./.test(d), "bibliography entries are not paragraphs");
    assert.ok(d.length < 6000);
  });
}

test("symbol glossary counts symbols, not command names", () => {
  const s = X.symbols([{ tex: "y = H_{\\mathrm{LOS}} x + n" }, { tex: "\\hat{x} = \\frac{y}{H_{\\mathrm{LOS}}} + \\sigma^2" }]);
  const names = s.map((x) => x.symbol);
  assert.ok(names.includes("H_{\\mathrm{LOS}}") && names.includes("\\sigma") && names.includes("x") && names.includes("y"));
  assert.ok(!names.some((n) => /^(f|r|a|c|h|m)$/.test(n)), "no letters taken from \\frac, \\hat, \\mathrm");
  assert.equal(s.find((x) => x.symbol === "H_{\\mathrm{LOS}}").equations, 2);
});

test("Wikipedia-style math: alttext wrapped in \\displaystyle", () => {
  const d = new JSDOM(`<h1 id="firstHeading">Euler's identity</h1><div id="mw-content-text"><p>The identity <span class="mwe-math-element"><math alttext="{\\displaystyle e^{i\\pi }+1=0}"><semantics><mrow></mrow></semantics></math></span> links five constants, which is often called the most beautiful equation.</p></div>`).window.document;
  const p = X.extractPaper(d);
  assert.equal(p.title, "Euler's identity");
  assert.equal(p.equations[0].tex, "e^{i\\pi }+1=0");
});

test("the request caches the paper and asks in the chosen language", () => {
  const b = C.buildRequest({ model: "claude-sonnet-5-5", digest: "PAPER", task: { kind: "equation", tex: "E=mc^2", number: "3", before: "b", after: "a" }, lang: "ar" });
  assert.equal(b.system.length, 3);
  assert.equal(b.system[0].cache_control, undefined);
  assert.deepEqual(b.system[1].cache_control, { type: "ephemeral" });
  assert.match(b.system[1].text, /<paper>\nPAPER\n<\/paper>/);
  assert.match(b.system[2].text, /Modern Standard Arabic/);
  // the cached prefix (blocks 0 and 1) does not depend on the language or level
  const en = C.buildRequest({ model: "m", digest: "PAPER", task: { kind: "summary" }, lang: "en", level: "researcher" });
  assert.deepEqual(en.system.slice(0, 2), b.system.slice(0, 2));
  assert.match(b.messages[0].content, /equation 3/);
  assert.match(b.messages[0].content, /\$\$E=mc\^2\$\$/);
  const f = C.buildRequest({ model: "m", digest: "", task: { kind: "figure", number: "Figure 2", caption: "c", mentions: ["Fig. 2 shows"] } });
  assert.match(f.messages[0].content, /^Explain Figure 2\.\nCaption: c/);
});

test("cost: list prices, cache reads, Haiku long-prompt rate", () => {
  assert.equal(C.cost("claude-sonnet-5-5", { input_tokens: 1e6 }), 2);
  assert.equal(C.cost("claude-sonnet-5-5", { cache_read_input_tokens: 1e6 }), 0.1);
  assert.equal(C.cost("claude-sonnet-5-5", { cache_creation_input_tokens: 1e6 }), 2.5);
  assert.equal(C.cost("claude-opus-5-5", { output_tokens: 1e6 }), 20);
  assert.ok(Math.abs(C.cost("claude-haiku-5-5", { input_tokens: 200000 }) - 0.1) < 1e-12);
});

test("callClaude: headers for browser access, readable errors", async () => {
  let seen;
  const ok = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 5 } }) };
  };
  const r = await C.callClaude({ apiKey: "k", baseUrl: "https://example.test/", body: { model: "claude-sonnet-5-5" }, fetchImpl: ok });
  assert.equal(seen.url, "https://example.test/v1/messages");
  assert.equal(seen.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(r.text, "hi");
  const err = (status) => async () => ({ ok: false, status, json: async () => ({ error: { message: "x" } }) });
  await assert.rejects(C.callClaude({ apiKey: "k", body: {}, fetchImpl: err(401) }), /API key was rejected/);
  await assert.rejects(C.callClaude({ apiKey: "k", body: {}, fetchImpl: err(429) }), /Rate limited/);
  await assert.rejects(C.callClaude({ apiKey: "", body: {}, fetchImpl: ok }), /No API key yet/);
});

test("render: escapes HTML, keeps math, lists and emphasis", () => {
  const html = R.markdown('**Gain** of $x_1$ <img src=x onerror=alert(1)>\n\n- one *a*\n- two `c`\n\n$$\na^2\n$$');
  assert.ok(!html.includes("<img"), "no raw HTML from the answer");
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /<strong>Gain<\/strong>/);
  assert.match(html, /<code class="tex">x_1<\/code>/); // no KaTeX in Node: falls back to code
  assert.match(html, /<ul dir="auto"><li dir="auto">one <em>a<\/em><\/li><li dir="auto">two <code>c<\/code><\/li><\/ul>/);
  assert.match(html, /<div class="display"><code class="tex">a\^2<\/code><\/div>/);
});

test("manifest: MV3, only the API host by default, content script on arXiv HTML", () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.host_permissions, ["https://api.anthropic.com/*"]);
  assert.ok(m.content_scripts[0].matches.includes("https://arxiv.org/html/*"));
  for (const f of [...m.content_scripts[0].js, m.background.service_worker, m.side_panel.default_path, m.options_page]) {
    assert.ok(fs.existsSync(path.join(__dirname, "..", f)), f);
  }
});
