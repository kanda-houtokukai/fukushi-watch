#!/usr/bin/env python3
"""福岡県の集団指導の資料から、ガイドが使うデータを作る（年度ごと・資料の差し替えがあったときに実行する）。

  python3 syudan/_src/extract.py 作業用のフォルダ（リポジトリの外） [--if-changed]
    --if-changed … 県のページの資料の並び（題名・URL・容量・注記）が docs.json と同じなら、PDF を取らずに終わる（毎朝の確認用）

作るもの（どれも本文の複製は持たない。理由は台帳の「全文をコピーして保存しない」＝県の著作物のため）:
  syudan/_src/docs.json … 県の集団指導のページに並ぶ資料の一覧（題名・URL・区分・どのサービス向けか）
  syudan/_src/toc.json  … 説明資料ごとの見出し（目次と本文の「（１）…」）と、PDFのページ番号
  syudan/kw.json        … 検索用の語の索引（ページごとの漢字・カタカナ・英数字の連なりの集合。文や語順は持たない）
ページとPDFは scripts/fetchtext.py で取る（WebFetch は使わない）。
"""
import datetime, json, pathlib, re, subprocess, sys, unicodedata

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "syudan" / "_src"
PAGE = "https://www.pref.fukuoka.lg.jp/contents/-contents-yudanr8.html"
YEAR = "令和8年度"

# サービスの区分（県の資料の区分どおり）
SERVICES = [
    {"id": "kyotaku", "t": "居宅訪問系", "names": "居宅介護・重度訪問介護・同行援護・行動援護"},
    {"id": "nicchu", "t": "通所（日中活動）系・入所系",
     "names": "療養介護・生活介護・短期入所・自立訓練（機能・生活）・就労移行支援・就労継続支援（Ａ型・Ｂ型）・就労定着支援・自立生活援助・障がい者支援施設"},
    {"id": "gh", "t": "共同生活援助", "names": "共同生活援助"},
    {"id": "ji", "t": "障がい児（通所・入所）系",
     "names": "児童発達支援・児童発達支援センター・放課後等デイサービス・居宅訪問型児童発達支援・保育所等訪問支援・障がい児入所施設"},
    {"id": "soudan", "t": "相談支援系", "names": "地域相談支援・計画相談支援・障がい児相談支援・一般相談支援"},
]
# 県のページの見出し（説明資料の区分・参考資料の区分）→ 対象のサービス。"*" は全サービス
GROUP_SVC = {
    "（１）全事業所共通": ["*"], "（２）居宅介護": ["kyotaku"], "（３）療養介護": ["nicchu"], "（４）共同生活援助": ["gh"],
    "（５）児童発達支援": ["ji"], "（６）地域相談支援": ["soudan"],
    "参考：全般": ["*"], "（１）生活介護事業所関連": ["nicchu"], "（２）就労系事業所関連": ["nicchu"],
    "（３）障がい児支援事業所等関連": ["ji"], "（４）共同生活援助関連": ["gh"], "（５）虐待防止関連": ["*"],
    "（６）業務継続計画関連": ["*"], "（７）サービス管理責任者": ["*"], "（８）事例集": ["*"],
    "（９）摂食嚥下関係": ["nicchu"], "（10）労働関係": ["*"], "（11）防災関係": ["*"], "（12）その他": ["*"],
}
# 見出しを索引にする資料（説明資料6編と、県の報酬改定・こども性暴力防止法の資料）
INDEX_IDS = {"297176": "common", "297294": "kyotaku", "297178": "nicchu", "297179": "gh", "297180": "ji",
             "297113": "soudan", "297119": "kaitei", "296739": "dbs"}


def fetch(url, out):
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "fetchtext.py"), url, "-o", str(out)] + (["--links"] if url.endswith(".html") else []),
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("取得できませんでした: " + url + " " + r.stderr)
    return out.read_text(encoding="utf-8")


