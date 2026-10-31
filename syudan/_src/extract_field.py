#!/usr/bin/env python3
"""高齢（介護保険の集団指導）と保育（保育所等の指導監査）の、県のページの資料の一覧と検索の索引を作る。

  python3 syudan/_src/extract_field.py <kourei|hoiku> 作業用のフォルダ（リポジトリの外） [--if-changed] [--texts=フォルダ]
    --texts=フォルダ … PDFを取らず、フォルダの <添付の番号>.txt（fetchtext.py で取った文字）を使う
    --if-changed … 県のページの資料の並び（題名・URL・容量）が docs.json と同じなら、PDF を取らずに終わる（毎朝の確認用）。
                   変わっていたら docs.json を書き直し、見出しと要点の作り直しが要る資料を表示して終了コード 3 で終わる。

作るもの（本文の複製は持たない。台帳の「全文をコピーして保存しない」と、県のサイトの著作権の表示に合わせる）:
  syudan/_src/<分野>/docs.json … 県のページに並ぶ資料の一覧（題名・URL・区分・どのサービス向けか）
  syudan/<分野>/kw.json        … 検索用の語の索引（見出しで区切った単位ごとの語の集合。文や語順は持たない）
見出し（syudan/_src/<分野>/toc.json）と要点（notes/）は、照合係2人の照合を通して Chat で作る（障がいの extract.py と違い、
資料の目次の形がまちまちなため）。このスクリプトは toc.json の見出しの頁を使って索引を区切る。
ページとPDFは scripts/fetchtext.py で取る（WebFetch は使わない）。
"""
import datetime, json, pathlib, re, subprocess, sys

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "syudan" / "_src"
sys.path.insert(0, str(SRC))
import extract as E  # noqa: E402  障がいの extract.py の部品（語の索引・正規化）

FIELDS = {
    "kourei": {
        "page": "https://www.pref.fukuoka.lg.jp/contents/kaigo-syhudan-r8.html",
        "year": "令和8年度",
        "services": [
            {"id": "houmon", "t": "訪問サービス", "names": "訪問介護・訪問入浴介護・訪問看護", "docs": ["houmon", "kango"]},
            {"id": "tsusho", "t": "通所サービス", "names": "通所介護・地域密着型通所介護・通所リハビリテーション・訪問リハビリテーション", "docs": ["tsusho", "tsuriha"]},
            {"id": "iryo", "t": "介護医療院・短期入所", "names": "介護医療院・短期入所療養介護・短期入所生活介護", "docs": ["iryoin", "tanryo", "tanki"]},
            {"id": "tokutei", "t": "特定施設入居者生活介護", "names": "特定施設入居者生活介護・地域密着型特定施設入居者生活介護", "docs": ["tokutei"]},
            {"id": "yogu", "t": "福祉用具", "names": "福祉用具貸与・特定福祉用具販売", "docs": ["yogu"]},
            {"id": "tokuyo", "t": "介護老人福祉施設", "names": "指定介護老人福祉施設", "docs": ["tokuyo"]},
            {"id": "roken", "t": "介護老人保健施設", "names": "介護老人保健施設", "docs": ["roken"]},
            {"id": "ryoyo", "t": "居宅療養管理指導", "names": "医師・歯科医師・薬剤師・管理栄養士・歯科衛生士等", "docs": ["ryoyo", "ryoyoi", "ryoyos", "ryoyoy"]},
        ],
        # 県のページの区切りの行 → (区分, 対象のサービス)
        "groups": [
            ("サービス共通資料", "説明資料", ["*"]),
            ("【各サービス共通資料関連資料】", "参考資料", ["*"]),
            ("個別サービス（訪問サービス）", "説明資料", ["houmon"]),
            ("個別サービス（通所サービス）", "説明資料", ["tsusho"]),
            ("個別サービス（介護医療院、短期入所サービス）", "説明資料", ["iryo"]),
            ("個別サービス（特定施設入居者生活介護）", "説明資料", ["tokutei"]),
            ("個別サービス（福祉用具）", "説明資料", ["yogu"]),
            ("個別サービス（介護老人福祉施設）", "説明資料", ["tokuyo"]),
            ("個別サービス（介護老人保健施設）", "説明資料", ["roken"]),
            ("個別サービス（居宅療養管理指導）", "説明資料", ["ryoyo"]),
            ("【関連資料】", "参考資料", ["*"]),
            ("福岡県各課からのお知らせ", "参考資料", ["*"]),
            ("関連情報", "参考資料", ["*"]),
        ],
        "start": "サービス共通資料", "end": "このページに関するお問い合わせ",
        # 見出しを持つ資料（添付の番号 → 資料の id）
        "index": {"291627": "kc", "289762": "kcb", "289743": "kcc", "296015": "jorei", "294031": "houmon", "294032": "kango",
                  "294583": "tsusho", "294034": "tsuriha", "295764": "iryoin", "295765": "tanryo", "295767": "tanki", "295768": "tokutei",
                  "295769": "yogu", "295770": "tokuyo", "295771": "roken", "268653": "ryoyo", "268650": "ryoyoi", "268651": "ryoyos", "268652": "ryoyoy"},
        # 共通資料１～２ は同じ行に古い版（289741）と新しい版（291627・容量の表示つき）の2つのリンクがある。新しい版だけを載せる
        "skip": ["https://www.pref.fukuoka.lg.jp/uploaded/attachment/289741.pdf"],
        "deadline": (r"（１）介護サービス事業所（県所管のみ）\s*提出期限：令和(\d+)年(\d+)月(\d+)日", "書類確認報告の提出期限"),
    },
    "hoiku": {
        "page": "https://www.pref.fukuoka.lg.jp/contents/hoikusyotoukannsaminaoshi.html",
        "page2": "https://www.pref.fukuoka.lg.jp/contents/goudoukansasiryou31.html",
        "year": "",
        "services": [],
        "index": {"771051_62496585": "htsuchi", "771051_62496588": "htebiki"},
        "skip": [],
    },
}


