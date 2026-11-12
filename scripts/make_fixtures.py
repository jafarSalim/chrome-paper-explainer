"""Builds the two test pages from a real LaTeX paper (test/fixtures/source/main.tex).

sample-pandoc.html   pandoc --mathml output, unchanged: MathML with <annotation encoding="application/x-tex">.
arxiv-latexml.html   the same document re-shaped into the markup that LaTeXML writes for arXiv HTML and ar5iv:
                     ltx_* classes (from LaTeXML's XSLT), <math alttext="..."> (from LaTeXML/Post/MathML.pm),
                     equation tables with (n) tags, "Figure n:" caption tags. arXiv itself is not reachable from
                     the machine these tests were built on, so this is a faithful imitation, not a download.
"""
import pathlib
import re
import subprocess

from bs4 import BeautifulSoup

FIX = pathlib.Path(__file__).resolve().parents[1] / "test" / "fixtures"
SRC = FIX / "source"

html = subprocess.run(["pandoc", "main.tex", "-s", "--mathml", "--citeproc", "--bibliography", "refs.bib", "--metadata", "lang=en"], cwd=SRC, capture_output=True, text=True, check=True).stdout
html = re.sub(r'<img src="([a-z_]+)"', r'<img src="source/figures/\1.png"', html)
(FIX / "sample-pandoc.html").write_text(html)

soup = BeautifulSoup(html, "html.parser")
body = soup.body
out = BeautifulSoup('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title></title>'
                    '<link rel="stylesheet" href="latexml-lite.css"></head><body><div class="ltx_page_main">'
                    '<div class="ltx_page_content"><article class="ltx_document"></article></div></div></body></html>', "html.parser")
art = out.article
title = soup.find("h1", class_="title")
out.title.string = title.get_text(" ", strip=True)
h1 = out.new_tag("h1", attrs={"class": "ltx_title ltx_title_document"})
h1.string = title.get_text(" ", strip=True)
art.append(h1)

math_n = 0


def ltx_math(m, prefix):
    global math_n
    math_n += 1
    ann = m.find("annotation", attrs={"encoding": "application/x-tex"})
    tex = ann.get_text().strip() if ann else ""
    m["class"] = "ltx_Math"
    m["alttext"] = tex
    m["id"] = f"{prefix}.m{math_n}"
    m["display"] = m.get("display", "inline")
    return m


def para(p, sid, k):
    for m in p.find_all("math"):
        ltx_math(m, f"{sid}.p{k}")
    for a in p.find_all("a", attrs={"data-reference-type": "ref"}):
        a["class"] = "ltx_ref"
        a.attrs.pop("data-reference-type", None)
        a.attrs.pop("data-reference", None)
    div = out.new_tag("div", attrs={"id": f"{sid}.p{k}", "class": "ltx_para"})
    p.name = "p"
    p["class"] = "ltx_p"
    div.append(p)
    return div


abs_div = soup.find("div", class_="abstract")
a = out.new_tag("div", attrs={"class": "ltx_abstract"})
h6 = out.new_tag("h6", attrs={"class": "ltx_title ltx_title_abstract"})
h6.string = "Abstract"
a.append(h6)
for p in abs_div.find_all("p"):
    for m in p.find_all("math"):
        ltx_math(m, "abstract")
    p["class"] = "ltx_p"
    a.append(p)
art.append(a)

