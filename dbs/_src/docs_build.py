"""資料を読む（見出しごとの要点）・法令の条文・公式Q&A のデータを組み立てる（build.py から呼ぶ）。

入力（dbs/_src/）:
  docs.json            … 資料の台帳（groups・docs。mode: notes＝要点を載せる／qa＝公式Q&A（原文）／skip＝載せない理由つき）
  notes/<資料>.json     … 照合係2人が合格とした要点だけ（[{k,t,lv,p,pe,par,g,pts}]）
  law.json             … 法令の条文（e-Gov の XML から作ったもの）
  qa_official.json     … 公式Q&A の原文（PDF から機械で取り出し、原文と1字ずつ一致を確かめたもの）
出力（dbs/）:
  notes/<資料>.json・notes/search.json・law.json・qa_official.json（画面が開いたときに読む）
"""
import json, pathlib, re

SRC = pathlib.Path(__file__).resolve().parent
OUT = SRC.parent
BAN = re.compile(r"まだ|(?<![ぁ-ん])いま(?![すせしそ])|今すぐ|いますぐ")
CREDIT = ("要点はこのガイドが資料をもとに作成したものです。こども家庭庁の資料は「公共データ利用規約（第1.0版）」により、"
          "出典を示して加工・利用しています（出典：こども家庭庁「こども性暴力防止法」のページの各資料）。"
          "弁護士・大学教員などが作成した資料は、作成者の著作物のため要点だけを載せています。")
LAW_ALIAS = {"law-pdf": "ho", "rei-pdf": "rei", "kisoku-pdf": "kisoku"}


def spaces(s):
    """PDF の組版で入る、和文と英数字のあいだの半角空白を取る"""
    return re.sub(r"(?<=[^\x00-\x7f]) (?=[0-9A-Za-z(])|(?<=[0-9A-Za-z)]) (?=[^\x00-\x7f])", "", s)


NOTES = {}
SHORT = {"gl": "GL", "tebiki": "研修の手引き", "kenshu": "研修資料", "ensyu-j": "演習資料（従事者）", "ensyu-k": "演習資料（事業者）",
         "junbi": "準備ガイド", "junbi-ref": "準備ガイド参考資料", "kaisetsu": "解説資料", "setsumei": "全国説明会資料", "gaiyo": "概要",
         "tebiki-keikaku": "研修実施計画書", "tebiki-kiroku": "研修受講記録", "test-j": "確認テスト（従事者）", "test-k": "確認テスト（事業者）"}


def ref_html(r, ctx):
    """根拠の札（資料の要点へ行く）。{"doc":"gl","p":123} / {"doc":"qa","no":"基礎5-3"}"""
    import html as H
    if r.get("doc") == "qa":
        no = r.get("no", "")
        key = ("k" if no.startswith("基礎") else "o" if no.startswith("応用") else "m") + re.sub(r"^(基礎|応用|まとめ登録)", "", no)
        return f'<a class="rf" href="#qo-{key}">Q&amp;A{H.escape(no)}</a>'
    d = ctx["docs"].get(r.get("doc"), {})
    p = int(r.get("p", 0) or 0)
    lab = SHORT.get(r.get("doc"), d.get("t", r.get("doc", ""))[:12]) + " p." + str(p + d.get("poff", 0))
    best = None
    for it in ctx["notes"].get(r.get("doc"), []):
        if it.get("p") and it["p"] <= p <= (it.get("pe") or it["p"]):
            if best is None or (it.get("pe", it["p"]) - it["p"]) <= (best.get("pe", best["p"]) - best["p"]):
                best = it
    href = f'#doc-{r["doc"]}~{best["k"]}' if best else (f'{d.get("u", "")}#page={p}' if d.get("u") else "")
    tgt = '' if href.startswith("#") else ' target="_blank" rel="noopener"'
    return f'<a class="rf" href="{H.escape(href)}"{tgt}>{H.escape(lab)}</a>' if href else f'<span class="rf">{H.escape(lab)}</span>'


