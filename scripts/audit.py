#!/usr/bin/env python3
"""両ガイドの本文を一次資料と照らす「照合の記録」の道具（毎朝の更新タスクが使う）。

照合の単位: 性暴力防止＝章・Q&A の1問・判定ツール1本・チェックリストの時期ごと・期限の一覧／報酬改定＝論点1件・前提1件・日程。
記録: dbs/_src/audit.json・kaitei/_src/audit.json（{"units": {単位: {"checked": 日付, "result": ok|fixed, "note": ...}}}）

使い方:
  python3 scripts/audit.py dbs --status            件数と、いちばん古い照合日
  python3 scripts/audit.py dbs --next 6            次に照らす6単位（照合していないもの→古いもの）を、本文と根拠の資料つきで出す
  python3 scripts/audit.py dbs --mark 単位 ok|fixed [--note 何を直したか] [--date YYYY-MM-DD]
  python3 scripts/audit.py dbs --due-source URL    その資料を根拠にしている単位の照合日を消す（資料の新しい版が出たとき。次から先に回る）
  python3 scripts/audit.py dbs --confirm 本文の語句 --url 資料のURL --quote 原文 [--note 補足]
                                                   検証で確かめた事実を「確かめ済み」に記録する（照合の結論が割れたもの・取り違えやすいもの）。
                                                   --next は、本文にその語句を含む単位に confirmed として添えて出す
  python3 scripts/audit.py dbs --facts             確かめ済みの事実の一覧
依存は Python 標準ライブラリと node（性暴力防止の data.js を読むため）。
"""
import argparse, datetime, html as H, json, pathlib, re, subprocess, sys

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import linkbook  # noqa: E402

JST = datetime.timezone(datetime.timedelta(hours=9))


def plain(s):
    s = re.sub(r"<svg[\s\S]*?</svg>", lambda m: " ".join(re.findall(r">([^<>]+)<", m.group(0))), s)
    return re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def dbs_units():
    src = ROOT / "dbs" / "_src"
    book = json.loads((src / "links.json").read_text(encoding="utf-8"))
    title_of = {it["u"]: it["t"] for it in book["items"]}

    def cites(text):
        found, _ = linkbook.resolve_cites(text, book["items"])
        return list(dict.fromkeys(found))
    units = {}
    skip = {"updates", "sources", "events",           # 毎朝のデータで書かれる面（更新タスクが別に確かめる）
            "kenshu", "materials", "doc", "law"}     # 照合係2人の照合を通した材料（kenshu.json・notes/・law.json）から組み立てる面（2026-10-30）。"docs" は「規程と書類」の章なので照合の対象に残す
    for f in sorted((src / "sections").glob("*.html")):
        t = f.read_text(encoding="utf-8")
        t = re.sub(r"\{\{([A-Z0-9_]+)\}\}", lambda m: (src / "svg" / (m.group(1) + ".svg")).read_text(encoding="utf-8"), t)
        for m in re.finditer(r'<section[^>]*\bid="([^"]+)"[^>]*data-title="([^"]*)"[^>]*>([\s\S]*?)</section>', t):
            sid, title, body = m.groups()
            if sid in skip:
                continue
            refs = " 、".join(plain(x) for x in re.findall(r'<span class="ref">([\s\S]*?)</span>', body))
            hrefs = [H.unescape(u) for u in re.findall(r'href="(https?://[^"]+)"', body)]
            units["章:" + sid] = {"title": title, "file": "dbs/_src/sections/" + f.name, "text": plain(body),
                                 "sources": list(dict.fromkeys(cites(refs) + hrefs))}
    js = ("const vm=require('vm');const fs=require('fs');const c={};c.window=c;vm.createContext(c);"
          "vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),c);process.stdout.write(JSON.stringify(c.GUIDE_DATA));")
    data = json.loads(subprocess.run(["node", "-e", js, str(src / "data.js")], capture_output=True, text=True, check=True).stdout)
    for q in data.get("qa", []):
        units["Q&A:" + q["q"]] = {"title": q["q"], "file": "dbs/_src/data.js", "text": plain(q.get("a", "")),
                                 "src": q.get("src", ""), "sources": cites(q.get("src", ""))}
    for name, tree in (data.get("trees") or {}).items():
        srcs = " 、".join(n.get("src", "") for n in tree.get("nodes", {}).values() if isinstance(n, dict) and n.get("src"))
        body = json.dumps(tree.get("nodes", {}), ensure_ascii=False)
        units["判定:" + name] = {"title": tree.get("title", name), "file": "dbs/_src/data.js", "text": plain(body)[:6000],
                                "sources": cites(srcs)}
    for ph in data.get("checklist", []):
        units["チェック:" + ph.get("title", "")] = {"title": ph.get("title", ""), "file": "dbs/_src/data.js",
                                                   "text": plain(json.dumps(ph.get("items", []), ensure_ascii=False)), "sources": []}
    live = json.loads((src / "live.json").read_text(encoding="utf-8"))
    units["期限:milestones"] = {"title": "近づいている日程（live.json milestones）", "file": "dbs/_src/live.json",
                                "text": json.dumps(live.get("milestones", []), ensure_ascii=False), "sources": []}
    for u in units.values():
        u["source_titles"] = [title_of.get(x, x) for x in u["sources"]]
    return units


