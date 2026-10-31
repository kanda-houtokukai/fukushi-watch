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
import tenken_kaigo  # noqa: E402  高齢の点検（国の確認項目だけ）
import tempfile  # noqa: E402

HEAD = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#ffffff">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{ogdesc}">
<meta property="og:url" content="https://fukushi-watch.fknd.jp/syudan/{dir}">
<link rel="icon" type="image/png" sizes="32x32" href="{up}favicon-32.png?v=2">
<link rel="icon" type="image/png" sizes="16x16" href="{up}favicon-16.png?v=2">
<link rel="apple-touch-icon" href="{up}apple-touch-icon.png?v=2">
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


def check(docs, toc, need):
    errs = []
    for k in ("page", "items", "groups"):
        if not docs.get(k):
            errs.append("docs.json に " + k + " がありません")
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


def load_notes(toc, src):
    """見出しごとの要点（syudan/_src/notes/<資料>.json）を、見出しの並び（章・節の順＝app.js の FLAT）に合わせる。
    要点は見出しの文字で結びつける（資料が差し替わって見出しの番号がずれても、同じ見出しには同じ要点が付く）。
    戻り値: ({資料: {見出しの番号: 要点}}, 結びつかなかった要点, 要点のない見出し)"""
    out, unmatched, missing = {}, [], []
    for d in toc:
        f = src / "notes" / (d["id"] + ".json")
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


def link_groups_items(docs, tk, fid):
    """資料リンク集: 県のページの区分どおりに並べる"""
    groups = [{"id": "pref", "t": "福岡県のページ"}]
    gid = {}
    for i, g in enumerate(docs["groups"]):
        gid[g["g"]] = "g%d" % i
        groups.append({"id": gid[g["g"]], "t": (g["part"] + "　" + g["label"]) if fid == "shogai" else g["label"]})
    items = [{"g": "pref", "t": docs.get("pageTitle") or "集団指導のページ", "u": docs["page"], "d": ""}]
    if docs.get("page2"):
        items.append({"g": "pref", "t": docs.get("page2Title") or docs["page2"], "u": docs["page2"], "d": ""})
    if docs.get("schedule"):
        items.append({"g": "pref", "t": "日程表", "u": docs["schedule"], "d": ""})
    if docs.get("register"):
        items.append({"g": "pref", "t": "受講登録のフォーム（受講後に登録）", "u": docs["register"], "d": ""})
    for it in docs["items"]:
        n = "　".join(x for x in [it.get("kind") if it.get("kind") == "動画" else "", it.get("size", ""), ("※" + it["note"]) if it.get("note") and fid == "shogai" else it.get("note", "")] if x)
        items.append({"g": gid[it["g"]], "t": it["t"], "u": it["u"], "d": "", "n": n})
    if tk:   # 点検表の確認項目の出典（国の通知）
        groups.append({"id": "kuni", "t": "国の通知（点検表の確認項目）"})
        for x in tk["srclist"]:
            items.append(dict(x, g="kuni", d=""))
    return groups, items


FIELD_LABEL = {"shogai": "障がい", "kourei": "高齢", "hoiku": "保育"}
FIELD_DIR = {"shogai": "", "kourei": "kourei/", "hoiku": "hoiku/"}


def fsw(fid):
    """分野の切り替え（障がい・高齢・保育）。リンクはこの分野のページからの相対"""
    out = []
    for f, label in FIELD_LABEL.items():
        if f == fid:
            out.append(f'<a href="./" aria-current="page">{label}</a>')
        else:
            href = ("../" if FIELD_DIR[fid] else "") + FIELD_DIR[f] if FIELD_DIR[f] else "../"
            if not FIELD_DIR[fid]:
                href = FIELD_DIR[f]
            out.append(f'<a href="{href}">{label}</a>')
    return "".join(out)


