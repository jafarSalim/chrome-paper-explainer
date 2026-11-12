// Prompts, the Messages API call, and cost accounting. Shared by the service worker and the tests.
(function (root) {
  "use strict";

  // USD per million tokens: input, cache write (5 min), cache read, output. Checked 2026-11-13.
  // Haiku 5.5 charges 5x every rate when a prompt is over 100K tokens.
  const PRICES = {
    "claude-haiku-5-5": [0.1, 0.125, 0.01, 0.5],
    "claude-sonnet-5-5": [2, 2.5, 0.1, 10],
    "claude-opus-5-5": [4, 5, 0.2, 20],
  };

  function cost(model, u) {
    const [i, w, r, o] = PRICES[model] || PRICES["claude-sonnet-5-5"];
    const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    let usd = ((u.input_tokens || 0) * i + (u.cache_creation_input_tokens || 0) * w + (u.cache_read_input_tokens || 0) * r + (u.output_tokens || 0) * o) / 1e6;
    if (model === "claude-haiku-5-5" && inTok > 100000) usd *= 5;
    return usd;
  }

  const LANG = {
    en: "Answer in English.",
    ar: "Answer in Modern Standard Arabic. Keep every mathematical symbol, variable name and technical term that has no common Arabic equivalent in Latin script, and write formulas in LaTeX between $...$.",
    fr: "Answer in French.",
    es: "Answer in Spanish.",
    tr: "Answer in Turkish.",
  };

  const LEVEL = {
    student: "The reader is a student who knows calculus and linear algebra but not this field. Define every term the first time.",
    researcher: "The reader is a researcher in a neighbouring field. Be concise; skip textbook definitions.",
  };

  const INSTRUCTIONS = `You explain parts of a scientific paper to a reader who has it open in the browser.
Rules:
- Ground every statement in the paper text you are given. If the paper does not say something, say that it does not; do not guess what the authors meant.
- Write mathematics in LaTeX between $...$.
- Start with one sentence that says what the thing is for, then the details.
- For an equation: list each symbol with its meaning as the paper defines it, say what the equation computes, and give the intuition (what happens when a term grows or vanishes).
- For a figure or table: say what is plotted against what, the main result, and how it supports the claim made where the text mentions it.
- Never invent citations, numbers or results.
- Keep the answer under 250 words unless asked for more.`;

  /** The request body for one question. The fixed instructions and the paper form the cached prefix;
   *  the reader's settings come after it, so changing the language or level does not invalidate the cache. */
  function buildRequest({ model, digest, task, lang = "en", level = "student", maxTokens = 900 }) {
    const system = [
      { type: "text", text: INSTRUCTIONS },
      { type: "text", text: `<paper>\n${digest}\n</paper>`, cache_control: { type: "ephemeral" } },
      { type: "text", text: `${LEVEL[level] || LEVEL.student}\n${LANG[lang] || LANG.en}` },
    ];
    let content;
    if (task.kind === "equation") {
      content = `Explain this equation${task.number ? ` (equation ${task.number})` : ""}:\n$$${task.tex}$$\n\nText just before it:\n${task.before || "(none)"}\n\nText just after it:\n${task.after || "(none)"}`;
    } else if (task.kind === "figure") {
      content = `Explain ${task.number}.\nCaption: ${task.caption || "(no caption)"}\n\nWhere the text mentions it:\n${(task.mentions || []).map((m) => "- " + m).join("\n") || "(not mentioned in the extracted text)"}`;
    } else if (task.kind === "selection") {
      content = `Explain this passage from the paper:\n"""${task.text}"""`;
    } else if (task.kind === "summary") {
      content = "Summarize the paper in five bullet points: problem, method, data, main result with its numbers, and the main limitation.";
    } else {
      content = String(task.question || "");
    }
    return { model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] };
  }

  async function callClaude({ apiKey, baseUrl = "https://api.anthropic.com", body, fetchImpl = fetch }) {
    if (!apiKey) throw new Error("No API key yet. Open the extension options and paste your Anthropic API key.");
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
      if (res.status === 401) throw new Error("The API key was rejected (401). Check it in the extension options.");
      if (res.status === 429) throw new Error("Rate limited by the API (429). Wait a moment and try again.");
      throw new Error(msg);
    }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return { text, usage: data.usage || {}, model: data.model || body.model, usd: cost(body.model, data.usage || {}) };
  }

  const api = { PRICES, cost, buildRequest, callClaude, INSTRUCTIONS, LANG };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PaperClaude = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
