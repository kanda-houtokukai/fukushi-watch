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
import json, pathlib, re, shutil, subprocess, sys

SRC = pathlib.Path(__file__).resolve().parent
OUT = SRC.parent / "index.html"
sys.dont_write_bytecode = True   # scripts/__pycache__ を作らない（毎朝のタスクは変わったファイルを確かめて止まるため）
sys.path.insert(0, str(SRC.parent.parent / "scripts"))
import linkbook  # noqa: E402  資料リンク集（scripts/linkbook.py）

LINK_GROUPS = [{"id": "meet", "t": "障害福祉報酬改定検討チームの回と資料"}, {"id": "rel", "t": "関連する会議・ページ"}]

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


def link_items(content, live):
    """資料リンク集の台帳: 検討チームの回ごとに、会議のページと、そこで使った資料（PDF）を並べる"""
    items, by_no = [], {}
    for m in live.get("meetings", []):
        if not m.get("page_url"):
            continue
        it = {"g": "meet", "t": (m.get("no", "") + " " + m.get("title", "")).strip(), "u": m["page_url"], "d": m.get("date", ""), "sub": []}
        items.append(it)
        by_no.setdefault(m.get("no", ""), it)
    seen = set()

    def add_sub(no, t, u, n=""):
        if not u or u in seen:
            return False
        it = by_no.get(no)
        if not it:
            return False
        it["sub"].append({"t": t, "u": u, "n": n})
        seen.add(u)
        return True
    rest = []
    for x in content.get("sources", []):
        k = (x.get("k") or "").split()
        no = "公表" if "公表" in k else (k[0] if k else "")
        note_urls = linkbook.collect_urls(x.get("note", ""))
        note_txt = linkbook.URL_RE.sub("", x.get("note", "")).strip("：: ")
        if add_sub(no, x.get("title", ""), x.get("url", "")):
            for v in note_urls:
                add_sub(no, (note_txt or "関連資料") + "（" + x.get("title", "") + "）", v)
        else:
            rest.append(x)
    for r in content.get("ronten", []) + content.get("zentei", []):
        src = r.get("src") or {}
        add_sub(src.get("meeting", ""), src.get("title", ""), src.get("url", ""))
    for x in rest:
        if x.get("url") and x["url"] not in seen:
            items.append({"g": "rel", "t": x.get("title", ""), "u": x["url"], "d": "", "n": linkbook.URL_RE.sub("", x.get("note", "")).strip("：: ")})
            seen.add(x["url"])
    for w in live.get("watch", []):
        if w.get("url") and w["url"] not in seen:
            items.append({"g": "rel", "t": w.get("name", ""), "u": w["url"], "d": ""})
            seen.add(w["url"])
    # 同じ URL が会議のページと関連ページの両方に出ないようにする
    page_urls = {i["u"] for i in items if i["g"] == "meet"}
    return [i for i in items if i["g"] == "meet" or i["u"] not in page_urls]


def link_hints(content, live):
    hints = {}
    for x in live.get("updates", []):
        if x.get("url") and x["url"] not in hints:
            hints[x["url"]] = {"t": x.get("title", ""), "d": x.get("date", ""), "g": "rel"}
    return hints


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
    # 資料リンク集: ページの中で使っているリンクを全部集めて #sources に書き出す。欠けたら止める
    html, added, lost, n_links = linkbook.build(html, LINK_GROUPS, link_items(content, live), link_hints(content, live), lambda u: "rel", "第64回　訂正")
    body = re.sub(r"<script[\s\S]*?</script>", "", html)
    bad = []
    if lost:
        bad.append("資料リンク集に載っていないリンクがあります: " + " / ".join(lost[:5]))
    for tag in ["section", "div", "table", "details", "ul", "ol", "nav", "header", "main", "aside", "footer", "p"]:
        o = len(re.findall(r"<%s[\s>]" % tag, body)); c = body.count("</%s>" % tag)
        if o != c:
            bad.append(f"<{tag}> open={o} close={c}")
    if "まだ" in html:
        bad.append("画面の文に「まだ」が含まれています（live.json などの該当する文を「未公表」「公表待ち」など事実の言い方に直して、組み立て直してください）")
    m = re.search(r"(?<![ぁ-ん])いま(?![すせしそ])|今ここ|今いる|いますぐ|今すぐ", html)
    if m:
        bad.append("画面の文に「いま〇〇」の言い方が含まれています（live.json などの該当する文を「◯月◯日時点」など事実の言い方に直して、組み立て直してください）: …" + html[max(0, m.start() - 15):m.end() + 15].replace("\n", " ") + "…")
    # 画面を動かすスクリプトの書き間違い（node があるときだけ確かめる）
    if shutil.which("node"):
        r = subprocess.run(["node", "--check", str(SRC / "app.js")], capture_output=True, text=True)
        if r.returncode:
            bad.append("app.js に書き間違いがあります: " + (r.stderr.strip().splitlines() or [""])[0])
    if bad:
        print("書き出しを止めました:", *bad, sep="\n  ")
        sys.exit(1)
    OUT.write_text(html, encoding="utf-8")
    write_feature(content, live)
    print(OUT, len(html.encode("utf-8")) // 1024, "KB", "論点", len(content.get("ronten", [])), "前提", len(content.get("zentei", [])), "資料リンク集", n_links, "件")
    for a in added:
        print("  資料リンク集に自動で足したもの:", a["t"][:40], a["u"][:90])


if __name__ == "__main__":
    main()