def chapter_html(path, ctx):
    """照合済みの章（kenshu.json など）を HTML にする。戻り値 (lead, body)"""
    import html as H
    c = json.loads(path.read_text(encoding="utf-8"))
    def refs(x):
        return " ".join(ref_html(r, ctx) for r in x.get("ref", []))
    def txt(x):
        return H.escape(x["x"]) + (" " + refs(x) if x.get("ref") else "")
    body = []
    for sec in c["sections"]:
        body.append(f'<h3 id="{sec["id"]}">{H.escape(sec["h"])}</h3>')
        for b in sec["blocks"]:
            if b["t"] == "p":
                body.append(f'<p class="prose">{txt(b)}</p>')
            elif b["t"] == "note":
                body.append(f'<div class="box note"><p>{txt(b)}</p></div>')
            elif b["t"] == "ul":
                body.append('<div class="prose"><ul>' + "".join(f"<li>{txt(i)}</li>" for i in b["items"]) + "</ul></div>")
            elif b["t"] == "table":
                head = "".join(f"<th>{H.escape(h)}</th>" for h in b.get("head", []))
                rows = "".join("<tr>" + "".join((f"<th>{txt(cell)}</th>" if j == 0 else f"<td>{txt(cell)}</td>") for j, cell in enumerate(row)) + "</tr>" for row in b["rows"])
                body.append(f'<div class="scroll"><table class="tbl"><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>')
            elif b["t"] == "fig":
                if b.get("svg"):
                    cap = f'<figcaption><b>{H.escape(b["cap"])}</b></figcaption>' if b.get("cap") else ""
                    body.append(f'<figure class="fig"><div class="canvas">{b["svg"]}</div>{cap}</figure>')
                else:
                    body.append(b["html"])
    return f'<p class="ch-lead">{H.escape(c.get("lead", ""))}</p>', "\n".join(body)