def nk(s):
    return unicodedata.normalize("NFKC", s)


def squash(s):
    return re.sub(r"\s+", "", nk(s))


def parse_page(work):
    text = fetch(PAGE, work / "page.txt")
    body, links = text.split("--- リンク ---")
    links = [l.split("\t", 1) for l in links.strip().splitlines() if "\t" in l]
    i, j = body.find("１．説明資料"), body.find("皆様のご意見")
    lines = [l.strip() for l in body[i:j].splitlines() if l.strip()]
    deadline = re.search(r"登録期限：令和(\d+)年(\d+)月(\d+)日", body)
    reg = next((u for t, u in links if t.startswith("受講登録")), "")
    sched = next((u for t, u in links if t == "日程表"), "")
    items, part, group, used = [], "説明資料", None, set()
    for ln in lines:
        if ln.startswith("２．参考資料"):
            part, group = "参考資料", "参考：全般"
            continue
        m = re.match(r"^（(\d+|[１-９]|1[0-2])）(.+)$", ln)
        if m and "資料は、" not in ln:
            group = next((k for k in GROUP_SVC if ln.startswith(k)), ln[:12])
            continue
        if group is None:
            continue
        size = re.search(r"\[(PDF|Word|Excel)ファイル／([\d.]+[KM]B)\]", ln)
        want = {"PDF": r"\.pdf$", "Word": r"\.docx?$", "Excel": r"\.xlsx?$"}.get(size.group(1)) if size else None
        # その行に含まれるリンク（空白の違いを無視して照合）。同じ文字のリンクが複数あるときは、ファイルの種類が合い、まだ使っていないものを選ぶ
        sl = squash(ln)
        cands = [(k, t, u) for k, (t, u) in enumerate(links) if t and k not in used and squash(t) in sl]
        cands.sort(key=lambda x: (not (want and re.search(want, x[2])), -len(squash(x[1]))))
        if not cands:
            continue
        k, t, u = cands[0]
        used.add(k)
        if any(it["u"] == u and it["g"] == group for it in items):
            continue
        note = re.search(r"※(.+)$", ln)
        title = re.sub(r"\s*\[(PDF|Word|Excel)ファイル／[^\]]+\]", "", re.sub(r"\s*※.*$", "", ln)).strip(" ・\u3000")
        items.append({"part": part, "g": group, "t": title, "u": u,
                      "kind": (size.group(1) if size else ("HTML" if not re.search(r"\.(pdf|docx?|xlsx?)$", u) else "")),
                      "size": size.group(2) if size else "", "note": note.group(1).strip() if note else "",
                      "svc": GROUP_SVC.get(group, ["*"])})
    groups = []
    for it in items:
        if it["g"] not in [g["g"] for g in groups]:
            src_line = next((l for l in lines if l.startswith(it["g"])), it["g"])
            groups.append({"g": it["g"], "part": it["part"], "label": src_line if it["g"] != "参考：全般" else "全般"})
    ptitle = body.strip().splitlines()[0].split(" - ")[0].strip()
    return {"year": YEAR, "page": PAGE, "pageTitle": ptitle, "schedule": sched, "register": reg,
            "registerDeadline": f"{2018 + int(deadline.group(1))}-{int(deadline.group(2)):02d}-{int(deadline.group(3)):02d}" if deadline else "",
            "services": SERVICES, "groups": groups, "items": items}


def toc_entries(page_text):
    """目次のページから (見出し, 印字頁) を取る。2行に分かれた見出しはつなぐ。
    「○相談支援について」のような頁のない区分の行（次の行が「・」で始まる）は見出しにしない"""
    out, pend = [], ""
    for ln in nk(page_text).splitlines():
        s = ln.strip()
        if not s or s == "目次":
            continue
        if s.startswith("【"):
            break
        m = re.match(r"^(.*?)\s*(?:…|\.{2,})+\s*(\d+)\s*$", s)
        if m:
            body = m.group(1).strip()
            if body.startswith("・"):
                pend = ""
            title = (pend + body) if pend else body
            out.append((tidy(re.sub(r"^[・○〇\s]+", "", title)), int(m.group(2))))
            pend = ""
        else:
            pend = re.sub(r"^[○〇]\s*", "", s) if s[0] in "○〇" else (pend + s)
    return out


