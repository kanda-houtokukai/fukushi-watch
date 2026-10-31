"""照合を通った文だけで、syudan/_src/<分野>/toc.json と notes/<資料>.json を書く。
  python3 tools/final_k.py [--draft] [--write]
  --draft … 照合前の下書きの文もすべて使う（画面の試しにだけ使う。公開しない）
文の採否: 1回目の照合で A・B とも合格 → 載せる。不合格で r2（直した文）があり、2回目の X・Y とも合格 → 直した文を載せる。それ以外は落とす。
"""
import json, os, re, sys, glob
sys.dont_write_bytecode = True
W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "/home/claude/fukushi-watch/syudan/_src"
DRAFT = "--draft" in sys.argv


def stmts(it):
    out = [("gist", it.get("gist", ""))]
    out += [(f"points.{i}", x) for i, x in enumerate(it.get("points") or [])]
    out += [(f"shiteki.{i}", x) for i, x in enumerate(it.get("shiteki") or [])]
    return [(k, v) for k, v in out if v]


def verdicts(path):
    if not os.path.exists(path):
        return None
    return {(x["k"], x["to"]): x for x in json.load(open(path)).get("results", []) if x.get("to") != "missing"}


FIELD = {}
for f in ("kourei", "hoiku"):
    d = json.load(open(f"{REPO}/{f}/docs.json"))
    for it in d["items"]:
        if it.get("id"):
            FIELD[it["id"]] = (f, it)
# 章の並び（かたまりから）
chap = {}   # doc -> {ch: {t, p, pages}}
pages_of = {}
for cf in sorted(glob.glob(f"{W}/chunks/*.json")):
    for it in json.load(open(cf))["items"]:
        c = chap.setdefault(it["doc"], {}).setdefault(it["ch"], {"t": it["t"], "p": it["p"], "p_end": it["p_end"]})
        c["p"] = min(c["p"], it["p"]); c["p_end"] = max(c["p_end"], it["p_end"])
for did in chap:
    txt = {"kc": "291627", "kcb": "289762", "kcc": "289743", "jorei": "296015", "houmon": "294031", "kango": "294032", "tsusho": "294583",
           "tsuriha": "294034", "iryoin": "295764", "tanryo": "295765", "tanki": "295767", "tokutei": "295768", "yogu": "295769",
           "tokuyo": "295770", "roken": "295771", "ryoyo": "268653", "ryoyoi": "268650", "ryoyos": "268651", "ryoyoy": "268652",
           "htsuchi": "h771051_62496585_misc", "htebiki": "h771051_62496588_misc"}[did]
    p = open(f"{W}/txt/{txt}.txt", encoding="utf-8").read().split("\f")
    if p and not p[-1].strip():
        p = p[:-1]
    pages_of[did] = len(p)

# 2回目の照合（組ごと: r2/<組>.json と r2/<組>-X.json・-Y.json）
R2T, R2X, R2Y = {}, {}, {}
for f in glob.glob(f"{W}/r2/b*.json"):
    base = os.path.basename(f)[:-5]
    if "-" in base:
        continue
    for x in json.load(open(f))["stmts"]:
        R2T[(x["chunk"], x["k"], x["to"])] = x["text"]
    for lab, D in (("X", R2X), ("Y", R2Y)):
        pth = f"{W}/r2/{base}-{lab}.json"
        if os.path.exists(pth):
            for x in json.load(open(pth))["results"]:
                D[(x.get("chunk"), x["k"], x["to"])] = x
heads = {}   # (doc, ch) -> [(n, t, p)]
notes = {}   # doc -> [{t, gist, points, shiteki}]
stat = {"文": 0, "載せる": 0, "落とす": 0, "照合待ち": 0, "直して載せる": 0}
missing_chunks = []
# 作り直したかたまり（<名前>x）の章は、元のかたまりの同じ章より優先する
OVR = {}
for cf in glob.glob(f"{W}/chunks/*x.json"):
    for it in json.load(open(cf))["items"]:
        OVR[f'{it["doc"]}:{it["ch"]}'] = os.path.basename(cf)[:-5]