def build(strict=True):
    book = json.loads((SRC / "docs.json").read_text(encoding="utf-8"))
    bad, docs, search = [], [], []
    ndir = OUT / "notes"
    ndir.mkdir(exist_ok=True)
    keep = set()
    laws = json.loads((SRC / "law.json").read_text(encoding="utf-8"))
    seen_kaisai = False
    for d in book["docs"]:
        d = dict(d)
        if d["slug"] in LAW_ALIAS:
            law = [x for x in laws if x["slug"] == LAW_ALIAS[d["slug"]]][0]
            d.update(mode="law", law=law["slug"], t=law["short"] + "（" + law["num"] + "）")
            d.pop("memo", None)
        if d["slug"].startswith("kaisai-"):
            if seen_kaisai:
                continue
            seen_kaisai = True
            d.update(t="全国説明会 開催日程（会場ごとの案内12点）", u="https://www.cfa.go.jp/policies/child-safety/efforts/koseibouhou/information-session-r8", ext="", np=0)
        if d["mode"] == "notes":
            f = SRC / "notes" / f"{d['slug']}.json"
            if not f.exists():
                if strict:
                    bad.append(f"要点がない資料: {d['slug']}（{d['t'][:30]}）")
                d["mode"] = "skip"; d["memo"] = "要点は作成中です。原本を開いてください。"
            else:
                items = json.loads(f.read_text(encoding="utf-8"))
                NOTES[d["slug"]] = items
                for it in items:
                    for v in [it.get("g", "")] + it.get("pts", []):
                        if BAN.search(v):
                            bad.append(f"要点に使わない言葉: {d['slug']} {it['k']} {v[:40]}")
                    search.append({"s": d["slug"], "k": it["k"], "t": it["t"], "x": " ".join([it.get("g", "")] + it.get("pts", []))})
                (ndir / f"{d['slug']}.json").write_text(json.dumps({"slug": d["slug"], "items": items}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                keep.add(f"{d['slug']}.json")
        docs.append(d)
    (ndir / "search.json").write_text(json.dumps(search, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    keep.add("search.json")
    for f in ndir.glob("*.json"):
        if f.name not in keep:
            f.unlink()
    # 法令（条と見出しに、ページ内の行き先の id を付ける）
    for law in laws:
        n = 0
        for x in law["body"]:
            n += 1
            x["id"] = ("h" if x["kind"] == "head" else "a") + str(n)
        law["note"] = "e-Gov法令検索の条文（" + law["rev"][:4] + "年" + str(int(law["rev"][4:6])) + "月" + str(int(law["rev"][6:])) + "日施行の版）をそのまま載せています。"
    (OUT / "law.json").write_text(json.dumps(laws, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # 公式Q&A（原文）
    qa = json.loads((SRC / "qa_official.json").read_text(encoding="utf-8"))
    for x in qa:
        x["q"] = spaces(x["q"]); x["a"] = [spaces(p) for p in x["a"]]
    (OUT / "qa_official.json").write_text(json.dumps(qa, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    ctx = {"notes": NOTES, "docs": {d["slug"]: d for d in docs}, "qa": qa}
    # 章の終わりの「資料で詳しく」（網羅の確認で、その章に載っていると判定した資料の見出し。see.json）
    see_js = ""
    sp = SRC / "see.json"
    if sp.exists():
        see = json.loads(sp.read_text(encoding="utf-8"))
        vid = {}
        for f in (SRC / "sections").glob("*.html"):
            m = re.search(r'<section[^>]*\bid="([^"]+)"', f.read_text(encoding="utf-8"))
            if m: vid[f.stem.replace(".tpl", "")] = m.group(1)
        out = {}
        for sec, links in see.items():
            v = vid.get(sec)
            if not v: continue
            ok = []
            for l in links:
                its = {it["k"]: it for it in NOTES.get(l["doc"], [])}
                if l["k"] in its:
                    ok.append([l["doc"], l["k"], its[l["k"]]["t"]])
            if ok: out[v] = ok[:12]
        see_js = "GUIDE_DATA.see = " + json.dumps(out, ensure_ascii=False) + ";\n"
    # 資料から答えたQ&A（照合係2人が全文を合格としたものだけ。qa_mat.json）
    qm_js = ""
    qp = SRC / "qa_mat.json"
    if qp.exists():
        import html as H
        out = []
        for it in json.loads(qp.read_text(encoding="utf-8")):
            for s in [it["q"]] + [a["x"] for a in it["a"]]:
                if BAN.search(s):
                    bad.append(f"Q&Aに使わない言葉: {it['id']} {s[:40]}")
            a = "".join("<p>" + H.escape(x["x"]) + " " + " ".join(ref_html(r, ctx) for r in x.get("ref", [])) + "</p>" for x in it["a"])
            see = []
            for s in it.get("see", []):
                its = {n["k"]: n for n in NOTES.get(s["doc"], [])}
                if s["k"] in its:
                    see.append(f'<a href="#doc-{s["doc"]}~{H.escape(s["k"])}">{H.escape(SHORT.get(s["doc"], s["doc"]))}「{H.escape(its[s["k"]]["t"])}」</a>')
            out.append({"id": it["id"], "q": it["q"], "a": a, "cat": it["cat"], "more": "資料で詳しく：" + "・".join(see) if see else ""})
        # 量が多いので、Q&Aの画面を開いたときに読む（公式Q&Aと同じ）
        (OUT / "qa_mat.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        qm_js = "GUIDE_DATA.qaMatN = " + str(len(out)) + ";\n"
    js = see_js + qm_js + "GUIDE_DATA.docs = " + json.dumps({"groups": book["groups"], "docs": docs, "credit": CREDIT}, ensure_ascii=False) + ";\n"
    return js, bad, {"docs": len(docs), "notes": len(keep) - 1, "headings": len(search), "qa": len(qa)}, ctx
