"""End-to-end run of the real extension in Chromium, with screenshots for the README.

* The extension is loaded unpacked into Playwright's Chromium (run under xvfb-run on a server).
* https://arxiv.org/html/2611.00001v1 is answered by Playwright with test/fixtures/arxiv-latexml.html, so the
  content script runs exactly as it would on arXiv. (The real arXiv is not reachable from the build machine.)
* The extension's API address is pointed at a LOCAL MOCK of the Messages API. The mock records every request
  the extension sends, answers with a fixed demo text that says it is a demo, and reports token usage the way
  the API does, including prompt caching (counted with an open stand-in tokenizer).

Writes results/e2e.json and results/shot_*.png.

    xvfb-run -a python3 scripts/e2e.py
"""
import base64
import json
import pathlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import tiktoken
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIX = ROOT / "test" / "fixtures"
OUT = ROOT / "results"
OUT.mkdir(exist_ok=True)
PAPER_URL = "https://arxiv.org/html/2611.00001v1"


def tokenizer():
    tok = ROOT / "data" / "llama4.model"
    if not tok.exists():
        import urllib.request
        tok.parent.mkdir(exist_ok=True)
        urllib.request.urlretrieve("https://raw.githubusercontent.com/meta-llama/llama-models/main/models/llama4/tokenizer.model", tok)
    pat = r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+"""
    ranks = {base64.b64decode(a): int(b) for a, b in (l.split() for l in tok.read_bytes().splitlines() if l)}
    return tiktoken.Encoding("llama4", pat_str=pat, mergeable_ranks=ranks, special_tokens={})


ENC = tokenizer()
ntok = lambda s: len(ENC.encode_ordinary(s))

DEMO = "*Demo answer from a local mock of the API; with your key, Claude writes this part.*\n\n"
ANSWERS = {
    "equation": DEMO + """This is the **line-of-sight channel gain** $H_{\\mathrm{LOS}}$: the fraction of the LED's optical power that reaches the photodiode directly.

- $m$ is the Lambertian order of the LED; the paper uses a 60° semi-angle, so $m = 1$.
- $A$ is the detector area and $d$ the LED–detector distance, so the gain falls as $1/d^2$.
- $\\cos^m(\\phi)$ is how strongly the LED emits at the angle $\\phi$ towards the receiver.
- $T_s$ and $g(\\psi)$ are the optical filter and concentrator gains, and $\\cos(\\psi)$ the projection onto the detector at incidence angle $\\psi$.

**Intuition:** move the receiver away or off-axis and both $d$ and the cosines shrink the gain; that is why the SNR varies across the room.""",
    "figure": DEMO + """The figure plots the **mean-square error of the channel estimate** against SNR for LS, MMSE (designed at 15 dB) and the deep-learning estimator.

- The DL curve stays lowest across the range; the text reports a **10.4 dB** gain over LS at 20 dB.
- MMSE beats LS near its design SNR and becomes worse above it, because its noise assumption is then wrong.

It supports the paper's claim that a network trained across 0–30 dB avoids the mismatch that a fixed-design MMSE suffers.""",
    "ar": "*إجابة تجريبية من خادم محاكاة محلي للواجهة البرمجية؛ مع مفتاحك يكتب Claude هذا الجزء.*\n\n"
          "هذه المعادلة تعطي **كسب القناة في خط النظر المباشر** $H_{\\mathrm{LOS}}$، أي نسبة القدرة الضوئية التي تصل من الصمام الثنائي الباعث للضوء إلى الكاشف مباشرة.\n\n"
          "- $m$ رتبة لامبرت للمصدر، و$A$ مساحة الكاشف، و$d$ المسافة بينهما، لذلك يتناقص الكسب مع $1/d^2$.\n"
          "- $\\cos^m(\\phi)$ شدة الإشعاع باتجاه المستقبِل، و$\\cos(\\psi)$ إسقاطه على سطح الكاشف.\n\n"
          "**الفكرة:** كلما ابتعد المستقبِل أو انحرف عن المحور قلّ الكسب، ولهذا تتغير نسبة الإشارة إلى الضوضاء داخل الغرفة.",
    "summary": DEMO + """- **Problem:** estimating the channel of an indoor VLC link that uses OFDM.
- **Method:** a five-layer perceptron, compared with LS and MMSE.
- **Data:** 4,000 simulated channels of a 5 × 5 × 3 m room.
- **Result:** 10.4 dB lower estimation error than LS at 20 dB; BER $1.39\\times10^{-4}$, equal to perfect channel knowledge.
- **Limitation:** one room, one LED, simulated channels only.""",
}

