#!/usr/bin/env python3
"""障害児支援の「主眼事項及び着眼点等」（国の通知の別紙）の PDF を、点検表のデータにする。

  python3 syudan/_src/tenken_tools/kakunin_ji.py <指定障害児通所支援事業者等の指導監査について.pdf>
  → syudan/_src/tenken/ji.json

- 出典: こども家庭庁支援局長・厚生労働省社会・援護局障害保健福祉部長「指定障害児通所支援事業者等の指導監査について」
  （平成26年3月28日 障発0328第4号、最終改正 令和8年10月1日）別紙「主眼事項及び着眼点等」
  https://www.mhlw.go.jp/content/261002-1.pdf
- 通知の本文: 運営指導は別紙の「下線を付した項目」（標準確認項目）を確認する。下線は PDF の細い矩形として
  描かれているので、文字の真下に細い矩形があるかで下線の文字を見分ける。
- 国の通知の別紙なので、文は変えずに持つ（表の中の折り返しをつなぐだけ）。下線の範囲も文字の位置で持つ。
- 表は4列（主眼事項・着眼点・根拠法令・確認文書）。列の境目はページごとに縦の罫線から取る。
依存: pdfplumber
"""
import json, pathlib, re, sys, hashlib
import pdfplumber

OUT = pathlib.Path(__file__).resolve().parent.parent / "tenken" / "ji.json"
SRC_URL = "https://www.mhlw.go.jp/content/261002-1.pdf"

SERVICES = [  # (別紙の見出しの名前, id, 呼び名, 県の区分)
    ("指定児童発達支援", "jihatsu", "児童発達支援", "ji"),
    ("指定放課後等デイサービス", "hodei", "放課後等デイサービス", "ji"),
    ("指定居宅訪問型児童発達支援", "kyotaku-ji", "居宅訪問型児童発達支援", "ji"),
    ("指定保育所等訪問支援", "hoikusho", "保育所等訪問支援", "ji"),
    ("指定福祉型障害児入所施設等", "fukushi-nyusho", "福祉型障害児入所施設", "ji"),
    ("指定医療型障害児入所施設等", "iryo-nyusho", "医療型障害児入所施設", "ji"),
    ("指定障害児相談支援", "ji-soudan", "障害児相談支援", "soudan"),
]
ZEN = str.maketrans("0123456789", "０１２３４５６７８９")
ITEM = re.compile(r"^（[０-９0-9]+）")
L1 = re.compile(r"^第[０-９0-9]+")
L2 = re.compile(r"^[０-９0-9]+(の[０-９0-9]+)?[ 　]")


def key(*parts):
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


def page_columns(p):
    """縦の罫線の x（表の列の境目）と、表の上端・下端。
    着眼点の中に小さな表がある頁もあるので、x ごとに縦線の長さを足し、左右の端を除いて長いものから3本を列の境目にする"""
    vs = [r for r in p.rects if r["width"] < 1.2 and r["height"] > 8]
    if not vs:
        return None
    tot = {}
    for r in vs:
        x = round(r["x0"])
        k = next((k for k in tot if abs(k - x) <= 4), x)
        tot[k] = tot.get(k, 0) + r["height"]
    xs = sorted(tot)
    if len(xs) < 5:
        return None
    left, right = xs[0], xs[-1]
    inner = sorted(sorted(xs[1:-1], key=lambda x: -tot[x])[:3])
    top = min(r["top"] for r in vs)
    bottom = max(r["bottom"] for r in vs)
    return [left] + inner + [right], top, bottom


def lines_in(chars, x0, x1, ulines):
    """列の中の文字を行にまとめる。各行 = {top, x0, text, u: [下線の文字か]}"""
    cs = [c for c in chars if x0 <= (c["x0"] + c["x1"]) / 2 < x1 and c["text"].strip()]
    cs.sort(key=lambda c: (round(c["top"]), c["x0"]))
    rows = []
    for c in cs:
        if rows and abs(rows[-1]["top"] - c["top"]) < 2.5:
            rows[-1]["cs"].append(c)
        else:
            rows.append({"top": c["top"], "cs": [c]})
    out = []
    for r in rows:
        cs = sorted(r["cs"], key=lambda c: c["x0"])
        text, u, prev = "", [], None
        for c in cs:
            if prev is not None and c["x0"] - prev["x1"] > max(3.5, (prev["x1"] - prev["x0"]) * 0.55):
                text += " "; u.append(u[-1] if u else False)
            text += c["text"]
            mid = (c["x0"] + c["x1"]) / 2
            u.append(any(l["x0"] - 1 <= mid <= l["x1"] + 1 and c["bottom"] - 2 <= l["top"] <= c["bottom"] + 4.5 for l in ulines))
            prev = c
        out.append({"top": r["top"], "x0": cs[0]["x0"], "x1": cs[-1]["x1"], "text": text, "u": u})
    return out


