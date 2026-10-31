"""下書き（drafts/<名前>.json）を機械で確かめ、照合係に渡す vchunks/・vdrafts/ を作る。
  python3 tools/check_k.py [名前…]   （名前を省くと drafts/ にあるもの全部）
確かめること: 項目の漏れ・並び／章の概要は part 1 だけ／見出しの文字がその頁にあるか・頁の並び・fixed の見出しが同じか／
根拠の抜き出しが原文にあるか（画像から読んだ根拠は除く）／文中の数字が原文にあるか／写しすぎ／使わない言葉
"""
import json, os, re, sys, unicodedata
from difflib import SequenceMatcher
sys.dont_write_bytecode = True
W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
nk = lambda s: unicodedata.normalize("NFKC", s or "")
sq = lambda s: re.sub(r"\s+", "", nk(s))
BAN = re.compile(r"まだ|(?<![ぁ-ん])いま(?![すせしそ])|今すぐ|いますぐ")
LEAD = re.compile(r"^(?:[（(][0-9０-９一-十]+[)）]|[①-⑳]|第[0-9０-９一-十]+|[0-9０-９]+(?:[－\-][0-9０-９]+)?[．.\s]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[．.\s]?|[ア-ン][．.\s]|【|〔)*")


def stmts(it):
    out = [("gist", it.get("gist", ""))]
    out += [(f"points.{i}", x) for i, x in enumerate(it.get("points") or [])]
    out += [(f"shiteki.{i}", x) for i, x in enumerate(it.get("shiteki") or [])]
    return [(k, v) for k, v in out if v]


def page_texts(item):
    """[p.N] で区切った本文を {N: 文字}"""
    out, cur = {}, None
    for ln in item["text"].split("\n"):
        m = re.match(r"^\[p\.(\d+)\]", ln)
        if m:
            cur = int(m.group(1)); out[cur] = ""
            continue
        if cur is not None:
            out[cur] += ln + "\n"
    return out


def head_key(t):
    t = sq(t)
    t2 = LEAD.sub("", t)
    return (t2 or t)[:10]


def lc(a, b):
    m = SequenceMatcher(None, a, b, autojunk=False).find_longest_match(0, len(a), 0, len(b))
    return a[m.a:m.a + m.size]


