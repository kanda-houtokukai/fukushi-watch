#!/usr/bin/env python3
"""令和9年度 障害福祉報酬改定ガイド（福祉情報ウォッチの特設ページ）を1枚のHTMLに組み立てる。

使い方: python3 kaitei/_src/build.py
  - 入力: kaitei/_src/ の部品（style.css・shell.html・app.js・content.json・live.json）
  - 出力: kaitei/index.html（GitHub Pages が配信する）と kaitei/feature.json（ウォッチの特設の帯が読む要約）
  - content.json＝本文（論点カード・前提・サービスの一覧・段階の定義）。書き換えは承認制。
  - live.json＝更新データ（最終確認・更新情報・開催状況・日程・お知らせ）。毎朝の定期タスクが書き換える。
  - kaitei/index.html を直接書き換えない。
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
<title>令和9年度 障害福祉報酬改定ガイド</title>
<meta name="description" content="令和9年度障害福祉サービス等報酬改定の論点を、サービスごとに確度つきで整理したガイド。厚生労働省の検討チームの資料が出るたびに書き直しています。">
<meta name="theme-color" content="#ffffff">
<meta property="og:type" content="website">
<meta property="og:title" content="令和9年度 障害福祉報酬改定ガイド">
<meta property="og:description" content="報酬改定の論点をサービス別・確度つきで整理。福祉情報ウォッチの特設ページ。">
<meta property="og:url" content="https://fukushi-watch.fknd.jp/kaitei/">
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


def embed(obj):
    return json.dumps(obj, ensure_ascii=False, indent=1).replace("</", "<\\/")


def check(content, live):
    """読み込めても中身が壊れていれば止める（毎朝のタスクと承認後の反映の両方の歯止め）"""
    errs = []
    svcs = {s for g in content.get("groups", []) for s in g["services"]} | {"全サービス"}
    ids = set()
    for r in content.get("ronten", []) + content.get("zentei", []):
        if r["id"] in ids:
            errs.append("id が重なっています: " + r["id"])
        ids.add(r["id"])
        for s in r.get("services", []):
            if s not in svcs:
                errs.append(f"{r['id']}: サービス名が一覧にありません: {s}")
        if not 1 <= int(r.get("stage", 1)) <= 5:
            errs.append(f"{r['id']}: stage が1〜5ではありません")
    for k in ("checkedAt", "updates", "meetings", "timeline", "watch"):
        if k not in live:
            errs.append("live.json に " + k + " がありません")
    return errs


def write_feature(content, live):
    """福祉情報ウォッチの特設の帯が読む要約（kaitei/feature.json）。段階と、いちばん新しい公的な更新だけを持つ"""
    stage = int(live.get("currentStage") or content.get("currentStage") or 1)
    name = next((s["name"] for s in content.get("stages", []) if s.get("k") == stage), "")
    ups = [u for u in live.get("updates", []) if u.get("src") != "報道" and u.get("date")]
    ups.sort(key=lambda u: u["date"], reverse=True)
    latest = {"date": ups[0]["date"][:10], "text": ups[0].get("title", "")} if ups else None
    feat = {"stage": stage, "stageName": name, "latest": latest, "checkedAt": live.get("checkedAt", "")}
    (SRC.parent / "feature.json").write_text(json.dumps(feat, ensure_ascii=False) + "\n", encoding="utf-8")


def main():
    css = (SRC / "style.css").read_text(encoding="utf-8")
    shell = (SRC / "shell.html").read_text(encoding="utf-8")
    app = (SRC / "app.js").read_text(encoding="utf-8")
    content = json.loads((SRC / "content.json").read_text(encoding="utf-8"))   # 読めなければここで止まる
    live = json.loads((SRC / "live.json").read_text(encoding="utf-8"))
    errs = check(content, live)
    if errs:
        print("データに問題があります。書き出しを止めました:", *errs, sep="\n  ")
        sys.exit(1)
    html = (HEAD + "<style>\n" + RESET + css + "\n</style>\n</head>\n<body>\n" + shell
            + '\n<!--CONTENT-DATA-START-->\n<script type="application/json" id="content-data">\n' + embed(content) + "\n</script>\n<!--CONTENT-DATA-END-->\n"
            + '<!--LIVE-DATA-START-->\n<script type="application/json" id="live-data">\n' + embed(live) + "\n</script>\n<!--LIVE-DATA-END-->\n"
            + "<script>\n" + app + "\n</script>\n</body>\n</html>\n")
    body = re.sub(r"<script[\s\S]*?</script>", "", html)
    bad = []
    for tag in ["section", "div", "table", "details", "ul", "ol", "nav", "header", "main", "aside", "footer", "p"]:
        o = len(re.findall(r"<%s[\s>]" % tag, body)); c = body.count("</%s>" % tag)
        if o != c:
            bad.append(f"<{tag}> open={o} close={c}")
    if "まだ" in html:
        bad.append("画面の文に「まだ」が含まれています")
    if bad:
        print("書き出しを止めました:", *bad, sep="\n  ")
        sys.exit(1)
    OUT.write_text(html, encoding="utf-8")
    write_feature(content, live)
    print(OUT, len(html.encode("utf-8")) // 1024, "KB", "論点", len(content.get("ronten", [])), "前提", len(content.get("zentei", [])))


if __name__ == "__main__":
    main()
