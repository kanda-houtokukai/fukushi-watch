"""点検・減算・年間のデータを組み立てる（build.py から呼ぶ）。

入力:
  syudan/_src/tenken/sogo.json   国の「確認項目及び確認文書」（障害福祉サービス。tenken_tools/kakunin_sogo.py が作る）
  syudan/_src/tenken/ji.json     国の「主眼事項及び着眼点等」（障害児支援。tenken_tools/kakunin_ji.py が作る）
  syudan/_src/tenken/nenkan.json 年間でやること（呼び名と回数は、照合済みの要点の文だけを根拠に決めたもの）
  toc.json・要点（build.load_notes の結果）
出力:
  埋め込む索引（サービスの一覧・県の見出し→国の確認項目・減算・年間）と、サービスごとの点検表 syudan/tenken/<id>.json
文の扱い: 国の通知の文はそのまま。県の資料の内容は照合済みの要点の文だけを使う。新しく書く文はない
（減算と確認項目の結びつけ・年間の呼び名と回数だけが、このファイルと nenkan.json の判断）。
"""
import hashlib, json, pathlib, re, unicodedata

SRC = pathlib.Path(__file__).resolve().parent
TK = SRC / "tenken"

# 県の資料の区分に名前が出てこない国のサービス（区分の表示には入れるが、県の資料の見出し・指摘・年間・減算は結びつけない）
KEN_EXCLUDE = {"hokatsu"}   # 重度障害者包括支援: 居宅訪問系の資料の対象は居宅介護・重度訪問介護・同行援護・行動援護
GROUP_T = {"kyotaku": "居宅訪問系", "nicchu": "通所（日中活動）系・入所系", "gh": "共同生活援助", "ji": "障がい児（通所・入所）系", "soudan": "相談支援系"}

# 県の資料の見出しにある対象の印（＜生介・短期＞ など）→ サービスの id
ABBR = {
    "nicchu": {"療養": ["ryoyo"], "生介": ["seikatsu"], "短期": ["tanki"], "自機生": ["kino", "seikatsu-kunren"],
               "自(機)": ["kino"], "自(生)": ["seikatsu-kunren"], "就移": ["iko"], "就A": ["a-gata"], "就B": ["b-gata"],
               "就定": ["teichaku"], "自生": ["jiritsu-enjo"], "就選": ["sentaku"], "施設": ["shisetsu"], "施入": ["shisetsu"]},
    "ji": {"児発": ["jihatsu"], "放デイ": ["hodei"], "居訪発": ["kyotaku-ji"], "居児発": ["kyotaku-ji"], "保訪": ["hoikusho"],
           "入所": ["fukushi-nyusho", "iryo-nyusho"], "入所(医)": ["iryo-nyusho"], "児童発達支援センター": ["jihatsu"], "児発センター": ["jihatsu"]},
}
# 人員基準の章の「○○の員数」の見出し → その見出しが扱うサービス
STAFF = {
    "療養介護": ["ryoyo"], "生活介護": ["seikatsu"], "短期入所": ["tanki"], "自立訓練(機能訓練)": ["kino"], "自立訓練(生活訓練)": ["seikatsu-kunren"],
    "就労移行支援": ["iko"], "就労継続支援A型・B型": ["a-gata", "b-gata"], "就労定着支援": ["teichaku"], "自立生活援助": ["jiritsu-enjo"],
    "施設入所支援": ["shisetsu"], "就労選択支援": ["sentaku"],
    "児童発達支援(センターを除く)、放課後等デイサービス": ["jihatsu", "hodei"], "児童発達支援センター": ["jihatsu"],
    "居宅訪問型児童発達支援": ["kyotaku-ji"], "福祉型障がい児入所施設": ["fukushi-nyusho"], "医療型障がい児入所施設": ["iryo-nyusho"],
}
# 減算 → 関係する国の確認項目のまとまり（見出しの語）
GENSAN_REL = {
    "身体拘束廃止未実施減算": ["身体拘束等の禁止"], "虐待防止措置未実施減算": ["虐待の防止", "虐待等の禁止"],
    "業務継続計画未策定減算": ["業務継続計画の策定等"], "定員超過利用減算": ["定員の遵守", "利用定員"],
    "人員欠如減算": ["従業者の員数"], "個別支援計画未作成減算": ["計画の作成等"],
    "自己評価結果等未公表減算": ["取扱方針"], "支援プログラム未公表減算": ["支援プログラム"],
}
# 減算の対象を、県の資料の要点の文が絞っているもの（見出しに印がないため。根拠は各減算の見出しの要点）
GENSAN_SVCS = {
    ("ji", "人員欠如減算"): ["jihatsu", "hodei", "kyotaku-ji", "hoikusho"],          # 「児発…、放デイ…、居訪発、保訪が対象」
    ("ji", "個別支援計画未作成減算"): ["jihatsu", "hodei", "kyotaku-ji", "hoikusho", "fukushi-nyusho", "iryo-nyusho"],  # 「児発・放デイ・居訪発・保訪・障がい児入所支援…が対象」
    ("ji", "自己評価結果等未公表減算"): ["jihatsu", "hodei", "hoikusho"],             # 「＜児発・放デイ・保訪＞」
    ("ji", "支援プログラム未公表減算"): ["jihatsu", "hodei", "kyotaku-ji"],           # 「＜児発・放デイ・居訪発＞」
}
# 減算の対象を、国の確認項目にその項目があるサービスに絞るもの（県の要点が「計画作成の一連の業務」を前提にしているため）
GENSAN_NEED = {"個別支援計画未作成減算": "計画の作成等$"}
SYN = [("手続き", "手続"), ("受給者資格", "受給資格"), ("障がい", "障害"), ("支払い", "支払"), ("取扱い", "取扱"),
       ("について", ""), ("通所利用者負担額", "利用者負担額"), ("障害児通所給付費", "給付費"), ("サービス提供の記録", "サービスの提供の記録"),
       ("指定障害児通所支援事業者等との連携等", "事業者等との連携等"), ("指定障害福祉サービス事業者等との連携等", "事業者等との連携等")]