def kaitei_units():
    src = ROOT / "kaitei" / "_src"
    c = json.loads((src / "content.json").read_text(encoding="utf-8"))
    live = json.loads((src / "live.json").read_text(encoding="utf-8"))
    units = {}
    for kind, arr in (("論点", c.get("ronten", [])), ("前提", c.get("zentei", []))):
        for r in arr:
            s = r.get("src") or {}
            units[kind + ":" + r["id"]] = {"title": r.get("title", ""), "file": "kaitei/_src/content.json",
                                          "text": json.dumps({k: r.get(k) for k in r if k not in ("id",)}, ensure_ascii=False),
                                          "sources": [x for x in (s.get("url"), s.get("page_url")) if x],
                                          "source_titles": [s.get("meeting", "") + " " + s.get("title", "")]}
    units["日程:timeline"] = {"title": "日程（live.json timeline・milestones）", "file": "kaitei/_src/live.json",
                              "text": json.dumps({"timeline": live.get("timeline"), "milestones": live.get("milestones")}, ensure_ascii=False),
                              "sources": [], "source_titles": []}
    return units


def load_log(guide):
    p = ROOT / guide / "_src" / "audit.json"
    return p, (json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"units": {}})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("guide", choices=["dbs", "kaitei"])
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--next", type=int)
    ap.add_argument("--mark", nargs=2, metavar=("UNIT", "RESULT"))
    ap.add_argument("--note", default="")
    ap.add_argument("--date", default=datetime.datetime.now(JST).strftime("%Y-%m-%d"))
    ap.add_argument("--due-source")
    ap.add_argument("--confirm")
    ap.add_argument("--url", default="")
    ap.add_argument("--quote", default="")
    ap.add_argument("--facts", action="store_true")
    a = ap.parse_args()
    units = dbs_units() if a.guide == "dbs" else kaitei_units()
    path, log = load_log(a.guide)
    rec = log.setdefault("units", {})
    if a.mark:
        key, res = a.mark
        if key not in units:
            sys.exit("その単位はありません: " + key)
        if res not in ("ok", "fixed"):
            sys.exit("結果は ok か fixed")
        rec[key] = {"checked": a.date, "result": res, **({"note": a.note} if a.note else {})}
    if a.due_source:
        n = 0
        for k, u in units.items():
            if a.due_source in u["sources"] and k in rec:
                rec[k]["checked"] = ""
                n += 1
        print("照合日を消した単位:", n)
    facts = log.setdefault("facts", [])
    if a.confirm:
        if not (a.url and a.quote):
            sys.exit("--confirm には --url と --quote（資料の原文そのまま）が要ります")
        facts[:] = [f for f in facts if f["match"] != a.confirm]
        facts.append({"match": a.confirm, "url": a.url, "quote": a.quote, "date": a.date,
                      **({"note": a.note} if a.note else {})})
        hit = [k for k, u in units.items() if a.confirm in plain(u["text"])]
        print("確かめ済みに記録:", a.confirm, "／本文でこの語句を含む単位:", ", ".join(hit) or "なし")
    if a.facts:
        print(json.dumps(facts, ensure_ascii=False, indent=1))
    if a.mark or a.due_source or a.confirm:
        for k in [k for k in rec if k not in units]:
            del rec[k]                                   # 本文から消えた単位は記録からも外す
        path.write_text(json.dumps(log, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    order = sorted(units, key=lambda k: (rec.get(k, {}).get("checked") or "0000"))
    if a.status or not (a.mark or a.next or a.due_source or a.confirm or a.facts):
        done = [k for k in units if rec.get(k, {}).get("checked")]
        oldest = min((rec[k]["checked"] for k in done), default="―")
        print(f"{a.guide}: 照合の単位 {len(units)}・照合済み {len(done)}・未照合 {len(units) - len(done)}・いちばん古い照合日 {oldest}")
    if a.next:
        out = []
        for k in order[:a.next]:
            u = dict(units[k])
            u["unit"] = k
            u["last_checked"] = rec.get(k, {}).get("checked", "")
            if rec.get(k, {}).get("note"):
                u["last_note"] = rec[k]["note"]
            body = plain(u["text"])
            conf = [f for f in facts if f["match"] in body]
            if conf:
                # 検証で確かめ済みの事実。これと食い違う直しは、この資料も照合係に渡して両方の原文で比べる
                u["confirmed"] = conf
            out.append(u)
        print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
