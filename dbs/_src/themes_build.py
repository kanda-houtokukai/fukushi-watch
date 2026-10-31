"""テーマのページ（themes.json）と、横断検索の章の索引を組み立てる（build.py から呼ぶ）。

テーマのページは本文の事実を持たない。章の「リード」「この章の要点」と図、Q&A、資料、
事業別の要点（17_sectors の data-th）を集めて並べるだけにする。章や Q&A が直れば、
テーマのページも組み立て直すだけで同じ内容になる（毎朝の更新タスクは themes.json を触らない）。
"""
import html as H
import json, pathlib, re, subprocess

SRC = pathlib.Path(__file__).resolve().parent
OUT = SRC.parent

CHAP = [(r"総論", "制度全般"), (r"定義", "定義"), (r"対象事業", "対象事業"), (r"認定", "認定"), (r"犯罪事実確認", "確認の手続"),
        (r"防止措置", "防止措置"), (r"安全確保措置", "安全確保措置"), (r"情報管理", "情報管理"), (r"監督", "監督・報告"), (r"その他", "その他")]
PART = {"基礎編": "k", "応用編": "o", "まとめ登録": "m"}
TOOLS = {"tool-scope": ("この事業は対象？", "義務・認定・対象外を判定"), "tool-persons": ("この人は対象？", "職種・立場と3要件で判定"),
         "tool-timing": ("いつまでに確認？", "新規・現職者・異動・いとま特例"), "tool-incident": ("どこへ通報？", "施設の種類ごとの通報・通告先")}
EXTL = {"pdf": "PDF", "docx": "Word", "xlsx": "Excel", "pptx": "PowerPoint", "zip": "Zip"}
# 横断検索の索引に入れない面（毎朝のデータで書かれる面・一覧の面・Q&A は別に探す）
NOINDEX = {"home", "qa", "updates", "sources", "materials", "doc", "law", "events", "tools", "checklist", "themes", "search"}


# テーマ一覧と探すのページ（sections/ に置かない。章の照合の単位に入れないため）
INDEX_VIEW = """<section class="chapter view" id="themes" data-group="themes" data-title="テーマ一覧">
  <header>
    <div class="ch-no">テーマ</div>
    <h2>テーマから探す</h2>
  </header>
  <!--THEME-LIST-->
</section>"""
SEARCH_VIEW = """<section class="chapter view" id="search" data-group="search" data-title="探す" data-hidden="1">
  <header>
    <h2>探す</h2>
  </header>
  <form class="sx-form" id="sx-form" role="search">
    <label class="sr" for="sx-q">質問や言葉で探す</label>
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m12.6 12.6 4.4 4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
    <input type="search" id="sx-q" placeholder="例：送迎　実習生　育休　派遣　内定" autocomplete="off" enterkeyhint="search">
    <button type="submit">探す</button>
  </form>
  <div class="sx-scope" id="sx-scope" role="group" aria-label="探す範囲" hidden></div>
  <p class="sx-sum" id="sx-sum" aria-live="polite"></p>
  <div class="sx-hint" id="sx-hint">
    <p class="sx-hl">よく探される言葉</p>
    <div class="chips" id="sx-words"></div>
  </div>
  <div id="sx-res"></div>
</section>"""