def key(*parts):
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


def nfkc(t):
    return unicodedata.normalize("NFKC", t or "")


def norm(t):
    """見出しを比べるための形（番号・根拠条文・対象の印を除く）"""
    t = nfkc(t)
    t = re.sub(r"^\s*(\(\d+(-\d)?\)|\d+[\.．]|第\d+|\d+(の\d+)?)\s*", "", t)
    t = re.sub(r"[<＜〈][^>＞〉]*[>＞〉]", "", t)
    t = re.sub(r"\((基準省令|入所基準|施設省令|施設基準|基準|第|令和)[^()]*(\([^()]*\))?[^()]*\)", "", t)
    for a, b in SYN:
        t = t.replace(a, b)
    return re.sub(r"\s+", "", t)


def tags_of(title):
    return [nfkc(x) for x in re.findall(r"[<＜〈]([^>＞〉]*)[>＞〉]", title or "")]


def applies(doc, title, all_ids):
    """県の見出しが扱うサービス（set）。印がなければ、その資料のすべてのサービス"""
    out = None
    t = nfkc(title)
    m = re.match(r"^\(\d+\)(.+?)の員数", t)
    if m and m.group(1) in STAFF:
        out = set(STAFF[m.group(1)])
    for tg in tags_of(title):
        if "は" in tg and "を除く" in tg:   # 「居訪発は6〜7、保訪は4を除く」のような項目単位の除外は見出しの対象を変えない
            continue
        body = tg.replace("自(機・生)", "自機生")
        if body in ("全事業共通",):
            continue
        neg = body.endswith("を除く")
        body = body[:-3] if neg else body
        ids = set()
        for tok in re.split(r"[・、]", body):
            tok = tok.strip()
            if not tok:
                continue
            got = ABBR.get(doc, {}).get(tok)
            if got is None:
                return out if out is not None else set(all_ids)   # 読めない印は対象を絞らない
            ids |= set(got)
        cur = out if out is not None else set(all_ids)
        out = (cur - ids) if neg else (cur & ids if out is not None else ids)
    return out if out is not None else set(all_ids)