def main(path):
    pdf = pdfplumber.open(path)
    # 各サービスの別紙が始まるページ
    starts = []
    for i, p in enumerate(pdf.pages):
        t = p.extract_text() or ""
        m = re.search(r"主眼事項及び着眼点等（([^）]+)）", t)
        if m and (not starts or starts[-1][1] != m.group(1)):
            starts.append((i, m.group(1)))
    names = {s[0]: s for s in SERVICES}
    services = []
    for si, (pi, nm) in enumerate(starts):
        if nm not in names:
            continue
        end = starts[si + 1][0] if si + 1 < len(starts) else len(pdf.pages)
        _, sid, label, grp = names[nm]
        col = [[], [], [], []]
        for pn in range(pi, end):
            p = pdf.pages[pn]
            cols = page_columns(p)
            if not cols:
                continue
            xs, ttop, tbot = cols
            ulines = [r for r in p.rects if r["height"] < 1.5 and r["width"] > 4 and r["x0"] > xs[1] + 1.5 and r["x1"] < xs[2] - 1.5]
            chars = [c for c in p.chars if ttop - 1 <= c["top"] <= tbot]
            cl = [lines_in(chars, xs[k], xs[k + 1], ulines if k == 1 else []) for k in range(4)]
            # 表の見出し行（主眼事項・着眼点・根拠法令・確認文書）を除く
            hdr = [l["top"] for l in cl[0] + cl[1] if re.sub(r"\s", "", l["text"]) in ("主眼事項", "着眼点")]
            if hdr:
                h = max(hdr) + 4
                cl = [[l for l in c if l["top"] > h] for c in cl]
            for k in range(4):
                for l in cl[k]:
                    l["pn"], l["left"], l["right"] = pn, xs[k], xs[k + 1]
                    col[k].append(l)
        pos = lambda l: (l["pn"], l["top"])
        # 主眼事項: 第N（大）と N（小）の見出し。折り返しの行はその見出しに足す
        # 「（児童発達支援センターの場合）」のように（ で始まる行は、見出しではなく対象の注記（その高さ以降の項目に付ける）
        heads, quals, l1, l2, last = [], [], "", "", None
        for l in sorted(col[0], key=pos):
            s = l["text"].strip()
            if L1.match(s):
                l1, l2 = s, ""
                last = {"l1": l1, "l2": "", "at": pos(l), "lv": 1}
                heads.append(last)
            elif L2.match(s):
                l2 = s
                last = {"l1": l1, "l2": l2, "at": pos(l), "lv": 2}
                heads.append(last)
            elif s.startswith("（") and heads:
                last = {"q": s, "at": pos(l), "lv": 3, "h": heads[-1]}
                quals.append(last)
            elif last is not None:
                if last["lv"] == 1:
                    last["l1"] += s; l1 = last["l1"]
                elif last["lv"] == 2:
                    last["l2"] += s; l2 = last["l2"]
                else:
                    last["q"] += s
        for i, h in enumerate(heads):   # 大見出しの折り返しを、後に続く小見出しにも反映
            if h["lv"] == 2:
                big = [x for x in heads[:i] if x["lv"] == 1]
                if big:
                    h["l1"] = big[-1]["l1"]

        def qual_at(l, h):
            qs = [q for q in quals if q["h"] is h and q["at"] <= (l["pn"], l["top"] + 2.5)]
            return qs[-1]["q"] if qs else ""

        def head_at(l):
            hs = [h for h in heads if h["at"] <= (l["pn"], l["top"] + 2.5)]
            return hs[-1] if hs else None
        # 着眼点:（N）で始まり字下げのない行が新しい項目。主眼事項が変わる行も新しい項目
        items, cur = [], None
        for l in sorted(col[1], key=pos):
            s = l["text"].strip()
            hd = head_at(l)
            new_item = ITEM.match(s) and l["x0"] < l["left"] + 12
            if cur is not None and hd is not cur["h"]:
                new_item = True
            if new_item:
                if cur:
                    items.append(cur)
                cur = {"h": hd, "q": qual_at(l, hd), "parts": [], "law": [], "docs": [], "at": pos(l), "p": l["pn"] + 1}
            if cur is None:
                continue
            cur["parts"].append(l)
        if cur:
            items.append(cur)
        # 根拠法令・確認文書は列ごとに先に1件ずつにつなぎ（頁をまたぐ折り返しも）、つないだ1件の先頭の行の高さで
        # 始まっている項目（直前に始まった項目）に付ける
        def owner(l):
            cand = [it for it in items if it["at"] <= (l["pn"], l["top"] + 2.5)]
            return cand[-1] if cand else None
        for text, l in join_docs(col[3]):
            it = owner(l)
            if it is not None:
                it["docs"].append(text)
        for text, l in join_law(col[2]):
            it = owner(l)
            if it is not None:
                it["law"].append(text)
        seen = set()
        rows = build_rows(items, sid, seen)
        services.append({"id": sid, "t": label, "g": grp, "src": "ji", "pages": [pi + 1, end], "rows": rows})
    out = {"source": {"t": "主眼事項及び着眼点等（障害児支援）", "by": "こども家庭庁支援局長・厚生労働省社会・援護局障害保健福祉部長",
                      "of": "指定障害児通所支援事業者等の指導監査について（平成26年3月28日 障発0328第4号、最終改正 令和8年10月1日）別紙",
                      "u": SRC_URL},
           "services": services}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for s in services:
        n = sum(len(r["items"]) for r in s["rows"]); st = sum(1 for r in s["rows"] for i in r["items"] if i["u"])
        print(s["t"], "まとまり", len(s["rows"]), "着眼点", n, "うち下線あり", st)


