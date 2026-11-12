// Service worker: owns the API key, calls Claude, keeps the cost of the session per tab.
importScripts("src/claude.js");

const DEFAULTS = { apiKey: "", model: "claude-sonnet-5-5", lang: "en", level: "student", baseUrl: "https://api.anthropic.com" };

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: "explain-selection", title: "Explain with Claude", contexts: ["selection"] });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "explain-selection" && tab && tab.id >= 0) {
    chrome.tabs.sendMessage(tab.id, { type: "explain-selection", text: info.selectionText }).catch(() => {});
  }
});

async function session(tabId, add) {
  const key = `session:${tabId}`;
  const cur = (await chrome.storage.session.get(key))[key] || { calls: 0, usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (add) {
    cur.calls += 1;
    cur.usd += add.usd;
    cur.input += add.usage.input_tokens || 0;
    cur.output += add.usage.output_tokens || 0;
    cur.cacheRead += add.usage.cache_read_input_tokens || 0;
    cur.cacheWrite += add.usage.cache_creation_input_tokens || 0;
    await chrome.storage.session.set({ [key]: cur });
  }
  return cur;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "explain") {
    (async () => {
      const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
      const body = PaperClaude.buildRequest({ model: s.model, digest: msg.digest, task: msg.task, lang: s.lang, level: s.level });
      const t0 = Date.now();
      const r = await PaperClaude.callClaude({ apiKey: s.apiKey, baseUrl: s.baseUrl, body });
      const tabId = sender.tab ? sender.tab.id : msg.tabId;
      const total = await session(tabId, r);
      return { ok: true, ...r, ms: Date.now() - t0, session: total };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // keep the channel open for the async answer
  }
  if (msg.type === "session") {
    session(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`session:${tabId}`));