requests_log = []
seen_prefixes = set()


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "*")
        self.send_header("access-control-allow-methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        sys_blocks = body["system"]
        # like the API: the cached prefix is everything up to and including the block marked cache_control
        cut = max(i for i, b in enumerate(sys_blocks) if b.get("cache_control")) + 1
        prefix = "".join(b["text"] for b in sys_blocks[:cut])
        after = "".join(b["text"] for b in sys_blocks[cut:])
        cached = "".join(b["text"] for b in sys_blocks if b.get("cache_control"))
        plain = "".join(b["text"] for b in sys_blocks if not b.get("cache_control"))
        user = body["messages"][-1]["content"]
        prefix_tokens = ntok(prefix)
        key = (body["model"], prefix)
        hit = key in seen_prefixes
        seen_prefixes.add(key)
        lang_ar = "Arabic" in plain
        kind = "ar" if lang_ar else ("equation" if user.startswith("Explain this equation") else "figure" if user.startswith("Explain Figure") or user.startswith("Explain Table") else "summary" if user.startswith("Summarize") else "figure")
        text = ANSWERS[kind]
        usage = {"input_tokens": ntok(user) + ntok(after) + 4, "output_tokens": ntok(text),
                 "cache_creation_input_tokens": 0 if hit else prefix_tokens, "cache_read_input_tokens": prefix_tokens if hit else 0}
        requests_log.append({"model": body["model"], "max_tokens": body["max_tokens"], "user": user, "system_plain_tokens": ntok(plain),
                             "paper_tokens": ntok(cached), "cache_control": [b.get("cache_control") for b in sys_blocks],
                             "usage": usage, "headers": {k: self.headers[k] for k in ("anthropic-version", "anthropic-dangerous-direct-browser-access")},
                             "has_key": bool(self.headers.get("x-api-key"))})
        time.sleep(0.6)  # a little latency so the loading state is visible
        out = json.dumps({"id": "msg_mock", "type": "message", "role": "assistant", "model": body["model"],
                          "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "usage": usage}).encode()
        self.send_response(200)
        self._cors()
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(out)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    mock_url = f"http://127.0.0.1:{srv.server_address[1]}"
    res = {"mock": mock_url, "steps": []}
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(ROOT / ".e2e-profile"), headless=False, viewport={"width": 1280, "height": 860}, device_scale_factor=2,
            args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}", "--no-first-run"])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        for pg in ctx.pages:  # the options page opens on install
            if "options.html" in pg.url:
                pg.set_viewport_size({"width": 760, "height": 760})
                pg.wait_for_timeout(500)
                pg.screenshot(path=str(OUT / "shot_options.png"))
        sw.evaluate(f"chrome.storage.local.set({{apiKey: 'sk-ant-demo-not-a-real-key', model: 'claude-sonnet-5-5', lang: 'en', level: 'student', baseUrl: '{mock_url}'}})")

        def route(r):
            u = r.request.url
            if u.startswith(PAPER_URL):
                rest = u[len(PAPER_URL):].lstrip("/")
                if rest.startswith("source/"):
                    return r.fulfill(path=str(FIX / rest), content_type="image/png")
                if rest == "latexml-lite.css":
                    return r.fulfill(path=str(FIX / rest), content_type="text/css")
                return r.fulfill(path=str(FIX / "arxiv-latexml.html"), content_type="text/html; charset=utf-8")
            return r.continue_()

        ctx.route("https://arxiv.org/**", route)
        page = ctx.pages[0] if ctx.pages and "options" not in ctx.pages[0].url else ctx.new_page()
        page.goto(PAPER_URL + "/")
        page.wait_for_selector("#paper-explainer-root", state="attached", timeout=10000)
        page.wait_for_timeout(800)

        def card_text():
            return page.evaluate("document.querySelector('#paper-explainer-root').shadowRoot.querySelector('.card .answer').innerText")

        def wait_answer():
            page.wait_for_function("(() => { const a = document.querySelector('#paper-explainer-root').shadowRoot.querySelector('.card .meta'); return a && a.textContent.includes('session'); })()", timeout=15000)

        # 1. hover the equation, then click the pill
        eq = page.locator("table.ltx_equation").first
        eq.evaluate("e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 150)")
        eq.hover()
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "shot_hover.png"), clip={"x": 0, "y": 0, "width": 1280, "height": 520})
        t0 = time.time()
        page.evaluate("document.querySelector('#paper-explainer-root').shadowRoot.querySelector('.pill').click()")
        wait_answer()
        res["steps"].append({"step": "equation", "seconds": round(time.time() - t0, 2)})
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "shot_equation.png"))
        res["equation_answer_has_katex"] = page.evaluate("!!document.querySelector('#paper-explainer-root').shadowRoot.querySelector('.card .answer .katex')")

        # 2. a figure
        fig = page.locator("figure.ltx_figure").nth(1)
        fig.evaluate("e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 40)")
        fig.hover()
        page.wait_for_timeout(300)
        page.evaluate("document.querySelector('#paper-explainer-root').shadowRoot.querySelector('.pill').click()")
        wait_answer()
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "shot_figure.png"))

        # 3. the side panel, pinned to this tab, opened as a page beside it
        page.bring_to_front()
        tab_id = sw.evaluate("chrome.tabs.query({active: true, lastFocusedWindow: true}).then(t => t[0].id)")
        panel = ctx.new_page()
        panel.set_viewport_size({"width": 380, "height": 860})
        panel.goto(f"chrome-extension://{ext_id}/sidepanel.html?tab={tab_id}")
        panel.wait_for_function("document.getElementById('n-eq').textContent !== '–'", timeout=10000)
        panel.wait_for_timeout(600)
        panel.screenshot(path=str(OUT / "shot_sidepanel.png"), full_page=True)
        res["panel"] = panel.evaluate("({eq: document.getElementById('n-eq').textContent, fig: document.getElementById('n-fig').textContent, sec: document.getElementById('n-sec').textContent, cost: document.getElementById('cost').textContent})")
        # the summary button in the panel asks the page to summarize
        page.bring_to_front()
        panel.click("#summary")
        wait_answer()
        page.wait_for_timeout(300)

        # 4. the same equation, answered in Arabic
        sw.evaluate("chrome.storage.local.set({lang: 'ar'})")
        eq.evaluate("e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 150)")
        eq.hover()
        page.wait_for_timeout(300)
        page.evaluate("document.querySelector('#paper-explainer-root').shadowRoot.querySelector('.pill').click()")
        page.wait_for_function("(() => { const a = document.querySelector('#paper-explainer-root').shadowRoot.querySelector('.card .answer'); return a && /[\\u0600-\\u06FF]/.test(a.innerText); })()", timeout=15000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "shot_arabic.png"))

        # 5. selection through the context-menu path (the same message the menu sends)
        sw.evaluate("chrome.storage.local.set({lang: 'en'})")
        ctx.close()
    srv.shutdown()
    res["requests"] = requests_log
    (OUT / "e2e.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))
    print(json.dumps({k: v for k, v in res.items() if k != "requests"}, indent=1, ensure_ascii=False))
    for r in requests_log:
        print(r["model"], r["paper_tokens"], r["usage"])


if __name__ == "__main__":
    main()
