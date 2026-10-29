"""照合の結果を合わせて、ページに載せる要点を書き出す（いまの鍵 v4 で。先に tov4.py を実行する）。
  python3 merge.py [--write]
- 下書き: drafts_v3/<g>.json。drafts_v3/fx*.json（切れ目を直した項目の書き直し）があれば、その項目を置き換える
- 照合: verify/<名前>-A.json・-B.json（名前は下書きの名前）。2人とも合格の文だけを載せる
- 直し: fix/<名前>.json（不合格の文の直し）と verify2/<名前>-A・-B。2人とも合格なら直した文を載せる
不合格の文は fails/<名前>.json に書き出す。--write でリポジトリの syudan/_src/notes/<資料>.json を書く。
"""
import glob, json, pathlib, sys

BASE = pathlib.Path(__file__).resolve().parent
REPO = pathlib.Path("/home/claude/fukushi-watch")
groups = json.loads((BASE / "groups.json").read_text())


def stmts(it):
    out = [("gist", it.get("gist", ""))]
    out += [(f"points.{i}", x) for i, x in enumerate(it.get("points", []))]
    out += [(f"shiteki.{i}", x) for i, x in enumerate(it.get("shiteki", []))]
    return [(k, v) for k, v in out if v]


def verdicts(path):
    if not path.exists():
        return None
    r = {}
    for x in json.loads(path.read_text())["results"]:
        if x.get("to") != "missing":
            r[(x["k"], x["to"])] = x
    return r


# 書き直した項目（fx*）
fx_items, fx_src = {}, {}
for f in sorted(glob.glob(str(BASE / "drafts_v4" / "fx*.json"))):
    name = pathlib.Path(f).stem
    for it in json.loads(pathlib.Path(f).read_text())["items"]:
        fx_items[it["k"]] = it
        fx_src[it["k"]] = name

# 原文の見出し
src = {}
for f in glob.glob(str(BASE / "sections" / "*.json")):
    for it in json.loads(pathlib.Path(f).read_text())["items"]:
        src[it["k"]] = it

V = {}
def get_v(name, lab, rnd=""):
    key = (name, lab, rnd)
    if key not in V:
        V[key] = verdicts(BASE / f"verify{rnd}_v4" / f"{name}-{lab}.json")
    return V[key]

notes, report, missing_v = {}, [], set()
for g in groups:
    dp = BASE / "drafts_v4" / f"{g}.json"
    if not dp.exists():
        report.append(f"{g}: 下書きなし"); continue
    fails, n_ok, n_all, n_fix = [], 0, 0, 0
    for it in json.loads(dp.read_text())["items"]:
        k = it["k"]
        name = g
        if k in fx_items:
            it, name = fx_items[k], fx_src[k]
        va, vb = get_v(name, "A"), get_v(name, "B")
        if va is None or vb is None:
            missing_v.add(name)
        fixes = {}
        fp = BASE / "fix" / f"{name}.json"
        if fp.exists():
            fixes = {(x["k"], x["to"]): x for x in json.loads(fp.read_text())["items"]}
        va2, vb2 = get_v("round2", "A", "2"), get_v("round2", "B", "2")
        s = src[k]
        doc = k.split(":")[0]
        kept = {"t": s["t"] if s["kind"] != "doc" else None, "gist": "", "points": [], "shiteki": []}
        for to, text in stmts(it):
            n_all += 1
            a = va and va.get((k, to)); b = vb and vb.get((k, to))
            ok = bool(a and a.get("ok") and b and b.get("ok"))
            final = text if ok else None
            if not ok and (k, to) in fixes and va2 and vb2:
                a2, b2 = va2.get((k, to)), vb2.get((k, to))
                if a2 and a2.get("ok") and b2 and b2.get("ok"):
                    final = fixes[(k, to)]["text"]; n_fix += 1
            if final is None:
                fails.append({"k": k, "t": s["t"], "to": to, "text": text, "src": name,
                              "A": a and {x: a.get(x) for x in ("ok", "why", "quote", "fix")},
                              "B": b and {x: b.get(x) for x in ("ok", "why", "quote", "fix")}})
                continue
            n_ok += 1
            field = to.split(".")[0]
            if field == "gist":
                kept["gist"] = final
            else:
                kept[field].append(final)
        notes.setdefault(doc, []).append({x: v for x, v in kept.items() if v or x == "t"})
    (BASE / "fails").mkdir(exist_ok=True)
    (BASE / "fails" / f"{g}.json").write_text(json.dumps({"group": g, "items": fails}, ensure_ascii=False, indent=1))
    report.append(f"{g}: 文 {n_all} 合格 {n_ok}（直して合格 {n_fix}） 不合格 {len(fails)}")

print(*report, sep="\n")
if missing_v:
    print("照合の結果がないもの:", sorted(missing_v))
if "--write" in sys.argv:
    out = REPO / "syudan" / "_src" / "notes"
    out.mkdir(exist_ok=True)
    for doc, entries in notes.items():
        (out / f"{doc}.json").write_text(json.dumps(entries, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("書き出し:", sorted(notes))