def tidy(t):
    """見出しの体裁をそろえる（レイアウト由来の空白を詰め、括弧を全角に）"""
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"(?<=[^\x00-\x7f]) (?=[^\x00-\x7f0-9])|(?<=[0-9]) (?=[^\x00-\x7f])|(?<=[^\x00-\x7f]) (?=[0-9])", "", t)
    t = re.sub(r"^(\d+)\s*\.\s*", r"\1．", t)
    return t.replace("(", "（").replace(")", "）").replace("<", "＜").replace(">", "＞").replace("~", "〜")


def find_head(L, title, lo, hint):
    """見出しの行 (頁, 行) を探す。印字頁から推した頁に近い順に、行頭が見出しで始まる行を優先する"""
    full = squash(title)
    key = squash(re.sub(r"^\s*\d+\s*[.．]\s*", "", title))[:16]
    order = sorted(range(lo, len(L)), key=lambda i: (abs(i - hint), i))
    for p in order:
        for li, ln in enumerate(L[p]):
            s = squash(ln)
            if s and (s.startswith(full[:18]) or (len(key) >= 4 and re.sub(r"^[\d.]+", "", s).startswith(key))):
                return p, li
    for p in order:
        for li, ln in enumerate(L[p]):
            if key and key in squash(ln):
                return p, li
    return min(max(hint, lo), len(L) - 1), 0


SUB = re.compile(r"^\s*\((\d{1,2})\)\s*(\S.*?)\s*$")
MARK = re.compile(r"^[\s]*($|[(（①-⑳ア-ンｱ-ﾝ・○〇●◆■□◎※【<＜\d])")
PART = tuple("のにをはがとでへやもより") + ("において",)


def subs_in(L, start, end):
    """(start..end) の範囲から「（１）…」の見出しを拾う。文の途中で折り返した行や、助詞で始まる行は除く"""
    out, seen = [], set()
    (p0, l0), (p1, l1) = start, end
    for p in range(p0, min(p1, len(L) - 1) + 1):
        lines = L[p]
        a = l0 if p == p0 else 0
        z = min(l1, len(lines)) if p == p1 else len(lines)
        for li in range(a, z):
            m = SUB.match(lines[li])
            if not m:
                continue
            t = m.group(2).strip()
            nxt = next((x.strip() for x in lines[li + 1:li + 3] if x.strip()), "")
            if t.startswith(PART) or "。" in t or t.endswith("、"):
                continue
            if (t.count("(") > t.count(")") or t.count("<") > t.count(">")) and nxt and len(nxt) < 40:
                t = t + nxt
                nxt = ""
            wrapped = len(t) >= 34 and nxt and lines[li + 1].strip() and not MARK.match(lines[li + 1])
            if wrapped and not re.search(r"省令第|基準第|<", t):
                if len(nxt) <= 20:  # 見出しが短い尾を残して折り返したもの（「…の特」「例について」）はつなぐ
                    t = t + nxt
                else:  # 文の途中で折り返した行（本文の箇条書き）は見出しにしない
                    continue
            if ("。" in t or len(t) > 90 or re.search(r"(こと|います|ている|ていない|である|ません)$", t)
                    or re.search(r"[のをにがはとで][一-龥ぁ-ん]$|(ない|ある|いる)、", t)):  # 語の途中で切れた行・文の途中
                continue
            t = tidy("(" + m.group(1) + ")" + t)
            if t not in seen:
                seen.add(t)
                out.append({"t": t, "p": p + 1, "_li": li})
    return out