def join_text(lines):
    """着眼点の行をつなぐ。一・二…やア・イ…で始まる小項目の行は改行を入れる。下線は文字ごとに保つ"""
    text, u = "", []
    for i, l in enumerate(lines):
        s = l["text"]
        lead = len(s) - len(s.lstrip())
        s2, u2 = s.strip(), l["u"][lead:lead + len(s.strip())]
        if i and re.match(r"^([一二三四五六七八九十]+[ 　]|[アイウエオカキクケコサシスセソ][ 　]|[①-⑳]|（[一二三四五六七八九十]+）|（経過措置）|※|イ |ロ |ハ |ニ |ホ )", s2):
            text += "\n"; u.append(False)
        text += s2; u += u2
    # 下線を [始まり, 終わり) の範囲に
    spans, st = [], None
    for i, f in enumerate(u + [False]):
        if f and st is None:
            st = i
        if not f and st is not None:
            spans.append([st, i]); st = None
    # 下線の間の改行だけ・空白だけの切れ目はつなぐ
    merged = []
    for a, b in spans:
        if merged and text[merged[-1][1]:a].strip() == "":
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return text, merged


def join_docs(lines):
    """確認文書の列を1件ずつにつなぐ。続きの行とみなすのは:
    前の行が列の右端近くまで詰まっていて「等」「）」で終わっていない／括弧が閉じていない／ひらがな・長音・閉じ括弧で始まる（「その他」を除く）
    戻り値: [(文書名, 先頭の行)]"""
    out, cur, first, prev = [], None, None, None
    for l in sorted(lines, key=lambda l: (l["pn"], l["top"])):
        s = l["text"].strip()
        if not s:
            continue
        cont = False
        if cur is not None:
            opened = cur.count("（") > cur.count("）") or cur.count("(") > cur.count(")")
            full = prev["right"] - prev["x1"] < 8 and not re.search(r"(等|）|\))$", cur)
            starts = re.match(r"^[ぁ-ゖー）)、。]", s) and not s.startswith("その他")
            cont = opened or full or bool(starts)
        if cont:
            cur += s
        else:
            if cur is not None:
                out.append((cur, first))
            cur, first = s, l
        prev = l
    if cur is not None:
        out.append((cur, first))
    # 別紙の中で「…届出書等体制等状況一覧表…」と区切りなく続いている箇所は、2件に分ける
    res = []
    for t, l in out:
        for part in re.split(r"(?<=届出書等)(?=.)", t):
            res.append((part, l))
    return res


def join_law(lines):
    """根拠法令の列: 「第」「の」数字などで始まる行は前の行の続き"""
    out, cur, first = [], None, None
    for l in sorted(lines, key=lambda l: (l["pn"], l["top"])):
        s = l["text"].strip()
        if not s:
            continue
        if cur is not None and re.match(r"^(第|の|[０-９0-9]|項|号|条|、|）|・)", s):
            cur += s
        else:
            if cur is not None:
                out.append((cur, first))
            cur, first = s, l
    if cur is not None:
        out.append((cur, first))
    return out


def build_rows(items, sid, seen):
    rows, by = [], {}
    for it in items:
        text, spans = join_text(it["parts"])
        law = " ".join(it["law"])
        docs = []
        for d in it["docs"]:
            if d not in docs:
                docs.append(d)
        h = it["h"] or {"l1": "", "l2": ""}
        rk = id(h)
        if rk not in by:
            k = key(sid, h["l1"], h["l2"])
            while k in seen:
                k = key(k, "+")
            seen.add(k)
            by[rk] = {"k": k, "sec": h["l1"], "t": h["l2"] or h["l1"], "items": [], "docs": [], "p": it["p"]}
            rows.append(by[rk])
        r = by[rk]
        ik = key(sid, h["l1"], h["l2"], text)
        while ik in seen:
            ik = key(ik, "+")
        seen.add(ik)
        r["items"].append({"k": ik, "x": text, "u": spans, "law": law, "docs": docs, "p": it["p"], **({"q": it["q"]} if it.get("q") else {})})
        for d in docs:
            if d not in r["docs"]:
                r["docs"].append(d)
    return rows


if __name__ == "__main__":
    main(sys.argv[1])
