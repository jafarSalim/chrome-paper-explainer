const DEFAULTS = { apiKey: "", model: "claude-sonnet-5-5", lang: "en", level: "student", baseUrl: "https://api.anthropic.com" };
const ids = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS).then((s) => ids.forEach((k) => ($(k).value = s[k])));

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = Object.fromEntries(ids.map((k) => [k, $(k).value.trim()]));
  s.baseUrl = s.baseUrl || DEFAULTS.baseUrl;
  const origin = new URL(s.baseUrl).origin;
  if (origin !== "https://api.anthropic.com") {
    const ok = await chrome.permissions.request({ origins: [origin + "/*"] }).catch(() => false);
    if (!ok) {
      $("status").textContent = `Permission to reach ${origin} was not granted; nothing saved.`;
      return;
    }
  }
  await chrome.storage.local.set(s);
  $("status").textContent = "Saved. Open a paper and hover over an equation.";
});