def plain(s):
    s = re.sub(r"<(svg|script|style)[\s\S]*?</\1>", " ", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", H.unescape(s)).strip()


def first_line(a_html, cap=150):
    """答えの書き出し（1文。短いときは2文）。根拠の札は除く"""
    t = re.sub(r'<a class="rf"[\s\S]*?</a>|<span class="ref">[\s\S]*?</span>', "", a_html)
    t = re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", t))).strip()
    t = re.sub(r"(?<=[^\x00-\x7f]) (?=[^\x00-\x7f])", "", t)
    ss = [x for x in re.split(r"(?<=。)", t) if x.strip()]
    if not ss:
        return ""
    out = ss[0].strip()
    if len(out) < 45 and len(ss) > 1:
        out += ss[1].strip()
    return out if len(out) <= cap else out[:cap].rstrip("、") + "…"


def guide_qa(data_js):
    js = ("const vm=require('vm');const fs=require('fs');const c={};c.window=c;vm.createContext(c);"
          "vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),c);process.stdout.write(JSON.stringify(c.GUIDE_DATA.qa||[]));")
    return json.loads(subprocess.run(["node", "-e", js, str(data_js)], capture_output=True, text=True, check=True).stdout)


def all_qa():
    """Q&A のページと同じ並び・同じ分類（app.js の qa() と同じ決め方）"""
    items = []
    for i, q in enumerate(guide_qa(SRC / "data.js")):
        c = list(q["cat"])
        if "研修" in q["q"] and "研修" not in c:
            c.append("研修")
        items.append({"key": "qa-%d" % (i + 1), "kind": "mat", "label": "資料から回答", "q": q["q"], "a": q["a"], "cat": c})
    for q in json.loads((OUT / "qa_mat.json").read_text(encoding="utf-8")):
        c = list(q["cat"])
        if "研修" in q["q"] and "研修" not in c:
            c.append("研修")
        items.append({"key": "qm-" + q["id"], "kind": "mat", "label": "資料から回答", "q": q["q"], "a": q["a"], "cat": c})
    for o in json.loads((OUT / "qa_official.json").read_text(encoding="utf-8")):
        cat = []
        if o["doc"] == "qa-matome":
            cat.append("システム")
        else:
            for pat, c in CHAP:
                if re.search(pat, o.get("chap") or ""):
                    cat.append(c)
                    break
        if "研修" in o["q"] + "".join(o["a"]) and "研修" not in cat:
            cat.append("研修")
        label = ("まとめ登録" if o["part"] == "まとめ登録" else o["part"]) + o["no"]
        items.append({"key": "qo-" + PART.get(o["part"], "x") + o["no"], "kind": "off", "label": "公式Q&A " + label,
                      "q": o["q"], "a": "".join("<p>" + H.escape(p) + "</p>" for p in o["a"]), "cat": cat})
    return items


def in_theme(q, t):
    return any(c in t.get("cats", []) for c in q["cat"]) or bool(t.get("re") and re.search(t["re"], q["q"]))


def build(parts, ctx, ref_html, kenshu_body):
    """parts（章の HTML の並び）を書き換え、(parts, js, 問題の一覧) を返す"""
    bad = []
    conf = json.loads((SRC / "themes.json").read_text(encoding="utf-8"))
    themes = conf["themes"]
    tid = {t["id"]: t for t in themes}
    whole = "\n".join(parts)

    # ── 章の見出し（h3）に行き先の id を付ける。章の一覧（id → 題・HTML）
    # 章のファイルは1つの章（view）だけを持つ（資料の面 22_docs とホームは索引に入れない）
    chap = {}
    newparts = []
    for p in parts:
        m = re.search(r'<section class="([^"]*)" id="([^"]+)"[^>]*data-title="([^"]*)"', p)
        if m and "view" in m.group(1).split():
            vid = m.group(2)
            if "chapter" in m.group(1).split() and vid not in NOINDEX:
                n = [0]
                def h3(mm):
                    n[0] += 1
                    return '<h3 id="%s-h%d"%s>' % (vid, n[0], mm.group(1))
                p = re.sub(r"<h3((?:(?!\bid=)[^>])*)>", h3, p)
            chap[vid] = {"t": H.unescape(m.group(3)), "html": p}
        newparts.append(p)
    parts = newparts
    if "kenshu" in chap:
        chap["kenshu"]["html"] = kenshu_body

    # ── Q&A と件数
    qa = all_qa()
    qby = {q["key"]: q for q in qa}

    # ── 事業別の要点（17_sectors の li[data-th]）
    sectors = []
    sh = chap.get("sectors", {}).get("html", "")
    labels = dict(re.findall(r'aria-controls="sec-([a-z]+)">([^<]+)</button>', sh))
    for m in re.finditer(r'<div class="pane card[^"]*" id="sec-([a-z]+)"[^>]*>\s*<h4>([\s\S]*?)</h4>([\s\S]*?)</div>', sh):
        k, h4, body = m.groups()
        items = [{"th": th.split(), "h": li.strip()} for th, li in re.findall(r'<li data-th="([^"]*)">([\s\S]*?)</li>', body)]
        if not items:
            continue
        for it in items:
            for x in it["th"]:
                if x not in tid:
                    bad.append(f"事業別の要点の印が、テーマにありません: {x}（sec-{k}）")
        sectors.append({"k": k, "t": labels.get(k, k), "h": plain(re.sub(r'<span class="pill[\s\S]*?</span>', "", h4)), "items": items})

    # ── 章の図を取り出す（id は付け替える。隠れた章の矢印の印を指さないように）
    def figure(vid, n, pre):
        figs = re.findall(r"<figure[\s\S]*?</figure>", chap.get(vid, {}).get("html", ""))
        if n >= len(figs):
            bad.append(f"テーマ {pre}: 章 {vid} に {n} 番目の図がありません")
            return ""
        f = figs[n]
        ids = re.findall(r'\sid="([^"]+)"', f)
        for i in ids:
            f = re.sub(r'(\sid="|url\(#|href="#)' + re.escape(i) + r'(?=["\)])', lambda mm: mm.group(1) + "t" + pre + "-" + i, f)
        return f

    def points(t):
        lis = []
        for src in t.get("points", []):
            if src.startswith("kenshu:"):
                path = src.split(":", 1)[1].split(".")
                kj = json.loads((SRC / "kenshu.json").read_text(encoding="utf-8"))
                sec = [s for s in kj["sections"] if s["id"] == path[0]]
                try:
                    b = sec[0]["blocks"][int(path[1])]
                    if len(path) >= 4 and path[2] == "li":
                        x = b["items"][int(path[3])]
                        txt, refs = x["x"], x.get("ref", [])
                    else:
                        txt, refs = b["x"], b.get("ref", [])
                        if len(path) == 3:
                            ss = [s for s in re.split(r"(?<=。)", txt) if s]
                            txt = ss[int(path[2])]
                except (IndexError, KeyError, ValueError):
                    bad.append(f"テーマ {t['id']}: 要点の行き先が kenshu.json にありません: {src}")
                    continue
                lis.append("<li>" + H.escape(txt) + " " + " ".join(ref_html(r, ctx) for r in refs) + "</li>")
            else:
                m = re.search(r'<div class="points">[\s\S]*?<ol>([\s\S]*?)</ol>', chap.get(src, {}).get("html", ""))
                if not m:
                    bad.append(f"テーマ {t['id']}: 章 {src} に「この章の要点」がありません")
                    continue
                lis += re.findall(r"<li>[\s\S]*?</li>", m.group(1))
        return lis

    def lead(t):
        for vid in t.get("ch", [])[:1]:
            if vid == "kenshu":
                kj = json.loads((SRC / "kenshu.json").read_text(encoding="utf-8"))
                return '<p class="ch-lead">' + H.escape(kj.get("lead", "")) + "</p>"
            m = re.search(r'<p class="ch-lead">[\s\S]*?</p>', chap.get(vid, {}).get("html", ""))
            if m:
                return m.group(0)
        return ""

    def faq_item(key, theme):
        q = qby.get(key)
        if not q:
            bad.append(f"テーマ {theme}: よく聞かれることの Q&A がありません: {key}")
            return ""
        return ('<li><a href="#' + key + '"><span class="tq">' + H.escape(q["q"]) + '</span><span class="ta">' + H.escape(first_line(q["a"]))
                + '</span><span class="tk' + (" off" if q["kind"] == "off" else "") + '">' + H.escape(q["label"]) + "</span></a></li>")

    docs = ctx["docs"]
    see = json.loads((SRC / "see.json").read_text(encoding="utf-8")) if (SRC / "see.json").exists() else {}
    vid_of = {}
    for f in (SRC / "sections").glob("*.html"):
        m = re.search(r'<section[^>]*\bid="([^"]+)"', f.read_text(encoding="utf-8"))
        if m:
            vid_of[m.group(1)] = f.stem.replace(".tpl", "")

    def doc_li(slug, theme):
        d = docs.get(slug)
        if not d:
            bad.append(f"テーマ {theme}: 資料がありません: {slug}")
            return ""
        meta = "・".join(x for x in [(d.get("d", "")[:4] + "." + d.get("d", "")[4:6] + "." + d.get("d", "")[6:8]) if len(d.get("d", "")) == 8 else "",
                                     EXTL.get(d.get("ext", ""), "")] if x)
        if d["mode"] == "skip":
            return ('<li class="is-ext"><a href="' + H.escape(d["u"]) + '" target="_blank" rel="noopener"><span class="tt">' + H.escape(d["t"])
                    + '</span><span class="tm">' + H.escape(meta) + "</span></a></li>")
        href = "#law-" + d["law"] if d["mode"] == "law" else ("#qa" if d["mode"] == "qa" else "#doc-" + slug)
        return '<li><a href="' + href + '"><span class="tt">' + H.escape(d["t"]) + '</span><span class="tm">' + H.escape(meta) + "</span></a></li>"

    counts = {}
    views = []
    for t in themes:
        mine = [q for q in qa if in_theme(q, t)]
        n_off = sum(1 for q in mine if q["kind"] == "off")
        counts[t["id"]] = (len(mine), len(mine) - n_off, n_off)
        h = ['<section class="chapter view theme" id="t-%s" data-group="themes" data-title="%s">' % (t["id"], H.escape(t["name"])),
             '  <header>\n    <div class="ch-no">テーマ</div>\n    <h2>%s</h2>\n    %s\n  </header>' % (H.escape(t["name"]), lead(t)),
             ]
        pts = points(t)
        if pts:
            long = any(x.startswith("kenshu:") for x in t.get("points", []))   # 文のままの要点は太字にしない
            h.append('  <div class="points"><span class="pt">要点</span><ol' + (' class="pl"' if long else "") + ">" + "".join(pts) + "</ol></div>")
        h.append('  <div class="th-sec" data-th="%s"></div>' % t["id"])   # 選んだ事業の注意点（app.js が入れる）
        if t.get("tools"):
            h.append('  <div class="th-tools">' + "".join('<a class="tile" href="#%s"><b>%s</b><span>%s</span></a>' % (k, TOOLS[k][0], TOOLS[k][1]) for k in t["tools"]) + "</div>")
        for vid, n in t.get("fig", []):
            h.append("  " + figure(vid, n, t["id"]))
        if t.get("faq"):
            h.append('  <section class="th-b" aria-labelledby="t-%s-faq"><h3 id="t-%s-faq">よく聞かれること</h3><ul class="th-qa">' % (t["id"], t["id"])
                     + "".join(faq_item(k, t["id"]) for k in t["faq"]) + "</ul>"
                     + '<a class="th-all" href="#qa~%s"><b>%sのQ&amp;A %d件をすべて見る</b><small>資料から回答 %d・公式Q&amp;A %d</small></a></section>'
                     % (t["id"], H.escape(t["name"]), counts[t["id"]][0], counts[t["id"]][1], counts[t["id"]][2]))
        if t.get("ch"):
            rd = []
            for vid in t["ch"]:
                c = chap.get(vid)
                if not c:
                    bad.append(f"テーマ {t['id']}: 章がありません: {vid}")
                    continue
                hs = re.findall(r'<h3 id="([^"]+)"[^>]*>([\s\S]*?)</h3>', c["html"])
                rd.append('<div class="th-ch"><a class="th-chl" href="#%s"><b>%s</b><small>章を開く</small></a>' % (vid, H.escape(c["t"]))
                          + ('<ul>' + "".join('<li><a href="#%s">%s</a></li>' % (i, H.escape(plain(re.sub(r'<span class="ref">[\s\S]*?</span>', "", x)))) for i, x in hs) + "</ul>" if hs else "")
                          + "</div>")
            if rd:
                h.append('  <section class="th-b" aria-labelledby="t-%s-read"><h3 id="t-%s-read">くわしく読む</h3>' % (t["id"], t["id"]) + "".join(rd) + "</section>")
        dl = [doc_li(s, t["id"]) for s in t.get("docs", [])]
        seen = set()
        for vid in t.get("ch", []):
            notes_ctx = ctx["notes"]
            for l in see.get(vid_of.get(vid, ""), []):
                its = {it["k"]: it for it in notes_ctx.get(l["doc"], [])}
                if l["k"] in its and (l["doc"], l["k"]) not in seen and len(seen) < 8:
                    seen.add((l["doc"], l["k"]))
                    d = docs.get(l["doc"], {})
                    dl.append('<li><a href="#doc-%s~%s"><span class="tt">%s</span><span class="tm">%s</span></a></li>'
                              % (l["doc"], H.escape(l["k"]), H.escape(its[l["k"]]["t"]), H.escape(d.get("t", ""))))
        if any(dl):
            h.append('  <section class="th-b" aria-labelledby="t-%s-docs"><h3 id="t-%s-docs">様式と資料</h3><ul class="th-dl">' % (t["id"], t["id"]) + "".join(dl) + "</ul></section>")
        if t.get("rel"):
            h.append('  <div class="th-rel"><span>関連するテーマ</span>' + "".join('<a href="#t-%s">%s</a>' % (r, H.escape(tid[r]["name"])) for r in t["rel"] if r in tid) + "</div>")
        h.append("</section>")
        views.append("\n".join(h))

    # ── テーマの一覧（ホームとテーマ一覧のページ）
    lst = ['<div class="th-list">']
    for g in conf["groups"]:
        ts = [t for t in themes if t["g"] == g["k"]]
        lst.append('<div class="th-g"><p class="th-gl">%s</p><ul>' % H.escape(g["t"]))
        for t in ts:
            lst.append('<li><a href="#t-%s"><span class="tn"><b>%s</b><small>%s</small></span><span class="tc">Q&amp;A %d</span></a></li>'
                       % (t["id"], H.escape(t["name"]), H.escape(t["sub"]), counts[t["id"]][0]))
        lst.append("</ul></div>")
    lst.append("</div>")
    list_html = "".join(lst)
    block = (INDEX_VIEW.replace("<!--THEME-LIST-->", list_html) + "\n" + "\n".join(views) + "\n" + SEARCH_VIEW)
    parts = [p.replace("<!--THEME-LIST-->", list_html).replace("<!--THEMES-->", block) for p in parts]
    for ph in ("<!--THEMES-->", "<!--THEME-LIST-->"):
        if ph not in whole:
            bad.append(f"テーマを入れる場所（{ph}）がありません")

    # ── 横断検索の章の索引（notes/chapters.json）
    idx = []
    for vid, c in chap.items():
        if vid in NOINDEX or vid.startswith("t-"):
            continue
        body = c["html"]
        if vid == "sectors":
            for m in re.finditer(r'<div class="pane card[^"]*" id="(sec-[a-z]+)"[^>]*>\s*<h4>([\s\S]*?)</h4>([\s\S]*?)</div>', body):
                idx.append({"v": vid, "vt": c["t"], "h": plain(re.sub(r'<span class="pill[\s\S]*?</span>', "", m.group(2))), "a": m.group(1), "x": plain(m.group(3))})
            body = re.sub(r'<div class="tabs"[\s\S]*?</div>\s*</div>\s*(?=<details|<h3)', "", body)
        segs = re.split(r'(<h3 id="[^"]+"[^>]*>[\s\S]*?</h3>)', body)
        cur_h, cur_a = "", vid
        for s in segs:
            m = re.match(r'<h3 id="([^"]+)"[^>]*>([\s\S]*?)</h3>', s)
            if m:
                cur_a, cur_h = m.group(1), plain(re.sub(r'<span class="ref">[\s\S]*?</span>', "", m.group(2)))
                continue
            x = plain(s)
            if x:
                idx.append({"v": vid, "vt": c["t"], "h": cur_h, "a": cur_a, "x": x})
    (OUT / "notes" / "chapters.json").write_text(json.dumps(idx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    js = "GUIDE_DATA.themes = " + json.dumps([{"id": t["id"], "name": t["name"], "cats": t.get("cats", []), "re": t.get("re", "")} for t in themes], ensure_ascii=False) + ";\n"
    js += "GUIDE_DATA.sectors = " + json.dumps(sectors, ensure_ascii=False) + ";\n"
    return parts, js, bad, {"themes": len(themes), "chapters_index": len(idx)}
