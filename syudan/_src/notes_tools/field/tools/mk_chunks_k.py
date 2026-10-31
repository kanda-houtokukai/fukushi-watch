"""高齢（介護保険）の説明資料を、下書き係に渡すかたまり（chunks/）に分ける。 python3 tools/mk_chunks_k.py
- 章ごとに本文（[p.N] はPDFのNページ目）。55,000字を超える章はページの切れ目で分ける（part 2 以降は「続き」）
- 文字の取れないページ（日本語20字未満）は画像（img/<資料>/pN.png）を示す
- 共通資料は表紙・目次の統合目次の見出し（fixed）を渡す。個別の資料は下書き係が見出しを選ぶ（free）
"""
import json, os, re, sys, unicodedata, subprocess
sys.dont_write_bytecode = True
W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, W + "/tools"); import kourei_toc as K
PDF = "/tmp/claude-0/-home-claude/d3e68208-19dc-5758-b37a-438c236beec9/scratchpad/kourei/pdf/"
nk = lambda s: unicodedata.normalize("NFKC", s)
ID = {"291627": "kc", "289762": "kcb", "289743": "kcc", "296015": "jorei", "294031": "houmon", "294032": "kango",
      "294583": "tsusho", "294034": "tsuriha", "295764": "iryoin", "295765": "tanryo", "295767": "tanki", "295768": "tokutei",
      "295769": "yogu", "295770": "tokuyo", "295771": "roken", "268653": "ryoyo", "268650": "ryoyoi", "268651": "ryoyos", "268652": "ryoyoy"}
def pages(aid):
    p = open(f"{W}/txt/{aid}.txt", encoding="utf-8").read().split("\f")
    if p and not p[-1].strip(): p = p[:-1]
    return p
thin = lambda s: len(re.findall(r"[ぁ-んァ-ン一-龥]", s)) < 20
def ptext(pg, q, did, imgs):
    s = nk(pg[q - 1])
    s = "\n".join(re.sub(r"[ \t　]+", " ", l).rstrip() for l in s.splitlines() if l.strip())
    if thin(s):
        path = f"{W}/img/{did}/p{q}.png"
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            subprocess.run(["pdftoppm", "-f", str(q), "-l", str(q), "-r", "100", "-png", "-singlefile", PDF + [a for a, d in ID.items() if d == did][0] + ".pdf", path[:-4]], capture_output=True)
        imgs.append(path)
        return f"[p.{q}]（文字が取れないページ。画像 {path} を見る）\n" + s
    return f"[p.{q}]\n" + s
units = []   # {k, doc, ci, t, p, p_end, mode, heads?, part, parts, text, imgs}
ev = json.load(open(f"{W}/eval.json"))
# 共通資料（統合目次）
for aid, _did, chs in K.COMMON_PDF:
    did = ID[aid]
    pg = pages(aid)
    # 印字頁 → PDFの頁: 各PDFで最初の章の印字頁がPDFの何頁目か（表紙を除き、頁の下の数字で確かめる）
    first = K.COMMON[chs[0] - 1][1]
    off = None
    for i, x in enumerate(pg):
        ls = [l.strip() for l in nk(x).splitlines() if l.strip()]
        if ls and re.fullmatch(r"[-－]?\s*%d\s*[-－]?" % first, ls[-1]):
            off = i + 1 - first; break
    if off is None: off = 1 - first
    for n, cno in enumerate(chs):
        t, pp, subs = K.COMMON[cno - 1]
        a = max(1, pp + off)
        nxt = K.COMMON[cno][1] + off - 1 if cno < len(K.COMMON) and (n + 1 < len(chs)) else len(pg)
        heads = [{"t": st, "p": max(a, min(len(pg), sp + off))} for st, sp in subs]
        units.append({"doc": did, "ci": n + 1, "t": t, "p": a, "p_end": nxt, "mode": "fixed", "heads": heads, "pg": pg, "aid": aid})
for aid, secs in ev.items():
    did = ID[aid]; pg = pages(aid)
    for i, s in enumerate(secs):
        a = s["p"]; b = secs[i + 1]["p"] - 1 if i + 1 < len(secs) else len(pg)
        if b < a: b = a
        units.append({"doc": did, "ci": i + 1, "t": s["t"], "p": a, "p_end": b, "mode": "free", "pg": pg, "aid": aid})
for aid in ("268650", "268651", "268652"):
    did = ID[aid]; pg = pages(aid)
    title = {"ryoyoi": "居宅療養管理指導（医師）", "ryoyos": "居宅療養管理指導（歯科医師）", "ryoyoy": "居宅療養管理指導（薬剤師）"}[did]
    units.append({"doc": did, "ci": 1, "t": title, "p": 1, "p_end": len(pg), "mode": "free", "pg": pg, "aid": aid, "slides": True})
# 本文を付け、長い章を分ける
items = []
LIM = 55000
for u in units:
    imgs = []; parts = []; cur = []; size = 0; start = u["p"]
    for q in range(u["p"], u["p_end"] + 1):
        tx = ptext(u["pg"], q, u["doc"], imgs)
        if size + len(tx) > LIM and cur:
            parts.append((start, q - 1, "\n".join(cur))); cur = []; size = 0; start = q
        cur.append(tx); size += len(tx)
    parts.append((start, u["p_end"], "\n".join(cur)))
    for j, (a, b, tx) in enumerate(parts):
        it = {"k": f'{u["doc"]}:{u["ci"]}' + (f".{j+1}" if len(parts) > 1 else ""), "doc": u["doc"], "ch": u["ci"], "t": u["t"],
              "p": a, "p_end": b, "mode": u["mode"], "part": j + 1, "parts": len(parts), "text": tx,
              "images": sorted({x for x in imgs if a <= int(re.search(r"p(\d+)\.png", x).group(1)) <= b})}
        if u["mode"] == "fixed":
            it["heads"] = [h for h in u["heads"] if a <= h["p"] <= b]
        if u.get("slides"): it["slides"] = True
        items.append(it)
# かたまりに詰める（同じ資料は続けて・6万字まで）
chunks = []; cur = []; size = 0
for it in items:
    if cur and (size + len(it["text"]) > 60000 or (cur[-1]["doc"] != it["doc"] and size > 35000)):
        chunks.append(cur); cur = []; size = 0
    cur.append(it); size += len(it["text"])
if cur: chunks.append(cur)
os.makedirs(f"{W}/chunks", exist_ok=True)
for f in os.listdir(f"{W}/chunks"): os.remove(f"{W}/chunks/{f}")
names = []
for n, c in enumerate(chunks, 1):
    name = f"k{n:02d}"
    json.dump({"chunk": name, "items": c}, open(f"{W}/chunks/{name}.json", "w"), ensure_ascii=False, indent=1)
    names.append(name)
    print(name, sum(len(x["text"]) for x in c), "字", len(c), "項目", sum(len(x["images"]) for x in c), "画像", " ".join(x["k"] for x in c))
print("かたまり", len(chunks), "項目", len(items), "字", sum(len(x["text"]) for x in items))
