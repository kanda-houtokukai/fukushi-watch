#!/usr/bin/env python3
"""こども性暴力防止法 実務ガイド（福祉情報ウォッチの特設ページ）を1枚のHTMLに組み立てる。

使い方: python3 dbs/_src/build.py
  - 入力: dbs/_src/ の部品（style.css・shell_*.html・sections/・svg/・data.js・app.js・live.json）
  - 出力: dbs/index.html（GitHub Pages が配信する）
  - 毎朝の更新タスクは live.json だけを書き換えて、このスクリプトを実行する。
  - 本文を直すときは sections/ などの部品を直して実行する。dbs/index.html を直接書き換えない。
依存は Python 標準ライブラリだけ。
"""
import html as H
import json, pathlib, re, shutil, subprocess, sys

SRC = pathlib.Path(__file__).resolve().parent
OUT = SRC.parent / "index.html"
sys.dont_write_bytecode = True   # scripts/__pycache__ を作らない（毎朝のタスクは変わったファイルを確かめて止まるため）
sys.path.insert(0, str(SRC.parent.parent / "scripts"))
import linkbook  # noqa: E402  資料リンク集（scripts/linkbook.py）
sys.path.insert(0, str(SRC))
import docs_build  # noqa: E402  資料を読む・法令・公式Q&A（dbs/_src/docs_build.py）

