#!/usr/bin/env python3
"""こども性暴力防止法 実務ガイド（福祉情報ウォッチの特設ページ）を1枚のHTMLに組み立てる。

使い方: python3 dbs/_src/build.py
  - 入力: dbs/_src/ の部品（style.css・shell_*.html・sections/・svg/・data.js・app.js・live.json）
  - 出力: dbs/index.html（GitHub Pages が配信する）
  - 毎朝の更新タスクは live.json だけを書き換えて、このスクリプトを実行する。
  - 本文を直すときは sections/ などの部品を直して実行する。dbs/index.html を直接書き換えない。
依存は Python 標準ライブラリだけ。
"""
import json, pathlib, re, sys

SRC = pathlib.Path(__file__).resolve().parent
OUT = SRC.parent / "index.html"

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
    app = (SRC / "app.js").read_text(encoding="utf-8")
    live = json.loads((SRC / "live.json").read_text(encoding="utf-8"))   # 読めなければここで止まる
    live_txt = json.dumps(live, ensure_ascii=False, indent=1).replace("</", "<\\/")
    live_block = ('<!--LIVE-DATA-START-->\n<script type="application/json" id="live-data">\n'
                  + live_txt + '\n</script>\n<!--LIVE-DATA-END-->\n')
    html = (HEAD + "<style>\n" + RESET + css + "\n</style>\n</head>\n<body>\n" + shell_top + "\n".join(parts) + shell_bottom
            + live_block + "<script>\n" + data + "\n</script>\n<script>\n" + app + "\n</script>\n</body>\n</html>\n")
    # 簡易検査: 開きタグと閉じタグの数
    bad = []
    for tag in ["section", "div", "figure", "table", "details", "ul", "ol", "svg", "p"]:
        o = len(re.findall(r"<%s[\s>]" % tag, html)); c = html.count("</%s>" % tag)
        if o != c:
            bad.append(f"<{tag}> open={o} close={c}")
    if bad:
        print("タグの数が合いません。書き出しを止めました:", *bad, sep="\n  ")
        sys.exit(1)
    OUT.write_text(html, encoding="utf-8")
    print(OUT, len(html.encode("utf-8")) // 1024, "KB")


if __name__ == "__main__":
    main()
