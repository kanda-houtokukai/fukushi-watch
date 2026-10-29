"""1回目の照合で不合格になった文を、照合係の直し（fix）で置き換えて、2回目の照合の材料を作る。
  python3 prep_fix.py
入力: fails/<g>.json（merge.py が書く）
出力: fix/<名前>.json（置き換える文）と round2/stmts.json・round2/source.json（2回目の照合用。全部まとめて1組）
直しの選び方: 不合格にした照合係の fix を使う（2人とも不合格なら A の fix）。fix がない文は載せない。
"""
import glob, json, pathlib, re, unicodedata

B = pathlib.Path(__file__).resolve().parent
src = {}
for f in glob.glob(str(B / "sections" / "*.json")):
    for it in json.loads(pathlib.Path(f).read_text())["items"]:
        src[it["k"]] = it
(B / "fix").mkdir(exist_ok=True)
(B / "round2").mkdir(exist_ok=True)
by_name, stmts, need = {}, [], set()
nofix = 0
for f in sorted(glob.glob(str(B / "fails" / "*.json"))):
    for x in json.loads(pathlib.Path(f).read_text())["items"]:
        A, Bv = x.get("A") or {}, x.get("B") or {}
        cand = None
        if A and not A.get("ok") and A.get("fix"):
            cand = A["fix"]
        elif Bv and not Bv.get("ok") and Bv.get("fix"):
            cand = Bv["fix"]
        if not cand:
            nofix += 1
            continue
        by_name.setdefault(x["src"], []).append({"k": x["k"], "to": x["to"], "text": cand})
        why = "; ".join(v.get("why", "") for v in (A, Bv) if v and not v.get("ok"))
        stmts.append({"k": x["k"], "t": x["t"], "to": x["to"], "text": cand, "before": x["text"], "why_before": why})
        need.add(x["k"])
for name, items in by_name.items():
    (B / "fix" / f"{name}.json").write_text(json.dumps({"name": name, "items": items, "verify": "round2"}, ensure_ascii=False, indent=1))
(B / "round2" / "stmts.json").write_text(json.dumps({"chunk": "round2", "stmts": stmts}, ensure_ascii=False, indent=1))
(B / "round2" / "source.json").write_text(json.dumps({"items": [src[k] for k in sorted(need, key=lambda k: (k.split(":")[0], int(k.split(":")[1])))]}, ensure_ascii=False, indent=1))
print("直した文", len(stmts), "直しがなく載せない文", nofix, "対象の見出し", len(need))