def check(name):
    ch = json.load(open(f"{W}/chunks/{name}.json"))
    dr = json.load(open(f"{W}/drafts/{name}.json"))
    probs = []
    src = {it["k"]: it for it in ch["items"]}
    dk = [it.get("k") for it in dr.get("items", [])]
    if dk != list(src):
        probs.append(("ALL", "-", f"項目の漏れ・並び 足りない {sorted(set(src) - set(dk))[:5]} 余分 {sorted(set(dk) - set(src))[:5]}"))
    flat, vitems = [], []
    # 章ごとに（part をまたいで）見出しを並べる
    by_ch = {}
    for it in dr.get("items", []):
        s = src.get(it.get("k"))
        if not s:
            continue
        by_ch.setdefault((s["doc"], s["ch"]), []).append((s, it))
    for (doc, chn), parts in by_ch.items():
        pts = {}
        for s, it in parts:
            pts.update(page_texts(s))
        allimgs = sorted({x for s, _ in parts for x in s.get("images", [])})
        chap_k = f"{doc}:{chn}"
        heads = []
        for s, it in parts:
            if s["part"] == 1:
                if not it.get("chapter"):
                    probs.append((s["k"], "chapter", "章の概要がない"))
            elif it.get("chapter"):
                probs.append((s["k"], "chapter", "part 2 以降に章の概要がある（使わない）"))
            hs = it.get("heads") or []
            if s["mode"] == "fixed":
                want = [(h["t"], h["p"]) for h in s.get("heads", [])]
                got = [(h.get("t"), h.get("p")) for h in hs]
                if want != got:
                    probs.append((s["k"], "heads", f"決まった見出しと違う {got[:2]} / {want[:2]}"))
            last = s["p"]
            for h in hs:
                p = h.get("p")
                if not isinstance(p, int) or not s["p"] <= p <= s["p_end"]:
                    probs.append((s["k"], "heads", f"頁が範囲外 {h.get('t', '')[:20]} p.{p}")); continue
                if p < last:
                    probs.append((s["k"], "heads", f"頁が逆順 {h.get('t', '')[:20]} p.{p}"))
                last = p
                key = head_key(h.get("t", ""))
                ptxt = sq(pts.get(p, ""))
                img = any(re.search(r"/p%d[a-z]?\.png$" % p, x) for x in s.get("images", []))
                if s["mode"] == "free" and key and key not in ptxt and not img:
                    probs.append((s["k"], "heads", f"見出しの文字がその頁にない p.{p} {h.get('t', '')[:30]}"))
                heads.append(h)
        # 照合用の項目（章・見出し）と本文
        pages = sorted(pts)
        first_h = heads[0]["p"] if heads else pages[-1]
        def rng(a, b):
            return "\n".join(f"[p.{q}]\n" + pts[q] for q in pages if a <= q <= b)
        def imgs(a, b):
            return [x for x in allimgs if a <= int(re.search(r"/p(\d+)[a-z]?\.png$", x).group(1)) <= b]
        chap = next((it.get("chapter") for s, it in parts if s["part"] == 1), None) or {}
        vitems.append({"k": chap_k, "t": parts[0][0]["t"], "kind": "chapter", "p": pages[0], "p_end": pages[-1],
                       "note": ("章の概要・要点は章全体（p.%d〜%d）をまとめたもの。この項目の text は章の頭から最初の見出しまで。"
                                "章の残りの本文は、同じファイルの k が「%s:」で始まる項目の text にある。" % (pages[0], pages[-1], chap_k)) if heads else "",
                       "text": rng(pages[0], first_h if heads else pages[-1]), "images": imgs(pages[0], first_h if heads else pages[-1]),
                       "_all": rng(pages[0], pages[-1])})
        flat.append(dict(chap, k=chap_k, t=parts[0][0]["t"]))
        for n, h in enumerate(heads, 1):
            b = heads[n]["p"] if n < len(heads) else pages[-1]
            hk = f"{chap_k}:{n}"
            vitems.append({"k": hk, "t": h["t"], "kind": "item", "chap": parts[0][0]["t"], "p": h["p"], "p_end": b,
                           "text": rng(h["p"], b), "images": imgs(h["p"], b)})
            flat.append(dict({x: h.get(x) for x in ("gist", "points", "shiteki", "ev")}, k=hk, t=h["t"], p=h["p"]))
    # 文の確かめ
    vt = {v["k"]: v for v in vitems}
    for it in flat:
        v = vt[it["k"]]
        text = sq(v.get("_all") or v["text"]) + sq(it["t"])
        evs = it.get("ev") or []
        for to, val in stmts(it):
            if not any(e.get("to") == to for e in evs):
                probs.append((it["k"], to, "根拠なし"))
            if not v["images"]:
                for n in re.findall(r"\d+(?:\.\d+)?", nk(val)):
                    if n not in text:
                        probs.append((it["k"], to, f"数字 {n} が原文にない: {val[:50]}"))
            c = lc(sq(val), text)
            if len(c) > 24:
                probs.append((it["k"], to, f"写しすぎ({len(c)}字): {c[:40]}"))
            if BAN.search(val):
                probs.append((it["k"], to, f"使わない言葉: {val[:40]}"))
        for e in evs:
            if e.get("img"):
                continue
            if sq(e.get("q", "")) not in text:
                probs.append((it["k"], e.get("to"), f"抜き出しが原文にない: {e.get('q', '')[:40]}"))
    os.makedirs(f"{W}/vchunks", exist_ok=True); os.makedirs(f"{W}/vdrafts", exist_ok=True)
    for v in vitems:
        v.pop("_all", None)
    json.dump({"chunk": name, "items": vitems}, open(f"{W}/vchunks/{name}.json", "w"), ensure_ascii=False, indent=1)
    json.dump({"chunk": name, "items": flat}, open(f"{W}/vdrafts/{name}.json", "w"), ensure_ascii=False, indent=1)
    return flat, probs


if __name__ == "__main__":
    names = sys.argv[1:] or sorted(f[:-5] for f in os.listdir(f"{W}/drafts") if f.endswith(".json"))
    total = 0
    for n in names:
        try:
            flat, probs = check(n)
        except Exception as e:
            print(f"== {n} 読めない: {e}"); continue
        print(f"== {n} 項目 {len(flat)}（見出し {sum(1 for x in flat if x['k'].count(':') == 2)}） 文 {sum(len(stmts(x)) for x in flat)} 問題 {len(probs)}")
        for p in probs[:40]:
            print("  ", *p)
        total += len(probs)
    print("問題の合計", total)