def fetch(url, out):
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "fetchtext.py"), url, "-o", str(out)] + (["--links"] if url.endswith(".html") else []),
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("取得できませんでした: " + url + " " + r.stderr)
    return out.read_text(encoding="utf-8")


SIZE = re.compile(r"\s*\[(PDF|Word|Excel)ファイル／([\d.]+[KM]B)\]")


def page_items(text, start, end, groups, skip, page_url):
    """ページの本文の行を上から読み、区切りの行（groups）ごとに、その行に含まれるリンクを資料として拾う。
    start は本文の資料の並びが始まる行（行の文字と一致する最初の行）、end はそこから先で並びが終わる行の頭"""
    body, links = text.split("--- リンク ---")
    links = [l.split("\t", 1) for l in links.strip().splitlines() if "\t" in l]
    all_lines = [l.strip().replace("\u200b", "") for l in body.splitlines()]
    all_lines = [l for l in all_lines if l]
    i = next(n for n, l in enumerate(all_lines) if l == start)
    j = next((n for n in range(i, len(all_lines)) if all_lines[n].startswith(end)), len(all_lines))
    lines = all_lines[i:j]
    gmap = {g: (part, svc) for g, part, svc in groups}
    items, used, group, sub = [], set(), None, ""
    for ln in lines:
        if ln in gmap:
            group, sub = ln, ""
            continue
        if group is None:
            continue
        if ln.startswith(("〇", "○")) and not SIZE.search(ln):   # 「〇 介護事故防止について」のような小見出し
            sub = re.sub(r"^[〇○]\s*", "", ln)
            continue
        sl = E.squash(ln)
        size = SIZE.search(ln)
        want = {"PDF": r"\.pdf$", "Word": r"\.docx?$", "Excel": r"\.xlsx?$"}.get(size.group(1)) if size else None

        def hit(t):
            tt = E.squash(SIZE.sub("", t))
            if tt:
                return sl.startswith(tt) or (bool(size) and len(tt) >= 10 and tt in sl)
            # 文字が容量の表示だけのリンク（「共通資料１～２」の新しい版）
            return bool(size) and E.squash(t) == E.squash(size.group(0).strip())
        cands = [(k, t, u) for k, (t, u) in enumerate(links)
                 if t and k not in used and u not in skip and not u.startswith(page_url + "#") and hit(t)
                 and not re.search(r"pref\.fukuoka\.lg\.jp/life/[\d/]+$", u)]   # 県のサイトの分類のページ（メニュー）は資料ではない
        cands.sort(key=lambda x: (not (want and re.search(want, x[2])), not E.squash(SIZE.sub("", x[1])), -len(E.squash(x[1]))))
        if not cands:
            if len(ln) <= 24 and "。" not in ln and not ln.startswith(("※", "（")):
                sub = ln   # 課の名前などの短い行
            continue
        k, t, u = cands[0]
        used.add(k)
        title = SIZE.sub("", re.sub(r"\s*※.*$", "", ln)).strip(" ・\u3000")
        if any(it["u"] == u and it["g"] == group for it in items):
            continue
        part, svc = gmap[group]
        kind = size.group(1) if size else ("動画" if "youtu" in u else ("HTML" if not re.search(r"\.(pdf|docx?|xlsx?)$", u) else "PDF" if u.endswith(".pdf") else ""))
        items.append({"part": part, "g": group, "t": title, "u": u, "kind": kind, "size": size.group(2) if size else "",
                      "note": sub if sub and sub != title else "", "svc": svc})
    return items


