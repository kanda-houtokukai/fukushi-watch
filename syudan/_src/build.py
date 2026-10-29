#!/usr/bin/env python3
"""令和8年度 福岡県 集団指導 特設ページ（福祉情報ウォッチの特設ページ）を1枚のHTMLに組み立てる。

使い方: python3 syudan/_src/build.py
  - 入力: syudan/_src/ の部品（style.css・shell.html・app.js）と、extract.py が作る docs.json・toc.json、
    見出しごとの要点 syudan/_src/notes/<資料>.json（県の資料を自分の言葉でまとめ、照合係2人の合格を通したもの）
  - 出力: syudan/index.html（GitHub Pages が配信する）。syudan/kw.json（検索の索引）は extract.py が直接書く
  - 県の資料の本文（原文）は持たない。持つのは見出し・頁番号・語の索引と、自分の言葉でまとめた要点だけ。
    県のサイトの著作権の表示と、台帳の「監視先の全文をコピーして保存しない」に合わせるため。
  - syudan/index.html を直接書き換えない。
依存は Python 標準ライブラリだけ。
"""
import json, pathlib, re, shutil, subprocess, sys

SRC = pathlib.Path(__file__).resolve().parent
OUT = SRC.parent / "index.html"
sys.dont_write_bytecode = True
sys.path.insert(0, str(SRC.parent.parent / "scripts"))
import linkbook  # noqa: E402  資料リンク集（scripts/linkbook.py）
sys.path.insert(0, str(SRC))
import tenken_build  # noqa: E402  点検・減算・年間（syudan/_src/tenken_build.py）
import tempfile  # noqa: E402