def flat(d):
    f = []
    for ci, s in enumerate(d["secs"]):
        f.append({"t": s["t"], "c": ci + 1, "sec": None})
        for x in s["sub"]:
            f.append({"t": x["t"], "c": ci + 1, "sec": s["t"]})
    return f


def bigram(s):
    return {s[i:i + 2] for i in range(len(s) - 1)} or {s}


def match_score(nt, kt):
    if not nt or not kt:
        return 0
    if nt == kt:
        return 1.0
    a, b = (nt, kt) if len(nt) <= len(kt) else (kt, nt)
    if len(a) >= 4 and a in b:
        rest = b.replace(a, "", 1)
        if len(rest) <= 4 or re.fullmatch(r"\(.*\)", rest):
            return 0.95
    m = re.match(r"^(.+?)計画の作成等$", nt)
    if m and kt == "個別支援計画の作成等":
        return 0.9
    return 0


def build(toc, notes, docs):
    sogo = json.loads((TK / "sogo.json").read_text(encoding="utf-8"))
    ji = json.loads((TK / "ji.json").read_text(encoding="utf-8"))
    nenkan = json.loads((TK / "nenkan.json").read_text(encoding="utf-8"))
    services = sogo["services"] + ji["services"]
    SID = {s["id"]: s for s in services}
    BY = {d["id"]: d for d in toc}
    FL = {d["id"]: flat(d) for d in toc}
    ids_of = {}
    for s in services:
        if s["id"] not in KEN_EXCLUDE:
            ids_of.setdefault(s["g"], []).append(s["id"])
    errs = []

    # 県の見出しごとの対象サービス
    APPLY = {}
    for g in GROUP_T:
        APPLY[g] = [applies(g, f["t"], ids_of[g]) for f in FL[g]]

    def note(d, h):
        return (notes.get(d) or {}).get(h) or {}

    ken_of_row = {}      # (sid, rowK) -> [(doc, h)]
    rows_of_ken = {}     # doc -> h -> [(sid, rowK, rowT)]
    for s in services:
        g = s["g"]
        F = FL[g]
        for r in s["rows"]:
            nt = norm(r["t"])
            hits = []
            for h, f in enumerate(F):
                if f["sec"] is None or s["id"] not in APPLY[g][h]:
                    continue
                kt = norm(f["t"])
                sc = match_score(nt, kt)
                if nt == "従業者の員数" and (kt.endswith("の員数") or kt == "人員等に係る指摘及び指導"):
                    sc = 0.9
                if sc >= 0.9:
                    hits.append((sc, h))
            if hits:
                best = max(x[0] for x in hits)
                hs = [h for sc, h in hits if sc == best or nt == "従業者の員数"]
                ken_of_row[(s["id"], r["k"])] = [(g, h) for h in hs]
                for h in hs:
                    rows_of_ken.setdefault(g, {}).setdefault(h, []).append((s["id"], r["k"], r["t"]))
            # 項目ごと: 給付費の項目の「（○○減算）」などの注記と、県の報酬の見出しを結ぶ
            for it in r["items"]:
                q = norm((it.get("q") or "").strip("（）()"))
                if not q:
                    continue
                for h, f in enumerate(F):
                    if f["sec"] is not None and s["id"] in APPLY[g][h] and norm(f["t"]) == q:
                        it["ken"] = [g, h]
                        rows_of_ken.setdefault(g, {}).setdefault(h, []).append((s["id"], r["k"], r["t"]))

    def ken_ref(d, h):
        f = FL[d][h]
        n = note(d, h)
        out = {"d": d, "h": h, "t": f["t"], "c": f["c"]}
        if n.get("gist"):
            out["g"] = n["gist"]
        if n.get("shiteki"):
            out["sh"] = n["shiteki"]
        return out

    # サービスごとの点検表
    files, index = {}, []
    for s in services:
        g = s["g"]
        secs, cur = [], None
        n_std = n_all = 0
        used = set()
        for r in s["rows"]:
            if cur is None or cur["t"] != r["sec"]:
                cur = {"t": r["sec"], "rows": []}
                secs.append(cur)
            items = []
            for it in r["items"]:
                std = (s["src"] == "sogo") or bool(it.get("u"))
                n_all += 1
                n_std += 1 if std else 0
                x = {"k": it["k"], "x": it["x"]}
                if s["src"] == "ji":
                    x["std"] = 1 if std else 0
                    if it.get("u"):
                        x["u"] = it["u"]
                    for kk in ("q", "law", "p"):
                        if it.get(kk):
                            x[kk] = it[kk]
                    if it.get("docs"):
                        x["docs"] = it["docs"]
                if it.get("ken"):
                    x["ken"] = ken_ref(*it["ken"])
                    used.add(tuple(it["ken"]))
                items.append(x)
            row = {"k": r["k"], "t": r["t"], "items": items}
            if r.get("law"):
                row["law"] = r["law"]
            if s["src"] == "sogo":
                row["docs"] = r["docs"]
                if r.get("note"):
                    row["note"] = r["note"]
            if r.get("p"):
                row["p"] = r["p"]
            kr = ken_of_row.get((s["id"], r["k"]))
            if kr:
                row["ken"] = [ken_ref(d, h) for d, h in kr]
                used |= set(kr)
            cur["rows"].append(row)
        # 県の資料にあって国の確認項目に結びつかなかった見出しのうち、指摘があるもの・報酬の章のもの
        extra = []
        for h, f in enumerate(FL[g]):
            if f["sec"] is None or (g, h) in used or s["id"] not in APPLY[g][h]:
                continue
            n = note(g, h)
            ch = BY[g]["secs"][f["c"] - 1]["t"]
            if not (n.get("shiteki") or "報酬" in ch):
                continue
            if "用語の定義" in f["t"] or "改定" in ch:
                continue
            extra.append({"k": "k" + key(s["id"], g, f["t"]), "d": g, "h": h, "t": f["t"], "c": f["c"], "ch": ch,
                          **({"g": n["gist"]} if n.get("gist") else {}), **({"sh": n["shiteki"]} if n.get("shiteki") else {})})
        out = {"id": s["id"], "t": s["t"], "g": g, "src": s["src"], "secs": secs, "ken": extra}
        files[s["id"]] = out
        index.append({"id": s["id"], "t": s["t"], "g": g, "src": s["src"], "n": n_std, "na": n_all, "nk": len(extra),
                      "rows": sum(len(x["rows"]) for x in secs)})

    # 県の見出し → 国の確認項目（章のページの見出しに出す）
    k2n = {}
    for d, m in rows_of_ken.items():
        for h, lst in m.items():
            seen, out = set(), []
            for sid, rk, rt in lst:
                if (sid, rk) not in seen:
                    seen.add((sid, rk)); out.append([sid, rk])
            k2n.setdefault(d, {})[str(h)] = out

    # 減算
    gmap = {}
    for g in GROUP_T:
        for h, f in enumerate(FL[g]):
            m = re.search(r"([^\s（）()＜<]+減算)", f["t"])
            if not m or f["sec"] is None:
                continue
            name = m.group(1)
            n = note(g, h)
            e = gmap.setdefault(name, {"t": name, "docs": [], "nat": [], "rel": []})
            e["docs"].append({"d": g, "h": h, "t": f["t"], "c": f["c"], "svcs": sorted(GENSAN_SVCS.get((g, name), APPLY[g][h])),
                              **{k: n[k] for k in ("gist", "points", "shiteki") if n.get(k)}})
    for s in ji["services"]:
        for r in s["rows"]:
            for it in r["items"]:
                q = (it.get("q") or "").strip("（）()")
                if q.endswith("減算") and q != "減算が行われる場合":
                    e = gmap.setdefault(q, {"t": q, "docs": [], "nat": [], "rel": []})
                    e["nat"].append({"s": s["id"], "r": r["k"], "rt": r["t"], "k": it["k"], "x": it["x"], **({"u": it["u"]} if it.get("u") else {}),
                                     **({"law": it["law"]} if it.get("law") else {})})
    order = sorted(gmap.values(), key=lambda e: (-len(e["docs"]), -len(e["nat"]), e["t"]))
    for i, e in enumerate(order):
        e["id"] = "g" + key(e["t"])[:6]
        svcs = set()
        nd = GENSAN_NEED.get(e["t"])
        for d in e["docs"]:
            if nd:
                d["svcs"] = [x for x in d["svcs"] if any(re.search(nd, norm(r["t"])) and "業務継続" not in r["t"] and "安全" not in r["t"] for r in SID[x]["rows"])]
            svcs |= set(d["svcs"])
        for x in e["nat"]:
            svcs.add(x["s"])
        e["svcs"] = sorted(svcs)
        # 関係する国の確認項目は、この減算の対象サービスのものだけ
        words = GENSAN_REL.get(e["t"], [])
        for s in services:
            if s["id"] not in svcs:
                continue
            for r in s["rows"]:
                if any(w in norm(r["t"]) for w in words):
                    e["rel"].append([s["id"], r["k"], r["t"]])

    # 年間
    def find_ev(ev):
        d, ht, x = ev["d"], ev["h"], ev["x"]
        for h, f in enumerate(FL[d]):
            if f["t"] == ht:
                n = note(d, h)
                if x in (n.get("points") or []) + (n.get("shiteki") or []) + [n.get("gist", "")]:
                    return {"d": d, "h": h, "t": ht, "c": f["c"], "x": x}
        errs.append(f"年間の根拠の文が要点にありません: {d} {ht[:20]} {x[:30]}")
        return None
    nk = []
    for it in nenkan["items"]:
        o = {k: v for k, v in it.items() if k != "ev"}
        if o.get("due") == "@registerDeadline":
            o["due"] = docs.get("registerDeadline")
        if o.get("link") == "@register":
            o["link"] = docs.get("register")
        if o.get("src") and o["src"].get("u") == "@page":
            o["src"] = {"t": o["src"]["t"], "u": docs.get("page")}
        o["ev"] = [e for e in (find_ev(x) for x in it["ev"]) if e]
        gs = it.get("g", [])
        svcs = set(it.get("s", []))
        for g in gs:
            svcs |= (set(SID) - KEN_EXCLUDE) if g == "*" else set(ids_of.get(g, []))
        svcs -= set(it.get("xs", []))
        need = it.get("need")
        if need:   # 国の確認項目に、その項目（例: 非常災害対策）があるサービスだけ
            def has(sid):
                return any(re.search(need["re"], norm(r["t"])) and not (need.get("not") and re.search(need["not"], norm(r["t"])))
                           for r in SID[sid]["rows"])
            svcs = {x for x in svcs if has(x)}
            o["needLabel"] = need["label"]
            o["needGroups"] = [GROUP_T[g] for g in GROUP_T if g in gs or any(SID[x]["g"] == g for x in it.get("s", []))]
            o.pop("need", None)
        o["svcs"] = sorted(svcs)
        o.pop("g", None); o.pop("s", None); o.pop("xs", None)
        nk.append(o)

    # 県の見出しが扱うサービス（その資料のすべてのサービスのときは持たない）。テーマのページの「サービスで絞る」に使う
    ap = {}
    for g in GROUP_T:
        allg = set(ids_of[g])
        for h, f in enumerate(FL[g]):
            if APPLY[g][h] != allg:
                ap.setdefault(g, {})[str(h)] = sorted(APPLY[g][h])
    for e in order:
        for d in e["docs"]:
            if set(d["svcs"]) != set(ids_of[d["d"]]):
                ap.setdefault(d["d"], {})[str(d["h"])] = sorted(d["svcs"])
            else:
                ap.get(d["d"], {}).pop(str(d["h"]), None)

    embed = {
        "ap": ap,
        "chipx": sorted(KEN_EXCLUDE),
        "groups": GROUP_T,
        "index": index,
        "k2n": k2n,
        "gensan": order,
        "nenkan": {"fy": nenkan["fy"], "items": nk},
        "src": {"sogo": sogo["source"], "ji": ji["source"]},
    }
    return embed, files, errs