def parse_kourei(work, cfg):
    text = fetch(cfg["page"], work / "page.txt")
    items = page_items(text, cfg["start"], cfg["end"], cfg["groups"], cfg["skip"], cfg["page"])
    body = text.split("--- リンク ---")[0]
    ptitle = body.strip().splitlines()[0].split(" - ")[0].strip()
    m = re.search(cfg["deadline"][0], E.nk(body).replace("１", "1"), re.S) or re.search(cfg["deadline"][0], body, re.S)
    dl = ""
    if m:
        dl = f"{2018 + int(E.nk(m.group(1)))}-{int(E.nk(m.group(2))):02d}-{int(E.nk(m.group(3))):02d}"
    groups = []
    for it in items:
        if it["g"] not in [g["g"] for g in groups]:
            groups.append({"g": it["g"], "part": it["part"], "label": it["g"].strip("【】")})
    return {"year": cfg["year"], "page": cfg["page"], "pageTitle": ptitle, "deadline": dl, "deadlineLabel": cfg["deadline"][1],
            "services": cfg["services"], "groups": groups, "items": items}


def parse_hoiku(work, cfg):
    t1 = fetch(cfg["page"], work / "page.txt")
    t2 = fetch(cfg["page2"], work / "page2.txt")
    g1 = [("安全管理重点確認監査", "説明資料", ["*"])]
    b1 = t1.split("--- リンク ---")[0]
    items = page_items(t1, "印刷ページ表示", "※令和", [("印刷ページ表示", "説明資料", ["*"])], [], cfg["page"])
    for it in items:
        it["g"] = "保育所等の指導監査（安全管理重点確認監査）"
    g2 = [("保育所 合同監査資料 （こちらからダウンロードできます。）", "様式", ["*"]),
          ("幼保連携型認定こども園 合同監査資料（こちらからダウンロードできます。）", "様式", ["*"]),
          ("社会福祉法人指導監査資料（リンク先でダウンロードしてください。）", "様式", ["*"])]
    items2 = page_items(t2, g2[0][0], "このページに関するお問い合わせ", g2, [], cfg["page2"])
    for it in items2:
        it["g"] = {"保育所 合同監査資料 （こちらからダウンロードできます。）": "保育所の合同監査資料",
                   "幼保連携型認定こども園 合同監査資料（こちらからダウンロードできます。）": "幼保連携型認定こども園の合同監査資料",
                   "社会福祉法人指導監査資料（リンク先でダウンロードしてください。）": "社会福祉法人の指導監査資料"}[it["g"]]
    items = [it for it in items if it["u"] != cfg["page2"]] + items2
    p1 = b1.strip().splitlines()[0].split(" - ")[0].strip()
    p2 = t2.split("--- リンク ---")[0].strip().splitlines()[0].split(" - ")[0].strip()
    groups = []
    for it in items:
        if it["g"] not in [g["g"] for g in groups]:
            groups.append({"g": it["g"], "part": it["part"], "label": it["g"]})
    return {"year": cfg["year"], "page": cfg["page"], "pageTitle": p1, "page2": cfg["page2"], "page2Title": p2, "deadline": "", "deadlineLabel": "",
            "services": [], "groups": groups, "items": items}


