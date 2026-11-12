"""Charts for the README, from results/e2e.json (the requests the real extension sent)."""
import json
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
E = json.loads((ROOT / "results" / "e2e.json").read_text())
REQ = E["requests"]
VIOLET, PINK, CYAN, INK, DIM = "#7c3aed", "#db2777", "#06b6d4", "#1e1b2e", "#6b6785"
PRICE = {"in": 2.0, "write": 2.5, "read": 0.10, "out": 10.0}  # Sonnet 5.5, USD per million tokens

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 12, "axes.edgecolor": "#c4b5fd", "axes.labelcolor": INK,
                     "xtick.color": DIM, "ytick.color": DIM, "text.color": INK})


def glass_fig(w, h):
    fig = plt.figure(figsize=(w, h))
    bg = fig.add_axes([0, 0, 1, 1], zorder=-10)
    y, x = np.mgrid[0:1:200j, 0:1:300j]
    img = np.ones((200, 300, 3))
    for cx, cy, col, r in [(0.12, 0.85, (0.77, 0.71, 0.99), 0.45), (0.92, 0.7, (0.65, 0.95, 0.99), 0.5), (0.55, 0.05, (0.98, 0.81, 0.91), 0.5)]:
        w_ = np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * (r / 2.2) ** 2))[..., None]
        img = img * (1 - 0.75 * w_) + np.array(col) * 0.75 * w_
    bg.imshow(img, aspect="auto", extent=[0, 1, 0, 1])
    bg.axis("off")
    ax = fig.add_axes([0.1, 0.16, 0.86, 0.72])
    ax.set_facecolor((1, 1, 1, 0.55))
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    return fig, ax


sys_tok = REQ[0]["system_plain_tokens"]  # instructions + reader settings
paper_tok = REQ[0]["paper_tokens"]
q_tok = np.mean([r["usage"]["input_tokens"] for r in REQ])
ANSWER = 350  # tokens: a typical answer under the 250-word limit in the instructions

# 1. ten questions about one paper, against the size of the paper
P = np.linspace(1000, 40000, 80)
n = 10
no_cache = n * ((P + sys_tok + q_tok) * PRICE["in"] + ANSWER * PRICE["out"]) / 1e6
cache = ((P + sys_tok) * PRICE["write"] + (n - 1) * (P + sys_tok) * PRICE["read"] + n * q_tok * PRICE["in"] + n * ANSWER * PRICE["out"]) / 1e6
fig, ax = glass_fig(9.5, 4.8)
ax.plot(P / 1000, no_cache, color=PINK, lw=3, label="without prompt caching")
ax.plot(P / 1000, cache, color=VIOLET, lw=3, label="with the paper cached (this extension)")
ax.fill_between(P / 1000, cache, no_cache, color=VIOLET, alpha=0.08)
for x in (12, 30):
    i = np.argmin(abs(P - x * 1000))
    ax.annotate(f"\\${no_cache[i]:.3f} → \\${cache[i]:.3f}\n({no_cache[i] / cache[i]:.1f}× cheaper)", (x, cache[i]), xytext=(x - 6, no_cache[i] * 0.78),
                arrowprops=dict(arrowstyle="->", color=DIM), fontsize=10.5, color=INK)
ax.set_xlabel("paper length sent as context (thousand tokens)")
ax.set_ylabel("USD for 10 questions, Sonnet 5.5")
ax.legend(frameon=False, loc="upper left")
fig.savefig(ROOT / "results" / "fig_cache.png", dpi=170)
plt.close(fig)

# 2. what the extension actually sent, request by request (from the browser run)
labels = ["equation (EN)", "Figure 2", "summary", "equation (AR)"][: len(REQ)]
fig, ax = glass_fig(9.5, 4.2)
ax.set_position([0.17, 0.16, 0.79, 0.7])
y = np.arange(len(REQ))[::-1]
w = [r["usage"]["cache_creation_input_tokens"] for r in REQ]
rd = [r["usage"]["cache_read_input_tokens"] for r in REQ]
q = [r["usage"]["input_tokens"] for r in REQ]
o = [r["usage"]["output_tokens"] for r in REQ]
left = np.zeros(len(REQ))
for vals, col, lab in [(w, PINK, "instructions + paper, written to cache"), (rd, CYAN, "instructions + paper, read from cache"), (q, VIOLET, "the question"), (o, "#a78bfa", "the answer")]:
    ax.barh(y, vals, left=left, color=col, height=0.55, label=lab, edgecolor="white")
    left += np.array(vals)
for yy, r in zip(y, REQ):
    u = r["usage"]
    usd = (u["input_tokens"] * PRICE["in"] + u["cache_creation_input_tokens"] * PRICE["write"] + u["cache_read_input_tokens"] * PRICE["read"] + u["output_tokens"] * PRICE["out"]) / 1e6
    tot = sum(u.values())
    ax.text(tot + 25, yy, f"\\${usd:.4f}", va="center", fontsize=10.5)
ax.set_yticks(y)
ax.set_yticklabels(labels)
ax.set_xlabel("tokens")
ax.set_xlim(0, max(left) * 1.25)
ax.legend(frameon=False, fontsize=9.5, loc="lower right", ncol=2, bbox_to_anchor=(1, 1.0))
fig.savefig(ROOT / "results" / "fig_requests.png", dpi=170)
plt.close(fig)
print({"system": sys_tok, "paper": paper_tok, "q_mean": round(q_tok), "at12k": [round(no_cache[np.argmin(abs(P - 12000))], 4), round(cache[np.argmin(abs(P - 12000))], 4)]})
