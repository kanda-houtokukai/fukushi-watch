"""高齢（介護保険）の点検表: 国の「介護保険施設等運営指導マニュアル」別添「確認項目及び確認文書」だけで作る（build.py が呼ぶ）。
入力: syudan/_src/kourei/tenken/kaigo.json（tenken_tools/kakunin_kaigo.py が国の PDF から作る。文は通知のまま）
出力: 画面に埋め込む TK（tenken.js が読む形）と、サービスごとの点検表 syudan/kourei/tenken/<サービス>.json
障がいと違い、県の資料の見出しとの結びつけ・減算・年間は持たない（県の資料の要点は「サービス別」の章で読む）。
"""
import json

GROUP_T = {"houmon": "訪問サービス", "tsusho": "通所サービス", "iryo": "介護医療院・短期入所", "tokutei": "特定施設入居者生活介護",
           "yogu": "福祉用具", "tokuyo": "介護老人福祉施設", "roken": "介護老人保健施設", "ryoyo": "居宅療養管理指導"}


def build(path, docs):
    d = json.loads(path.read_text(encoding="utf-8"))
    index, files = [], {}
    for s in d["services"]:
        secs = []
        for sec in ("質", "体制"):
            rows = [{k: r[k] for k in ("k", "t", "items", "law", "docs")} for r in s["rows"] if r["sec"] == sec]
            if rows:
                secs.append({"t": sec, "rows": rows})
        n = sum(len(r["items"]) for r in s["rows"])
        index.append({"id": s["id"], "t": s["t"], "g": s["g"], "src": "kaigo", "n": n, "na": n, "nk": 0, "rows": len(s["rows"])})
        files[s["id"]] = {"id": s["id"], "t": s["t"], "g": s["g"], "src": "kaigo", "secs": secs, "ken": []}
    src = d["source"]
    tk = {"groups": GROUP_T, "gorder": list(GROUP_T), "index": index, "k2n": {}, "gensan": [], "nenkan": {"fy": "", "items": []},
          "src": {"kaigo": {"by": src["by"], "of": src["of"], "u": src["u"]}}, "store": "syudan-tenken-kourei-v1",
          "srclist": [{"t": src["by"] + "「" + src["of"] + "」別添「確認項目及び確認文書」", "u": src["u"], "n": src.get("note", "")}]}
    return tk, files