def same_list(a, b):
    key = lambda d: [(x["g"], x["t"], x["u"], x["size"]) for x in d.get("items", [])] + [d.get("deadline")]
    return key(a) == key(b)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2 or args[0] not in FIELDS:
        sys.exit(__doc__)
    fid, work = args[0], pathlib.Path(args[1]).resolve()
    if ROOT in work.parents or work == ROOT:
        sys.exit("作業用のフォルダはリポジトリの外にしてください")
    work.mkdir(parents=True, exist_ok=True)
    cfg = FIELDS[fid]
    fsrc = SRC / fid
    docs = (parse_kourei if fid == "kourei" else parse_hoiku)(work, cfg)
    if not docs["items"]:
        sys.exit("県のページの形が変わったようです（資料が読めません）。書き出しを止めました")
    old = fsrc / "docs.json"
    olddocs = json.loads(old.read_text(encoding="utf-8")) if old.exists() else None
    if "--if-changed" in sys.argv and olddocs and same_list(docs, olddocs):
        print(f"{fid}: 県のページの資料に変更はありません")
        return
    docs["extractedAt"] = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y-%m-%d")
    toc = json.loads((fsrc / "toc.json").read_text(encoding="utf-8")) if (fsrc / "toc.json").exists() else []
    by_id = {d["id"]: d for d in toc}
    changed = []
    if olddocs:
        before = {x["u"]: x for x in olddocs["items"]}
        for it in docs["items"]:
            b = before.get(it["u"])
            aid = re.search(r"/(?:attachment|life)/([\d_]+?)(?:_misc)?\.pdf$", it["u"])
            if aid and aid.group(1) in cfg["index"] and (not b or b["size"] != it["size"]):
                changed.append(f'{cfg["index"][aid.group(1)]}（{it["t"]}）')
    kw = {"docs": [], "pages": {}}
    for it in docs["items"]:
        aid = re.search(r"/(?:attachment|life)/([\d_]+?)(?:_misc)?\.pdf$", it["u"])
        if not aid or aid.group(1) not in cfg["index"]:
            continue
        did = cfg["index"][aid.group(1)]
        it["id"] = did
        d = by_id.get(did)
        if not d:
            continue
        local = next((pathlib.Path(x.split("=", 1)[1]) / (aid.group(1) + ".txt") for x in sys.argv if x.startswith("--texts=")), None)
        if local and local.exists():   # 取得済みの文字（作業用のフォルダ）を使う
            pages = local.read_text(encoding="utf-8").split("\f")
        else:
            pages = fetch(it["u"], work / (did + ".txt")).split("\f")
        if pages and not pages[-1].strip():
            pages = pages[:-1]
        if len(pages) != d["pages"]:
            changed.append(f"{did}（頁数が {d['pages']} → {len(pages)}）")
        L = [E.nk(p).splitlines() for p in pages]
        secs = []
        for s in d["secs"]:
            pos = E.find_head(L, s["t"], max(0, s["p"] - 2), s["p"] - 1)
            sub = [dict(x, _li=E.find_head(L, x["t"], max(0, x["p"] - 2), x["p"] - 1)[1]) for x in s["sub"]]
            secs.append(dict(s, _li=pos[1] if pos[0] == s["p"] - 1 else 0, sub=sub))
        di = len(kw["docs"])
        kw["docs"].append(did)
        E.index_segments(kw, di, secs, pages)
    fsrc.mkdir(parents=True, exist_ok=True)
    (fsrc / "docs.json").write_text(json.dumps(docs, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    if kw["docs"]:
        out = ROOT / "syudan" / fid
        out.mkdir(parents=True, exist_ok=True)
        (out / "kw.json").write_text(json.dumps(kw, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{fid}: 資料 {len(docs['items'])} 点・索引 {len(kw['pages'])} 区切り（{len(kw['docs'])} 編）")
    if changed and "--if-changed" in sys.argv:
        print("見出しと要点の作り直しが要る資料:", "、".join(changed))
        sys.exit(3)


if __name__ == "__main__":
    main()