def doc_toc(pages):
    """[{t, p, sub:[{t,p}]}]（p は PDF の1始まりのページ番号）"""
    L = [nk(pg).splitlines() for pg in pages]
    ents = toc_entries(pages[1]) if len(pages) > 1 and "目次" in pages[1][:300] else []
    heads = []
    if ents:
        first = find_head(L, ents[0][0], 2, 2)
        off = first[0] - ents[0][1]
        for t, pp in ents:
            heads.append((t, find_head(L, t, 2, pp + off)))
        heads.sort(key=lambda h: h[1])
        secs = []
        for i, (t, pos) in enumerate(heads):
            end = heads[i + 1][1] if i + 1 < len(heads) else (len(L) - 1, 10 ** 6)
            secs.append({"t": t, "p": pos[0] + 1, "_li": pos[1], "sub": subs_in(L, pos, end)})
        return secs
    # 目次がない資料（スライド）: 2頁目の「1.…」「2.…」を章、各頁の最初の行（スライドの題）を節にする
    chap = {}
    for ln in L[1] if len(L) > 1 else []:
        m = re.match(r"^\s*(\d)\s*[.．]\s*(\S.*?)\s*$", ln)
        if m:
            chap[m.group(1)] = tidy(m.group(1) + "." + m.group(2))
    secs, cur = [], None
    for i, lines in enumerate(L[2:], start=2):
        li, ttl = next(((k, x.strip()) for k, x in enumerate(lines) if x.strip() and not re.match(r"^\d{4}年\d+月\d+日$", x.strip())), (0, ""))
        if not ttl:
            continue
        m = re.match(r"^(\d)\s*\(", ttl)
        if m and m.group(1) in chap and (cur is None or cur["t"] != chap[m.group(1)]):
            cur = {"t": chap[m.group(1)], "p": i + 1, "_li": li, "sub": []}
            secs.append(cur)
        if cur is None:
            continue
        t = tidy(ttl)
        if not cur["sub"] or cur["sub"][-1]["t"] != t:
            cur["sub"].append({"t": t, "p": i + 1, "_li": li})
    return secs


WORD = re.compile(r"[一-龥々〆ヵヶ]+|[ァ-ヴー]+|[A-Za-z0-9]+")  # 漢字・カタカナ・英数字の連なり（1字から。「A型」「33条の12」も引けるように）
JOIN = re.compile(r"[A-Za-z0-9]+[一-龥々〆ヵヶ]")  # 英数字＋漢字1字のつながり（「A型」「33条」「2人」）。語順を持たない索引でも、この並びは区別できるように


def words_of(text):
    t = squash(text)
    return set(WORD.findall(t)) | set(JOIN.findall(t))


def index_segments(kw, di, secs, pages):
    """頁を見出しの位置で区切り、区切りごとに語の集合を作る（キー「資料:頁:見出しの番号」。-1 は最初の見出しより前）。
    見出しの番号は、章とその節を出てきた順に並べたときの位置（app.js の flat と同じ並び）"""
    flat = []
    for s in secs:
        flat.append(s)
        flat.extend(s["sub"])
    pos = [(x["p"] - 1, x["_li"]) for x in flat]
    for i, pg in enumerate(pages):
        lines = nk(pg).splitlines()
        active = max([k for k, q in enumerate(pos) if q[0] < i], default=-1)
        cuts = sorted((q[1], k) for k, q in enumerate(pos) if q[0] == i)
        start = 0
        for li, k in cuts + [(len(lines), None)]:
            words = sorted(words_of("\n".join(lines[start:li])))
            if words:
                key = f"{di}:{i + 1}:{active}"
                prev = kw["pages"].get(key)
                kw["pages"][key] = "|".join(sorted(set(words) | set(prev.split("|")))) if prev else "|".join(words)
            if k is not None:
                active, start = k, li


def strip_private(toc):
    for d in toc:
        for s in d["secs"]:
            s.pop("_li", None)
            for x in s["sub"]:
                x.pop("_li", None)
    return toc