sec = None
sec_n = eq_n = fig_n = tab_n = 0
k = 0
for el in list(body.children):
    if getattr(el, "name", None) is None or el.name in ("header",) or (el.name == "div" and "abstract" in (el.get("class") or [])):
        continue
    if el.name == "h1" and "title" not in (el.get("class") or []):
        sec_n += 1
        k = 0
        sec = out.new_tag("section", attrs={"id": f"S{sec_n}", "class": "ltx_section"})
        h2 = out.new_tag("h2", attrs={"class": "ltx_title ltx_title_section"})
        tag = out.new_tag("span", attrs={"class": "ltx_tag ltx_tag_section"})
        tag.string = f"{sec_n} "
        h2.append(tag)
        h2.append(el.get_text(" ", strip=True))
        sec.append(h2)
        art.append(sec)
        continue
    if sec is None:
        continue
    sid = f"S{sec_n}"
    if el.name == "p":
        blocks = el.find_all("math", attrs={"display": "block"})
        if blocks:
            # split the paragraph around display math into para / equation table / para
            for m in blocks:
                eq_n += 1
                before = BeautifulSoup("", "html.parser").new_tag("p")
                for node in list(el.contents):
                    if node is m:
                        break
                    before.append(node.extract())
                if before.get_text(strip=True):
                    k += 1
                    sec.append(para(before, sid, k))
                t = out.new_tag("table", attrs={"id": f"{sid}.E{eq_n}", "class": "ltx_equation ltx_eqn_table"})
                tr = out.new_tag("tr", attrs={"class": "ltx_equation ltx_eqn_row ltx_align_baseline"})
                td = out.new_tag("td", attrs={"class": "ltx_eqn_cell ltx_align_center"})
                td.append(ltx_math(m.extract(), f"{sid}.E{eq_n}"))
                no = out.new_tag("td", attrs={"class": "ltx_eqn_cell ltx_eqn_eqno ltx_align_middle ltx_align_right"})
                tg = out.new_tag("span", attrs={"class": "ltx_tag ltx_tag_equation ltx_align_right"})
                tg.string = f"({eq_n})"
                no.append(tg)
                tr.append(td)
                tr.append(no)
                t.append(tr)
                sec.append(t)
            rest = el
            if rest.get_text(strip=True):
                k += 1
                sec.append(para(rest, sid, k))
        else:
            k += 1
            sec.append(para(el, sid, k))
    elif el.name == "figure":
        fig_n += 1
        cap = el.find("figcaption")
        f = out.new_tag("figure", attrs={"id": f"{sid}.F{fig_n}", "class": "ltx_figure"})
        img = el.find("img")
        if img:
            img["class"] = "ltx_graphics ltx_centering"
            img["alt"] = "Refer to caption"
            img["width"] = "520"
            f.append(img)
        fc = out.new_tag("figcaption", attrs={"class": "ltx_caption ltx_centering"})
        tg = out.new_tag("span", attrs={"class": "ltx_tag ltx_tag_figure"})
        tg.string = f"Figure {fig_n}: "
        fc.append(tg)
        fc.append(cap.get_text(" ", strip=True) if cap else "")
        f.append(fc)
        sec.append(f)
    elif el.name == "div" and el.find("table"):
        tab_n += 1
        tb = el.find("table")
        cap = tb.find("caption")
        f = out.new_tag("figure", attrs={"id": f"{sid}.T{tab_n}", "class": "ltx_table"})
        fc = out.new_tag("figcaption", attrs={"class": "ltx_caption ltx_centering"})
        tg = out.new_tag("span", attrs={"class": "ltx_tag ltx_tag_table"})
        tg.string = f"Table {tab_n}: "
        fc.append(tg)
        fc.append(cap.get_text(" ", strip=True) if cap else "")
        if cap:
            cap.decompose()
        for m in tb.find_all("math"):
            ltx_math(m, f"{sid}.T{tab_n}")
        tb["class"] = "ltx_tabular ltx_centering"
        f.append(fc)
        f.append(tb.extract())
        sec.append(f)

html2 = str(out)
html2 = re.sub(r'\s+xmlns="http://www.w3.org/1998/Math/MathML"', ' xmlns="http://www.w3.org/1998/Math/MathML"', html2)
(FIX / "arxiv-latexml.html").write_text(html2)
print("equations", eq_n, "figures", fig_n, "tables", tab_n, "sections", sec_n, "inline+display math", math_n)
