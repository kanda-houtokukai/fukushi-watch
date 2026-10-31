"""1回目の照合で不合格になった文を、照合係の直し（fix）で置き換え、2回目の照合の材料（r2/<組>.json）を作る。
  python3 tools/r2_k.py <組の名前> <かたまり…>
直しの選び方: 不合格にした照合係の fix（2人とも不合格なら A の fix）。fix がない文は落とす。
"""
import json, os, sys
W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
batch, names = sys.argv[1], sys.argv[2:]
stmts, src = [], {}
for n in names:
    A = {(x["k"], x["to"]): x for x in json.load(open(f"{W}/verify/{n}-A.json"))["results"] if x.get("to") != "missing"}
    B = {(x["k"], x["to"]): x for x in json.load(open(f"{W}/verify/{n}-B.json"))["results"] if x.get("to") != "missing"}
    vc = {it["k"]: it for it in json.load(open(f"{W}/vchunks/{n}.json"))["items"]}
    for it in json.load(open(f"{W}/vdrafts/{n}.json"))["items"]:
        rows = [("gist", it.get("gist"))] + [(f"points.{i}", x) for i, x in enumerate(it.get("points") or [])] + [(f"shiteki.{i}", x) for i, x in enumerate(it.get("shiteki") or [])]
        for to, v in rows:
            if not v:
                continue
            a, b = A.get((it["k"], to), {}), B.get((it["k"], to), {})
            if a.get("ok") and b.get("ok"):
                continue
            fix = (a.get("fix") if not a.get("ok") else None) or (b.get("fix") if not b.get("ok") else None)
            if not fix:
                continue
            why = "; ".join(x.get("why", "") for x in (a, b) if x and not x.get("ok"))
            stmts.append({"chunk": n, "k": it["k"], "t": it["t"], "to": to, "text": fix, "before": v, "why_before": why})
            src[(n, it["k"])] = dict(vc[it["k"]], chunk=n)
os.makedirs(f"{W}/r2", exist_ok=True)
json.dump({"batch": batch, "stmts": stmts}, open(f"{W}/r2/{batch}.json", "w"), ensure_ascii=False, indent=1)
json.dump({"items": list(src.values())}, open(f"{W}/r2/{batch}-source.json", "w"), ensure_ascii=False, indent=1)
print(batch, "直した文", len(stmts), "項目", len(src), "原文", sum(len(x["text"]) for x in src.values()), "字")