def same_list(a, b):
    key = lambda d: [(x["g"], x["t"], x["u"], x["size"], x["note"]) for x in d.get("items", [])] + [d.get("registerDeadline"), d.get("register")]
    return key(a) == key(b)


def check_heads(toc, texts):
    """見出しの頁が合っているかを、取ったテキストで確かめる。
    戻り値: (節の不一致, 章の不一致)。章は目次の印字頁から割り出すため、本文の題が目次と違う資料
    （誤字・送付文・図の頁）では文字が一致しないことがある。節は本文から拾うので一致しなければ誤り"""
    bad_sub, bad_sec = [], []
    for d in toc:
        pages = texts[d["id"]]
        for s in d["secs"]:
            for x in [s] + s["sub"]:
                k = squash(re.sub(r"^(\d+．|（\d+）|\d（\d）)", "", x["t"]).replace("（", "(").replace("）", ")").replace("＜", "<").replace("＞", ">").replace("〜", "~"))[:10]
                if k and k not in squash(pages[x["p"] - 1]):
                    (bad_sec if x is s else bad_sub).append(f'{d["id"]} p.{x["p"]} {x["t"][:30]}')
    return bad_sub, bad_sec


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    work = pathlib.Path(args[0]).resolve()
    if ROOT in work.parents or work == ROOT:
        sys.exit("作業用のフォルダはリポジトリの外にしてください")
    work.mkdir(parents=True, exist_ok=True)
    docs = parse_page(work)
    if not docs["items"] or not docs["registerDeadline"]:
        sys.exit("県のページの形が変わったようです（資料または受講登録の期限が読めません）。書き出しを止めました")
    old = SRC / "docs.json"
    if "--if-changed" in sys.argv and old.exists() and same_list(docs, json.loads(old.read_text(encoding="utf-8"))):
        print("集団指導のページの資料に変更はありません")
        return
    docs["extractedAt"] = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y-%m-%d")
    toc, kw, texts = [], {"docs": [], "pages": {}}, {}
    for it in docs["items"]:
        aid = re.search(r"/attachment/(\d+)\.pdf$", it["u"])
        if not aid or aid.group(1) not in INDEX_IDS:
            continue
        did = INDEX_IDS[aid.group(1)]
        if did in texts:
            continue
        pages = fetch(it["u"], work / (aid.group(1) + ".txt")).split("\f")
        if pages and not pages[-1].strip():
            pages = pages[:-1]
        it["id"] = did
        texts[did] = [nk(p) for p in pages]
        toc.append({"id": did, "t": it["t"], "u": it["u"], "pages": len(pages), "secs": doc_toc(pages)})
        di = len(kw["docs"])
        kw["docs"].append(did)
        index_segments(kw, di, toc[-1]["secs"], pages)
    bad_sub, bad_sec = check_heads(toc, texts)
    for b in bad_sec:
        print("  （章の題が本文と一字一句は一致しない頁。目次の頁番号から割り出し）", b)
    for b in bad_sub:
        print("  ⚠ 節の見出しが、その頁に見当たりません:", b)
    n_sec = sum(len(d["secs"]) for d in toc)
    if bad_sub or len(bad_sec) > n_sec // 4:
        sys.exit("見出しと頁の対応が崩れています。書き出しを止めました")
    (SRC / "docs.json").write_text(json.dumps(docs, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (SRC / "toc.json").write_text(json.dumps(strip_private(toc), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (ROOT / "syudan" / "kw.json").write_text(json.dumps(kw, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"資料 {len(docs['items'])} 点・見出しを作った資料 {len(toc)} 編・索引 {len(kw['pages'])} 区切り")
    for d in toc:
        print(" ", d["id"], d["pages"], "頁", len(d["secs"]), "章", sum(len(s["sub"]) for s in d["secs"]), "節")


if __name__ == "__main__":
    main()
