"""研修素材のページ（sections/19c_sozai.html の <!--SOZAI-BODY-->）を sozai.json と docs.json から組み立てる（2026-11-02）。

動画は sozai.json に書いた公式の掲載、資料は docs.json の slug を引いて題名・形式・要点のページへの行き先を出す。
説明会・研修会の録画と資料は live.json の library から JS（app.js の library）が足す（ここに無いものだけ）。
"""
import html as H
import json
import pathlib

SRC = pathlib.Path(__file__).resolve().parent
EXT = {"pdf": "PDF", "pptx": "PowerPoint", "ppt": "PowerPoint", "xlsx": "Excel", "xls": "Excel", "docx": "Word", "zip": "Zip"}


def _a(u, t, cls=""):
    c = f' class="{cls}"' if cls else ""
    return f'<a{c} href="{H.escape(u)}" target="_blank" rel="noopener">{H.escape(t)}</a>'


def _size(d):
    ext = d.get("ext", "")
    np = int(d.get("np") or 0)
    if ext == "pdf" and np:
        return f"{np}ページ"
    if ext in ("pptx", "ppt") and np:
        return f"{np}枚"
    return ""


def build():
    """戻り値 (html, 問題の一覧)"""
    z = json.loads((SRC / "sozai.json").read_text(encoding="utf-8"))
    docs = {d["slug"]: d for d in json.loads((SRC / "docs.json").read_text(encoding="utf-8"))["docs"]}
    bad = []

    def doc_line(slug, label="資料"):
        d = docs.get(slug)
        if not d:
            bad.append(f"研修素材: docs.json に無い slug {slug}")
            return ""
        notes = (SRC / "notes" / f"{slug}.json").exists()
        return (f'<p class="sz-l"><span class="sz-lk">{label}</span>{_a(d["u"], d["t"])}'
                + (f'<a class="sz-yo" href="#doc-{H.escape(slug)}">要点</a>' if notes else "") + "</p>")

    nv = nd = 0
    vh = []
    for g in z["videos"]:
        vh.append(f'<h3>{H.escape(g["h"])}</h3>')
        if g.get("lead"):
            vh.append(f'<p class="sz-lead">{H.escape(g["lead"])}</p>')
        vh.append('<ul class="sz-list">')
        for it in g["items"]:
            nv += 1
            row = ['<li class="sz-it">', '<div class="sz-m"><span class="sz-k sz-v">動画</span>'
                   + (f'<span class="sz-len">{H.escape(it["len"])}</span>' if it.get("len") else "") + "</div>",
                   _a(it["u"], it["t"], "sz-t")]
            if it.get("note"):
                row.append(f'<p class="sz-n">{H.escape(it["note"])}</p>')
            if it.get("sub"):
                row.append(f'<details class="sz-sub"><summary>{H.escape(it.get("subh", "内容"))}（{len(it["sub"])}本）</summary><ul>'
                           + "".join(f"<li>{H.escape(s)}</li>" for s in it["sub"]) + "</ul></details>")
            if it.get("alt"):
                row.append('<p class="sz-l">' + "".join(_a(a["u"], a["t"]) for a in it["alt"]) + "</p>")
            if it.get("doc"):
                row.append(doc_line(it["doc"]))
            if it.get("ref"):
                row.append('<p class="sz-r">' + " ".join(f'<span class="ref">{H.escape(r)}</span>' for r in it["ref"]) + "</p>")
            row.append("</li>")
            vh.append("".join(row))
        vh.append("</ul>")
        if g.get("src"):
            vh.append(f'<p class="sz-src">掲載元: {_a(g["src"], "こども家庭庁のページ")}</p>')
    vh.append('<h3 id="sz-arch-vh">説明会・研修会の録画</h3><ul class="sz-list" id="sz-arch-v"></ul>')

    dh = []
    for g in z["docs"]:
        dh.append(f'<h3>{H.escape(g["h"])}</h3><ul class="sz-list">')
        for slug in g["items"]:
            d = docs.get(slug)
            if not d:
                bad.append(f"研修素材: docs.json に無い slug {slug}")
                continue
            nd += 1
            kind = EXT.get(d.get("ext", ""), (d.get("ext") or "").upper())
            size = _size(d)
            notes = (SRC / "notes" / f"{slug}.json").exists()
            dh.append('<li class="sz-it">'
                      f'<div class="sz-m"><span class="sz-k sz-{H.escape(d.get("ext", ""))}">{H.escape(kind)}</span>'
                      + (f'<span class="sz-len">{size}</span>' if size else "") + "</div>"
                      + _a(d["u"], d["t"], "sz-t")
                      + (f'<p class="sz-l"><a class="sz-yo" href="#doc-{H.escape(slug)}">要点を読む</a></p>' if notes else "")
                      + "</li>")
        dh.append("</ul>")
    dh.append('<h3 id="sz-arch-dh">説明会の資料</h3><ul class="sz-list" id="sz-arch-d"></ul>')

    body = ('<div class="seg sz-tabs" role="group" aria-label="動画と資料">'
            f'<button type="button" data-sz="v" aria-pressed="true">動画 <span class="n" id="sz-nv">{nv}</span></button>'
            f'<button type="button" data-sz="d" aria-pressed="false">資料 <span class="n" id="sz-nd">{nd}</span></button></div>'
            '<div class="sz-pane" data-sz-pane="v"><h3 class="sz-ph">動画</h3>' + "\n".join(vh) + "</div>"
            '<div class="sz-pane" data-sz-pane="d"><h3 class="sz-ph">資料</h3>' + "\n".join(dh) + "</div>")
    return body, bad


if __name__ == "__main__":
    b, bad = build()
    print(len(b), bad)
