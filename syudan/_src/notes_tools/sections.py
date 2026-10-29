"""見出しごとの本文を切り出す（作業用。リポジトリには置かない）"""
import importlib.util, json, pathlib, sys
sys.dont_write_bytecode = True
REPO = pathlib.Path("/home/claude/fukushi-watch")
spec = importlib.util.spec_from_file_location("extract", REPO / "syudan/_src/extract.py")
ex = importlib.util.module_from_spec(spec); spec.loader.exec_module(ex)
WORK = pathlib.Path(sys.argv[1]); OUT = pathlib.Path(sys.argv[2])
toc = {d["id"]: d for d in json.loads((REPO / "syudan/_src/toc.json").read_text())}
for aid, did in ex.INDEX_IDS.items():
    pages = (WORK / (aid + ".txt")).read_text(encoding="utf-8").split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    secs = ex.doc_toc(pages)
    flat = []
    for s in secs:
        flat.append(dict(s, chap=None, kind="chapter"))
        for x in s["sub"]:
            flat.append(dict(x, chap=s["t"], kind="item"))
    # toc.json と同じ並びか確かめる
    tflat = []
    for s in toc[did]["secs"]:
        tflat.append(s["t"]); tflat += [x["t"] for x in s["sub"]]
    assert [f["t"] for f in flat] == tflat, did
    L = [ex.nk(p).splitlines() for p in pages]
    pos = [(f["p"] - 1, f["_li"]) for f in flat]
    def span(a, b):
        out = []
        (p0, l0), (p1, l1) = a, b
        for p in range(p0, min(p1, len(L) - 1) + 1):
            s = l0 if p == p0 else 0
            e = l1 if p == p1 else len(L[p])
            seg = "\n".join(x.rstrip() for x in L[p][s:e]).strip()
            if seg:
                out.append(f"[p.{p+1}]\n{seg}")
        return "\n".join(out)
    items = []
    for i, f in enumerate(flat):
        end = pos[i + 1] if i + 1 < len(flat) else (len(L) - 1, 10**6)
        txt = span(pos[i], end)
        items.append({"k": f"{did}:{i}", "kind": f["kind"], "t": f["t"], "chap": f["chap"], "p": f["p"],
                      "p_end": end[0] + 1 if end[1] > 0 else end[0], "text": txt})
    if not flat:  # 見出しのない資料（こども性暴力防止法 2頁）
        items.append({"k": f"{did}:-1", "kind": "doc", "t": toc[did]["t"], "chap": None, "p": 1, "p_end": len(pages),
                      "text": span((0, 0), (len(L) - 1, 10**6))})
    pre = span((0, 0), pos[0]) if flat else ""
    (OUT / f"{did}.json").write_text(json.dumps({"doc": did, "title": toc[did]["t"], "url": toc[did]["u"], "pages": len(pages),
        "front": pre, "items": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(did, len(items), "項目", sum(len(x["text"]) for x in items), "字")