for cf in sorted(glob.glob(f"{W}/chunks/*.json")):
    name = os.path.basename(cf)[:-5]
    vd = f"{W}/vdrafts/{name}.json"
    if not os.path.exists(vd):
        missing_chunks.append(name); continue
    flat = json.load(open(vd))["items"]
    A, B = verdicts(f"{W}/verify/{name}-A.json"), verdicts(f"{W}/verify/{name}-B.json")
    r2 = {(k, to): t for (c, k, to), t in R2T.items() if c == name}
    X = {(k, to): v for (c, k, to), v in R2X.items() if c == name}
    Y = {(k, to): v for (c, k, to), v in R2Y.items() if c == name}
    for it in flat:
        parts = it["k"].split(":")
        did, ch = parts[0], int(parts[1])
        if OVR.get(f"{did}:{ch}", name) != name:
            continue
        if len(parts) == 3:
            heads.setdefault((did, ch), []).append((int(parts[2]), it["t"], it["p"]))
        keep = {"gist": "", "points": [], "shiteki": []}
        for to, val in stmts(it):
            stat["文"] += 1
            key = (it["k"], to)
            ok = None
            if DRAFT:
                ok = val
            elif A is None or B is None:
                stat["照合待ち"] += 1; continue
            elif A.get(key, {}).get("ok") and B.get(key, {}).get("ok"):
                ok = val
            elif key in r2 and X and Y and X.get(key, {}).get("ok") and Y.get(key, {}).get("ok"):
                ok = r2[key]; stat["直して載せる"] += 1
            if ok:
                stat["載せる"] += 1
                if to == "gist":
                    keep["gist"] = ok
                else:
                    keep[to.split(".")[0]].append(ok)
            else:
                stat["落とす"] += 1
        e = {"t": it["t"]}
        e.update({k: v for k, v in keep.items() if v})
        # 章が2つのかたまりにまたがるとき、後ろのかたまりの章の項目（概要なし）は足さない
        if len(parts) == 2 and len(e) == 1 and any(x["t"] == e["t"] for x in notes.get(did, [])):
            continue
        notes.setdefault(did, []).append(e)

toc = {"kourei": [], "hoiku": []}
for did, chs in chap.items():
    f, item = FIELD[did]
    secs = []
    for ch in sorted(chs):
        c = chs[ch]
        hs = sorted(heads.get((did, ch), []))
        secs.append({"t": c["t"], "p": c["p"], "sub": [{"t": t, "p": p} for _, t, p in hs]})
    # スライド・見出しのない資料も章は1つ持つ（章の頁と要点を出すため）
    toc[f].append({"id": did, "t": item["t"], "u": item["u"], "pages": pages_of[did], "secs": secs})
order = {"kourei": ["kc", "kcb", "kcc", "jorei", "houmon", "kango", "tsusho", "tsuriha", "iryoin", "tanryo", "tanki", "tokutei", "yogu", "tokuyo", "roken", "ryoyo", "ryoyoi", "ryoyos", "ryoyoy"],
         "hoiku": ["htsuchi", "htebiki"]}
for f in toc:
    toc[f].sort(key=lambda d: order[f].index(d["id"]))
print("文", stat, "下書きのないかたまり", missing_chunks)
print("見出し", sum(len(s["sub"]) + 1 for f in toc for d in toc[f] for s in d["secs"]))
if "--write" in sys.argv:
    if missing_chunks and not DRAFT:
        sys.exit("下書きのないかたまりがあるので書きません")
    for f in toc:
        os.makedirs(f"{REPO}/{f}/notes", exist_ok=True)
        for x in glob.glob(f"{REPO}/{f}/notes/*.json"):
            os.remove(x)
        json.dump(toc[f], open(f"{REPO}/{f}/toc.json", "w"), ensure_ascii=False, indent=1)
        for d in toc[f]:
            json.dump(notes.get(d["id"], []), open(f"{REPO}/{f}/notes/{d['id']}.json", "w"), ensure_ascii=False, indent=1)
    print("書いた")