def field_conf(fid, docs, toc):
    """画面の分野ごとの違い（app.js の F）"""
    BY = {d["id"]: d for d in toc}
    year = docs.get("year") or ""
    if fid == "shogai":
        return {
            "id": fid, "title": "令和8年度 福岡県 集団指導 特設ページ", "titleTail": "集団指導 特設ページ",
            "common": {"id": "common", "t": "全事業所共通", "names": "すべての事業所", "docs": ["common", "kaitei"]},
            "svcDocs": {"ji": ["ji", "dbs"]}, "svcLabel": "サービス別",
            "short": {"common": "全事業所共通編", "kyotaku": "居宅訪問系", "nicchu": "通所・入所系", "gh": "共同生活援助", "ji": "障がい児系",
                      "dbs": "こども性暴力防止法", "soudan": "相談支援系", "kaitei": "令和8年度報酬改定（国）"},
            "commonQuick": ["common"],
            "also": [{"href": "#svc-common", "t": "全事業所共通編の説明資料", "note": "指導監督の方針・行政処分の事例・虐待防止・事故・処遇改善など"},
                     {"href": "#ch-kaitei-1", "t": "令和8年度報酬改定について", "note": f"国の資料（{BY['kaitei']['pages']}ページ）。処遇改善加算の拡充と、臨時応急的な見直し"}],
            "plate": {"k": "受講登録の期限", "date": docs.get("registerDeadline"), "link": docs.get("register"), "linkLabel": "受講登録のフォーム"},
            "prefLinks": [[docs["page"], docs.get("pageTitle") or "県の集団指導のページ"], [docs.get("schedule"), "日程表"], [docs.get("register"), "受講登録のフォーム"]],
            "parts": [["参考資料", "参考資料"]],
            "site": [["../kaitei/", "令和9年度 障害福祉報酬改定ガイド", "次の改定の論点をサービスごとに"],
                     ["../dbs/", "こども性暴力防止法 実務ガイド", "施行日までの期限・対象の判定・事業別の要点"]],
        }, {
            "EYEBROW": f"<span>福岡県</span><span>{year}</span>", "H1": '集団指導 <span class="nw">特設ページ</span>',
            "PH": "例：身体拘束　常勤換算　業務継続計画", "COMMON_HEAD": "全事業所共通編の章", "PREF_HEAD": "福岡県の集団指導",
            "desc": "福岡県の令和8年度 障がい福祉サービス事業所等集団指導の説明資料と参考資料を、サービス別の見出しと資料の中の検索で引けるようにしたページ。国の確認項目による点検表、減算になる場面、年間でやることもまとめています。",
            "ogdesc": "福岡県の集団指導の資料を、サービス別の見出しと検索で引く。福祉情報ウォッチの特設ページ。",
            "FOOT": '<p>出典：福岡県「<a href="' + docs["page"] + '" target="_blank" rel="noopener">令和８年度集団指導について</a>」とその掲載資料。見出しごとの概要・要点は、県の資料をもとにこのページでまとめたものです（県の資料の文そのものではありません）。届出や算定の判断は、県の資料（PDF）の該当ページでご確認ください。点検の確認項目は、厚生労働省「指定障害福祉サービス事業者等の指導監査について」（令和8年6月）の「確認項目及び確認文書」と、こども家庭庁・厚生労働省「指定障害児通所支援事業者等の指導監査について」（令和8年10月改正）の別紙「主眼事項及び着眼点等」を、文を変えずに載せています。</p>',
        }
    if fid == "kourei":
        return {
            "id": fid, "title": "令和8年度 福岡県 集団指導（介護保険）特設ページ", "titleTail": "集団指導（介護保険）",
            "common": {"id": "common", "t": "各サービス共通", "names": "すべての事業所", "docs": ["kc", "kcb", "kcc", "jorei"]},
            "svcDocs": {}, "svcLabel": "サービス別",
            "short": {"kc": "共通資料１～２", "kcb": "共通資料３", "kcc": "共通資料４～６", "jorei": "条例・指導監督実施方針",
                      "houmon": "訪問介護・訪問入浴", "kango": "訪問看護", "tsusho": "通所介護", "tsuriha": "通所リハ・訪問リハ",
                      "iryoin": "介護医療院", "tanryo": "短期入所療養介護", "tanki": "短期入所生活介護", "tokutei": "特定施設",
                      "yogu": "福祉用具", "tokuyo": "介護老人福祉施設", "roken": "介護老人保健施設",
                      "ryoyo": "居宅療養管理指導（共通）", "ryoyoi": "居宅療養（医師）", "ryoyos": "居宅療養（歯科医師）", "ryoyoy": "居宅療養（薬剤師）"},
            "commonQuick": ["kc", "kcb", "kcc", "jorei"],
            "also": [{"href": "#svc-common", "t": "各サービス共通資料", "note": "届出・虐待防止と身体拘束・感染症・BCP・介護報酬・行政処分など"}],
            "plate": {"k": docs.get("deadlineLabel") or "", "date": docs.get("deadline"), "link": "", "linkLabel": ""},
            "prefLinks": [[docs["page"], docs.get("pageTitle")]],
            "parts": [["参考資料", "関連資料"]],
            "site": [],
        }, {
            "EYEBROW": f"<span>福岡県</span><span>介護保険</span><span>{year}</span>", "H1": '集団指導 <span class="nw">特設ページ</span>',
            "PH": "例：身体拘束　人員基準欠如　業務継続計画", "COMMON_HEAD": "各サービス共通資料の章", "PREF_HEAD": "福岡県の集団指導（介護保険）",
            "desc": "福岡県の令和8年度 集団指導（介護保険）の各サービス共通資料と個別サービス資料を、サービス別の見出しと資料の中の検索で引けるようにしたページ。国の確認項目による点検表もまとめています。",
            "ogdesc": "福岡県の集団指導（介護保険）の資料を、サービス別の見出しと検索で引く。福祉情報ウォッチの特設ページ。",
            "FOOT": '<p>出典：福岡県「<a href="' + docs["page"] + '" target="_blank" rel="noopener">令和８年度集団指導（介護保険）について</a>」とその掲載資料。見出しごとの概要・要点は、県の資料をもとにこのページでまとめたものです（県の資料の文そのものではありません）。届出や算定の判断は、県の資料（PDF）の該当ページでご確認ください。地域密着型の各サービスと居宅介護支援事業の管轄は保険者（市町村や介護保険広域連合）です。北九州市・福岡市・久留米市にある事業所は、各市のホームページをご確認ください。点検の確認項目は、厚生労働省老健局長「介護保険施設等運営指導マニュアル」（令和6年7月改正）の別添「確認項目及び確認文書」を、文を変えずに載せています。</p>',
        }
    return {
        "id": fid, "title": "福岡県 保育所等の指導監査 特設ページ", "titleTail": "保育所等の指導監査",
        "common": {"id": "common", "t": "保育所等", "names": "認可保育所・保育所型認定こども園・幼保連携型認定こども園", "docs": ["htsuchi", "htebiki"]},
        "svcDocs": {}, "svcLabel": "資料",
        "short": {"htsuchi": "指導監査の見直し（通知）", "htebiki": "安全管理重点確認監査の手引き"},
        "commonQuick": ["htsuchi", "htebiki"],
        "also": [], "plate": None,
        "prefLinks": [[docs["page"], docs.get("pageTitle")], [docs.get("page2"), docs.get("page2Title")]],
        "parts": [["様式", "合同監査資料の様式"]],
        "site": [["../../dbs/", "こども性暴力防止法 実務ガイド", "施行日までの期限・対象の判定・事業別の要点"]],
    }, {
        "EYEBROW": "<span>福岡県</span><span>子育て支援課</span>", "H1": '保育所等の <span class="nw">指導監査</span>',
        "PH": "例：送迎バス　午睡　プール", "COMMON_HEAD": "手引きと通知の章", "PREF_HEAD": "福岡県の保育所等指導監査",
        "desc": "福岡県の保育所等（認可保育所・保育所型認定こども園・幼保連携型認定こども園）の指導監査の通知と「安全管理重点確認監査」の手引き、合同監査資料の様式を引けるようにしたページ。",
        "ogdesc": "福岡県の保育所等の指導監査の資料を、見出しと検索で引く。福祉情報ウォッチの特設ページ。",
        "FOOT": '<p>出典：福岡県「<a href="' + docs["page"] + '" target="_blank" rel="noopener">令和４年度以降の保育所等指導監査について</a>」「<a href="' + docs["page2"] + '" target="_blank" rel="noopener">県・市町村合同監査資料様式</a>」とその掲載資料。見出しごとの概要・要点は、県の資料をもとにこのページでまとめたものです（県の資料の文そのものではありません）。監査への対応は、県の資料の該当ページでご確認ください。</p>',
    }


