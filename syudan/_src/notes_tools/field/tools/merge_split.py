"""照合を半分に分けたかたまり（<名前>p・<名前>q）の結果を verify/<名前>-A・-B.json にまとめる。 python3 tools/merge_split.py k40 k46 k50"""
import json, os, sys
W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for base in sys.argv[1:]:
    for lab in "AB":
        ps = [f"{W}/verify/{base}{s}-{lab}.json" for s in "pq"]
        if not all(os.path.exists(p) for p in ps):
            print(base, lab, "まだそろっていない"); continue
        res = []
        for p in ps:
            res += json.load(open(p)).get("results", [])
        json.dump({"chunk": base, "results": res}, open(f"{W}/verify/{base}-{lab}.json", "w"), ensure_ascii=False, indent=1)
        print(base, lab, "まとめた", len(res))