HEAD = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>令和8年度 福岡県 集団指導 特設ページ</title>
<meta name="description" content="福岡県の令和8年度 障がい福祉サービス事業所等集団指導の説明資料と参考資料を、サービス別の見出しと資料の中の検索で引けるようにしたページ。国の確認項目による点検表、減算になる場面、年間でやることもまとめています。">
<meta name="theme-color" content="#ffffff">
<meta property="og:type" content="website">
<meta property="og:title" content="令和8年度 福岡県 集団指導 特設ページ">
<meta property="og:description" content="福岡県の集団指導の資料を、サービス別の見出しと検索で引く。福祉情報ウォッチの特設ページ。">
<meta property="og:url" content="https://fukushi-watch.fknd.jp/syudan/">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png?v=2">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png?v=2">
<link rel="apple-touch-icon" href="../apple-touch-icon.png?v=2">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&family=IBM+Plex+Mono:wght@400;500&family=Zen+Kaku+Gothic+New:wght@500;700;900&display=swap">
"""

RESET = """:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; }
[hidden] { display: none !important; }
"""


def embed(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def check(docs, toc):
    errs = []
    for k in ("page", "items", "groups", "services", "registerDeadline", "register"):
        if not docs.get(k):
            errs.append("docs.json に " + k + " がありません")
    need = {"common", "kaitei"} | {s["id"] for s in docs.get("services", [])}
    have = {d["id"] for d in toc}
    if need - have:
        errs.append("見出しのない資料があります: " + ", ".join(sorted(need - have)))
    for d in toc:
        last = 0
        for s in d["secs"]:
            if not 1 <= s["p"] <= d["pages"]:
                errs.append(f'{d["id"]}: 頁が範囲外 {s["t"][:20]} p.{s["p"]}')
            if s["p"] < last:
                errs.append(f'{d["id"]}: 章の頁が逆順 {s["t"][:20]}')
            last = s["p"]
            for x in s["sub"]:
                if not s["p"] <= x["p"] <= d["pages"]:
                    errs.append(f'{d["id"]}: 節の頁が章の外 {x["t"][:20]} p.{x["p"]}')
    return errs


def load_notes(toc):
    """見出しごとの要点（syudan/_src/notes/<資料>.json）を、見出しの並び（章・節の順＝app.js の FLAT）に合わせる。
    要点は見出しの文字で結びつける（資料が差し替わって見出しの番号がずれても、同じ見出しには同じ要点が付く）。
    戻り値: ({資料: {見出しの番号: 要点}}, 結びつかなかった要点, 要点のない見出し)"""
    out, unmatched, missing = {}, [], []
    for d in toc:
        f = SRC / "notes" / (d["id"] + ".json")
        entries = json.loads(f.read_text(encoding="utf-8")) if f.exists() else []
        flat = []
        for s in d["secs"]:
            flat.append(s["t"])
            flat.extend(x["t"] for x in s["sub"])
        if not flat:
            flat = [None]   # 見出しのない資料は -1 に1つだけ
        pool = {}
        for e in entries:
            pool.setdefault(e.get("t"), []).append(e)
        m = {}
        for h, t in enumerate(flat):
            key = -1 if t is None else h
            cand = pool.get(t if t is not None else d["t"]) or pool.get(None)
            if cand:
                e = cand.pop(0)
                m[key] = {k: e[k] for k in ("gist", "points", "shiteki") if e.get(k)}
            else:
                missing.append(f'{d["id"]}: {t or d["t"]}')
        unmatched += [f'{d["id"]}: {e.get("t")}' for v in pool.values() for e in v]
        out[d["id"]] = m
    return out, unmatched, missing


def link_groups_items(docs, tk):
    """資料リンク集: 県のページの区分どおりに並べる（説明資料 → 参考資料）"""
    groups = [{"id": "pref", "t": "福岡県のページ"}]
    gid = {}
    for i, g in enumerate(docs["groups"]):
        gid[g["g"]] = "g%d" % i
        groups.append({"id": gid[g["g"]], "t": g["part"] + "　" + g["label"]})
    items = [{"g": "pref", "t": docs.get("pageTitle") or "集団指導のページ", "u": docs["page"], "d": ""}]
    if docs.get("schedule"):
        items.append({"g": "pref", "t": "日程表", "u": docs["schedule"], "d": ""})
    if docs.get("register"):
        items.append({"g": "pref", "t": "受講登録のフォーム（受講後に登録）", "u": docs["register"], "d": ""})
    for it in docs["items"]:
        n = "　".join(x for x in [it.get("size", ""), ("※" + it["note"]) if it.get("note") else ""] if x)
        items.append({"g": gid[it["g"]], "t": it["t"], "u": it["u"], "d": "", "n": n})
    # 点検表の確認項目の出典（国の通知）
    groups.append({"id": "kuni", "t": "国の通知（点検表の確認項目）"})
    for k in ("sogo", "ji"):
        s = tk["src"][k]
        items.append({"g": "kuni", "t": s["of"] + ("　確認項目及び確認文書（Excel）" if k == "sogo" else ""), "u": s["u"], "d": "", "n": s["by"]})
        if s.get("page"):
            items.append({"g": "kuni", "t": "障害福祉分野における指導監督（厚生労働省のページ）", "u": s["page"], "d": "", "n": "確認項目及び確認文書のPDF版・集団指導・運営指導マニュアルなど"})
    return groups, items


def main():
    css = (SRC / "style.css").read_text(encoding="utf-8")
    shell = (SRC / "shell.html").read_text(encoding="utf-8")
    app = (SRC / "app.js").read_text(encoding="utf-8")
    docs = json.loads((SRC / "docs.json").read_text(encoding="utf-8"))
    toc = json.loads((SRC / "toc.json").read_text(encoding="utf-8"))
    errs = check(docs, toc)
    if errs:
        print("データに問題があります。書き出しを止めました:", *errs, sep="\n  ")
        sys.exit(1)
    notes, unmatched, missing = load_notes(toc)
    tk, tk_files, tk_errs = tenken_build.build(toc, notes, docs)
    if tk_errs:
        print("点検のデータに問題があります。書き出しを止めました:", *tk_errs, sep="\n  ")
        sys.exit(1)
    app = app.replace("/*@TENKEN@*/", (SRC / "tenken.js").read_text(encoding="utf-8"))
    data = {"docs": docs, "toc": toc, "notes": notes, "tk": tk}
    html = (HEAD + "<style>\n" + RESET + css + "\n</style>\n</head>\n<body>\n" + shell
            + '\n<script type="application/json" id="data">\n' + embed(data) + "\n</script>\n"
            + "<script>\n" + app + "\n</script>\n</body>\n</html>\n")
    groups, items = link_groups_items(docs, tk)
    html, added, lost, n_links = linkbook.build(html, groups, items, {}, lambda u: "pref", "虐待")
    html = html.replace("資料名・日付で探す", "資料名で探す")   # この一覧の資料には日付がない
    body = re.sub(r"<script[\s\S]*?</script>", "", html)
    bad = []
    if lost:
        bad.append("資料一覧に載っていないリンクがあります: " + " / ".join(lost[:5]))
    if added:
        bad.append("資料一覧の台帳にないリンクがあります: " + " / ".join(a["u"] for a in added[:5]))
    for tag in ["section", "div", "ul", "ol", "nav", "header", "main", "aside", "footer", "p", "form"]:
        o = len(re.findall(r"<%s[\s>]" % tag, body)); c = body.count("</%s>" % tag)
        if o != c:
            bad.append(f"<{tag}> open={o} close={c}")
    if "まだ" in html:
        bad.append("画面の文に「まだ」が含まれています")
    m = re.search(r"(?<![ぁ-ん])いま(?![すせしそ])|今ここ|今いる|いますぐ|今すぐ", html)
    if m:
        bad.append("画面の文に「いま〇〇」の言い方が含まれています: …" + html[max(0, m.start() - 15):m.end() + 15].replace("\n", " ") + "…")
    if shutil.which("node"):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tf:
            tf.write(app)
        r = subprocess.run(["node", "--check", tf.name], capture_output=True, text=True)
        pathlib.Path(tf.name).unlink()
        if r.returncode:
            bad.append("app.js・tenken.js に書き間違いがあります: " + " ".join(r.stderr.strip().splitlines()[:3]))
    if not (SRC.parent / "kw.json").exists():
        bad.append("syudan/kw.json（検索の索引）がありません。extract.py を実行してください")
    if bad:
        print("書き出しを止めました:", *bad, sep="\n  ")
        sys.exit(1)
    OUT.write_text(html, encoding="utf-8")
    tdir = SRC.parent / "tenken"   # サービスごとの点検表（開いたときに読む）
    tdir.mkdir(exist_ok=True)
    for f in tdir.glob("*.json"):
        if f.stem not in tk_files:
            f.unlink()
    for sid, obj in tk_files.items():
        (tdir / (sid + ".json")).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_notes = sum(len(v) for v in notes.values())
    print(OUT, len(html.encode("utf-8")) // 1024, "KB", "資料", len(docs["items"]), "点", "見出しのある資料", len(toc), "編",
          "要点", n_notes, "見出し", "資料一覧", n_links, "件")
    print("  点検表", len(tk_files), "サービス", "確認項目", sum(x["n"] for x in tk["index"]), "（標準以外を含め", sum(x["na"] for x in tk["index"]), "）",
          "県の資料から", sum(x["nk"] for x in tk["index"]), "減算", len(tk["gensan"]), "年間", len(tk["nenkan"]["items"]))
    if missing:
        print(f"  要点のない見出し {len(missing)} 件（資料の差し替えで見出しが変わったときは、要点を作り直す）", *missing[:8], sep="\n    ")
    if unmatched:
        print(f"  見出しと結びつかなかった要点 {len(unmatched)} 件", *unmatched[:8], sep="\n    ")


if __name__ == "__main__":
    main()