HEAD = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>こども性暴力防止法 実務ガイド</title>
<meta name="description" content="こども性暴力防止法（日本版DBS）の事業者向け実務ガイド。施行日までの期限、対象の判定ツール、事業別の要点、Q&amp;A、研修・説明会の情報を毎朝更新しています。">
<meta name="theme-color" content="#ffffff">
<meta property="og:type" content="website">
<meta property="og:title" content="こども性暴力防止法 実務ガイド">
<meta property="og:description" content="施行日までの期限、対象の判定ツール、事業別の要点、Q&amp;A、研修・説明会の情報。福祉情報ウォッチの特設ページ。">
<meta property="og:url" content="https://fukushi-watch.fknd.jp/dbs/">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png?v=2">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png?v=2">
<link rel="apple-touch-icon" href="../apple-touch-icon.png?v=2">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&family=IBM+Plex+Mono:wght@400;500&family=Zen+Kaku+Gothic+New:wght@500;700;900&display=swap">
"""

RESET = """/* 土台（ページ全体） */
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; }
img { max-width: 100%; }
[hidden] { display: none !important; }
"""


def link_group(u):
    """台帳にないリンクのグループを、置き場所から決める"""
    if "e-gov.go.jp" in u:
        return "law"
    if any(k in u for k in ("fukuoka", "kitakyushu", "kurume")):
        return "fukuoka"
    if re.search(r"\.lg\.jp|//(www\.)?(pref|city)\.", u):
        return "local"
    if "cfa.go.jp" in u:
        return "notice"
    if ".go.jp" in u:
        return "council"
    return "seminar"


def link_hints(live, sections):
    """台帳にないリンクの題名・日付・グループの手がかり（先に入れたものが優先）"""
    hints = {}

    def put(u, t, d="", g=""):
        if u and t and u not in hints:
            hints[u] = {"t": t.strip(), "d": d, "g": g}
    for x in live.get("library", []):
        put(x.get("url"), x.get("title", ""), "", "kit" if x.get("kind") != "municipal" else link_group(x.get("url", "")))
    for x in live.get("watch", []):
        put(x.get("url"), x.get("name", ""), "", link_group(x.get("url", "")))
    for x in live.get("events", []):
        t = x.get("title", "") + ("（" + x["org"] + "）" if x.get("org") else "")
        put(x.get("url"), t, (x.get("start") or "")[:10], "seminar")
    for m in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>([\s\S]*?)</a>', sections):
        put(H.unescape(m.group(1)), re.sub(r"<[^>]+>|\s+", "", H.unescape(m.group(2))))
    # 資料を読む（docs.json）の資料: 題名・公表日・グループ
    DG = {"law": "law", "gl": "law", "qa": "law", "kenshu": "kit", "hinagata": "kit", "kaisetsu": "notice", "ouyou": "kit",
          "tetsuzuki": "system", "kantoku": "notice", "odan": "notice", "senmon": "kit", "tsuchi": "notice"}
    try:
        for d in json.loads((SRC / "docs.json").read_text(encoding="utf-8"))["docs"]:
            dd = d.get("d", "")
            put(d["u"], d["t"], (dd[:4] + "-" + dd[4:6] + "-" + dd[6:8]) if len(dd) == 8 else "", "session" if d["slug"].startswith(("kaisai-", "setsumei")) else DG.get(d["g"], "notice"))
    except FileNotFoundError:
        pass
    for x in live.get("updates", []):
        u = x.get("url", "")
        put(u, x.get("title", ""), x.get("date", ""), link_group(u) if x.get("src") == "自治体" else ("seminar" if x.get("src") == "研修" else "notice"))
        for v in linkbook.collect_urls(json.dumps(x, ensure_ascii=False)):   # 注記の中のリンク
            put(v, x.get("title", "") + "（関連資料）", x.get("date", ""), "")
    return hints


def links_with_dates(book, live):
    """台帳の日付が空なら、更新情報の日付か URL の日付で補う"""
    upd = {x.get("url"): x.get("date", "") for x in live.get("updates", []) if x.get("url")}
    items = []
    for it in book["items"]:
        it = dict(it)
        if not it.get("d"):
            # ページ（.html など）は中身が随時変わるので日付を付けない。資料のファイルだけ公表日で補う
            it["d"] = (upd.get(it["u"], "") if linkbook.kind(it["u"]) == "PDF" else "") or linkbook.url_date(it["u"])
        items.append(it)
    return items


def main():
    css = (SRC / "style.css").read_text(encoding="utf-8")
    shell_top = (SRC / "shell_top.html").read_text(encoding="utf-8")
    shell_bottom = (SRC / "shell_bottom.html").read_text(encoding="utf-8")
    order = (SRC / "sections" / "ORDER").read_text(encoding="utf-8").split()
    parts = []
    for name in order:
        t = (SRC / "sections" / name).read_text(encoding="utf-8")
        t = re.sub(r"\{\{([A-Z0-9_]+)\}\}", lambda m: (SRC / "svg" / (m.group(1) + ".svg")).read_text(encoding="utf-8"), t)
        parts.append(t)
    data = (SRC / "data.js").read_text(encoding="utf-8")
    docs_js, docs_bad, docs_n, docs_ctx = docs_build.build(strict="--draft" not in sys.argv)
    # 研修の進め方（照合済みの章 kenshu.json）
    kj = SRC / "kenshu.json"
    if kj.exists():
        k_lead, k_body = docs_build.chapter_html(kj, docs_ctx)
    else:
        if "--draft" not in sys.argv:
            sys.exit("kenshu.json がありません")
        k_lead, k_body = '<p class="ch-lead">（作成中）</p>', ""
    parts = [x.replace("<!--KENSHU-LEAD-->", k_lead).replace("<!--KENSHU-BODY-->", k_body) for x in parts]
    data += "\n" + docs_js
    app = (SRC / "app.js").read_text(encoding="utf-8")
    app = app.replace("/*@DOCS@*/", (SRC / "docs.js").read_text(encoding="utf-8"))
    live = json.loads((SRC / "live.json").read_text(encoding="utf-8"))   # 読めなければここで止まる
    live_txt = json.dumps(live, ensure_ascii=False, indent=1).replace("</", "<\\/")
    live_block = ('<!--LIVE-DATA-START-->\n<script type="application/json" id="live-data">\n'
                  + live_txt + '\n</script>\n<!--LIVE-DATA-END-->\n')
    html = (HEAD + "<style>\n" + RESET + css + "\n</style>\n</head>\n<body>\n" + shell_top + "\n".join(parts) + shell_bottom
            + live_block + "<script>\n" + data + "\n</script>\n<script>\n" + app + "\n</script>\n</body>\n</html>\n")
    # 資料リンク集: ページの中で使っているリンクを全部集めて #sources に書き出す。欠けたら止める
    book = json.loads((SRC / "links.json").read_text(encoding="utf-8"))
    html, added, lost, n_links = linkbook.build(html, book["groups"], links_with_dates(book, live),
                                                link_hints(live, "\n".join(parts)), link_group, "説明会　10/15")
    bad = list(docs_bad)
    # 根拠の表記（Q&A・判定ツールの src、章の ref）は、資料リンク集の資料に必ず結びつける（どの資料のどこかを辿れるように）
    cites = [m.group(1) for m in re.finditer(r'\bsrc:\s*"([^"]+)"', data)]
    cites += [re.sub(r"<[^>]+>", "", H.unescape(m.group(1))) for m in re.finditer(r'<span class="ref">([\s\S]*?)</span>', "\n".join(parts))]
    unresolved = sorted({b for c in cites for b in linkbook.resolve_cites(c, book["items"])[1]})
    if unresolved:
        bad.append("根拠の表記が資料リンク集のどの資料にも結びつきません（links.json の cite に呼び名を足すか、表記を直してください）: " + " / ".join(unresolved[:8]))
    if lost:
        bad.append("資料リンク集に載っていないリンクがあります: " + " / ".join(lost[:5]))
    # 画面の文に「まだ」「いま〇〇」を使わない（ふつうの情報サイトでは使わない言い方）
    if "まだ" in html:
        m = re.search("まだ", html)
        bad.append("画面の文に「まだ」が含まれています（live.json などの該当する文を「未公表」「公表待ち」など事実の言い方に直して、組み立て直してください）: …" + html[max(0, m.start() - 20):m.end() + 15].replace("\n", " ") + "…")
    m = re.search(r"(?<![ぁ-ん])いま(?![すせしそ])|今ここ|今いる|いますぐ|今すぐ", html)
    if m:
        bad.append("画面の文に「いま〇〇」の言い方が含まれています（live.json などの該当する文を「◯月◯日時点」など事実の言い方に直して、組み立て直してください）: …" + html[max(0, m.start() - 15):m.end() + 15].replace("\n", " ") + "…")
    # 簡易検査: 開きタグと閉じタグの数
    for tag in ["section", "div", "figure", "table", "details", "ul", "ol", "svg", "p"]:
        o = len(re.findall(r"<%s[\s>]" % tag, html)); c = html.count("</%s>" % tag)
        if o != c:
            bad.append(f"<{tag}> open={o} close={c}")
    # 画面を動かすスクリプトの書き間違い（node があるときだけ確かめる）
    if shutil.which("node"):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tf:
            tf.write(data + "\n" + app)
        r = subprocess.run(["node", "--check", tf.name], capture_output=True, text=True)
        pathlib.Path(tf.name).unlink()
        if r.returncode:
            bad.append("app.js・docs.js・data.js に書き間違いがあります: " + " ".join(r.stderr.strip().splitlines()[:3]))
    if bad:
        print("書き出しを止めました:", *bad, sep="\n  ")
        sys.exit(1)
    OUT.write_text(html, encoding="utf-8")
    print(OUT, len(html.encode("utf-8")) // 1024, "KB", "資料リンク集", n_links, "件", "資料", docs_n)
    if added:
        print("  うち、links.json になく自動で足したもの", len(added), "件（研修の告知など）")
    for a in added:
        if a["t"] == a["u"]:
            print("  題名が分からないリンク（links.json に題名を足すと整います）:", a["u"])


if __name__ == "__main__":
    main()