def build_field(fid):
    src = SRC if fid == "shogai" else SRC / fid
    out_dir = SRC.parent / FIELD_DIR[fid].rstrip("/") if FIELD_DIR[fid] else SRC.parent
    css = (SRC / "style.css").read_text(encoding="utf-8")
    shell = (SRC / "shell.html").read_text(encoding="utf-8")
    app = (SRC / "app.js").read_text(encoding="utf-8")
    docs = json.loads((src / "docs.json").read_text(encoding="utf-8"))
    toc = json.loads((src / "toc.json").read_text(encoding="utf-8")) if (src / "toc.json").exists() else []
    conf, txt = field_conf(fid, docs, toc)
    need = {"common", "kaitei"} | {s["id"] for s in docs.get("services", [])} if fid == "shogai" else set(conf["common"]["docs"]) | {d for s in docs.get("services", []) for d in s.get("docs", [])}
    errs = check(docs, toc, need)
    if errs:
        print(fid, "データに問題があります。書き出しを止めました:", *errs, sep="\n  ")
        sys.exit(1)
    notes, unmatched, missing = load_notes(toc, src)
    tk, tk_files = None, {}
    if fid == "kourei" and (src / "tenken" / "kaigo.json").exists():
        tk, tk_files = tenken_kaigo.build(src / "tenken" / "kaigo.json", docs)
        app = app.replace("/*@TENKEN@*/", (SRC / "tenken.js").read_text(encoding="utf-8"))
        shell = re.sub(r"<!--GSNAV-->[\s\S]*?<!--/GSNAV-->", "", shell)
        shell = re.sub(r"<!--NKTAB-->[\s\S]*?<!--/NKTAB-->", "", shell)
    elif fid == "shogai":
        tk, tk_files, tk_errs = tenken_build.build(toc, notes, docs)
        if tk_errs:
            print("点検のデータに問題があります。書き出しを止めました:", *tk_errs, sep="\n  ")
            sys.exit(1)
        tk["srclist"] = []
        for k in ("sogo", "ji"):
            sx = tk["src"][k]
            tk["srclist"].append({"t": sx["of"] + ("　確認項目及び確認文書（Excel）" if k == "sogo" else ""), "u": sx["u"], "n": sx["by"]})
            if sx.get("page"):
                tk["srclist"].append({"t": "障害福祉分野における指導監督（厚生労働省のページ）", "u": sx["page"], "n": "確認項目及び確認文書のPDF版・集団指導・運営指導マニュアルなど"})
        app = app.replace("/*@TENKEN@*/", (SRC / "tenken.js").read_text(encoding="utf-8"))
    else:
        shell = re.sub(r"<!--GSNAV-->[\s\S]*?<!--/GSNAV-->", "", shell)
        shell = re.sub(r"<!--NKTAB-->[\s\S]*?<!--/NKTAB-->", "", shell)
        shell = re.sub(r"<!--TKNAV-->[\s\S]*?<!--/TKNAV-->", "", shell)
        shell = re.sub(r"<!--TKTAB-->[\s\S]*?<!--/TKTAB-->", "", shell)
        shell = re.sub(r"<!--TK-->[\s\S]*?<!--/TK-->", "", shell)
    if tk:
        shell = re.sub(r"<!--LKTAB-->[\s\S]*?<!--/LKTAB-->", "", shell)
    shell = re.sub(r"<!--/?(TKNAV|GSNAV|TKTAB|NKTAB|TK|LKTAB)-->", "", shell)
    up = "../" if fid == "shogai" else "../../"
    rep = dict(txt, BACK=up, FSW=fsw(fid), SVC_LABEL=conf["svcLabel"])
    for k, v in rep.items():
        shell = shell.replace("{{" + k + "}}", v)
    left = re.findall(r"\{\{[A-Z_]+\}\}", shell)
    if left:
        print(fid, "部品の差し込みが残っています:", left); sys.exit(1)
    data = {"docs": docs, "toc": toc, "notes": notes, "field": conf}
    if tk:
        data["tk"] = {k: v for k, v in tk.items() if k != "srclist"}
    head = HEAD.format(title=conf["title"], desc=txt["desc"], ogdesc=txt["ogdesc"], dir=FIELD_DIR[fid], up=up)
    html = (head + "<style>\n" + RESET + css + "\n</style>\n</head>\n<body>\n" + shell
            + '\n<script type="application/json" id="data">\n' + embed(data) + "\n</script>\n"
            + "<script>\n" + app + "\n</script>\n</body>\n</html>\n")
    groups, items = link_groups_items(docs, tk, fid)
    html, added, lost, n_links = linkbook.build(html, groups, items, {}, lambda u: "pref", "虐待" if fid != "hoiku" else "送迎")
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
    if toc and not (out_dir / "kw.json").exists():
        bad.append(f"{out_dir}/kw.json（検索の索引）がありません。extract.py（高齢・保育は extract_field.py）を実行してください")
    if bad:
        print(fid, "書き出しを止めました:", *bad, sep="\n  ")
        sys.exit(1)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(html, encoding="utf-8")
    if tk_files:
        tdir = out_dir / "tenken"   # サービスごとの点検表（開いたときに読む）
        tdir.mkdir(exist_ok=True)
        for f in tdir.glob("*.json"):
            if f.stem not in tk_files:
                f.unlink()
        for sid, obj in tk_files.items():
            (tdir / (sid + ".json")).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_notes = sum(len(v) for v in notes.values())
    print(out_dir / "index.html", len(html.encode("utf-8")) // 1024, "KB", "資料", len(docs["items"]), "点", "見出しのある資料", len(toc), "編",
          "要点", n_notes, "見出し", "資料一覧", n_links, "件")
    if tk:
        print("  点検表", len(tk_files), "サービス", "確認項目", sum(x["n"] for x in tk["index"]), "（標準以外を含め", sum(x["na"] for x in tk["index"]), "）",
              "県の資料から", sum(x["nk"] for x in tk["index"]), "減算", len(tk["gensan"]), "年間", len(tk["nenkan"]["items"]))
    if missing:
        print(f"  要点のない見出し {len(missing)} 件（資料の差し替えで見出しが変わったときは、要点を作り直す）", *missing[:8], sep="\n    ")
    if unmatched:
        print(f"  見出しと結びつかなかった要点 {len(unmatched)} 件", *unmatched[:8], sep="\n    ")


def main():
    fields = [a for a in sys.argv[1:] if a in FIELD_LABEL] or list(FIELD_LABEL)
    for fid in fields:
        if fid != "shogai" and not (SRC / fid / "docs.json").exists():
            print(fid, "の docs.json がありません。extract_field.py を実行してください"); sys.exit(1)
        build_field(fid)


if __name__ == "__main__":
    main()
