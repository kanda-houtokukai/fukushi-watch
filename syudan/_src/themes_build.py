"""テーマ（サービスのページの「テーマから見る」とテーマのページ）を組み立てる（build.py から呼ぶ）。

県の資料の見出しを、決まった規則でテーマに振り分ける。文は持たない（画面に出す文は、照合済みの要点だけ）。
このファイルの判断は次の3つだけ:
  1. 見出しをどのテーマに入れるか（RULES・CH_RULES・DOC_THEME）
  2. 減算の見出しを、どの基準の見出しの下に出すか（GENSAN。県の資料の要点が「2（46）…を参照」のように
     番号で指しているときは、その番号と食い違ったら止める）
  3. 共通の資料（障がいの全事業所共通編・高齢の各サービス共通資料）のどの章をテーマに添えるか
見出しの振り分けを変えたら、python3 syudan/_src/themes_build.py で一覧（_review/themes.tsv）を書き出して確かめる。
"""
import json, pathlib, re, sys, unicodedata

SRC = pathlib.Path(__file__).resolve().parent

# テーマの並び（サービスのページの並び）。分野で呼び名だけ変える
THEMES = {
    "shogai": [("jin", "人員と体制"), ("keikaku", "支援の内容・計画と記録"), ("kenri", "虐待・身体拘束の防止と権利擁護"),
               ("anzen", "安全と衛生"), ("kasan", "加算"), ("santei", "利用者負担と報酬の算定"), ("keiyaku", "契約・連携と手続"),
               ("kaisei", "制度の改正"), ("sonota", "そのほかの決まり")],
    "kourei": [("jin", "人員と体制"), ("keikaku", "サービスの内容・計画と記録"), ("kenri", "虐待・身体拘束の防止と権利擁護"),
               ("anzen", "安全と衛生"), ("kasan", "加算"), ("santei", "利用者負担と報酬の算定"), ("keiyaku", "契約・連携と手続"),
               ("kaisei", "制度の改正"), ("sonota", "そのほかの決まり")],
}
# 共通の資料（テーマのページの「共通編では」に添える）。level: chap＝章だけ／sub＝章の中の見出しまで
COMMON = {"shogai": {"docs": ["common", "kaitei"], "level": "chap", "label": "全事業所共通編では", "short": "共通編"},
          "kourei": {"docs": ["kc", "kcb", "kcc", "jorei"], "level": {"jorei": "chap"}, "label": "各サービス共通資料では", "short": "共通資料"}}
# 資料ごと決まっているもの
DOC_THEME = {"kaitei": "kaisei", "dbs": "kaisei"}

# Q&A・指摘事例の章（減算の見出しがあっても、基準の下には付けない。テーマの中の1項目として出す）
QA_CH = re.compile(r"Q&A|QA|指摘|指導事例|不適正|事例")
# 章で決まるもの（Q&A・指摘事例・その他の章には使わない）
CH_RULES = [
    ("kenri", r"人権"),
    ("kasan", r"^[^()]*加算[^()・]*について$"),
    ("jin", r"^人員基準|人員に関する基準|研修"),
    ("santei", r"報酬|給付費|療養管理指導費|特別診療費|保険外|給付調整|療養の給付|日割|月額包括|規模区分"),
    ("keiyaku", r"届出|指導監督|実施方針"),
    ("anzen", r"防火|災害"),
]
# どのテーマにも当たらない全体の決まり（基本方針・総則など）と、案内だけのもの
INFO = r"ホームページ|アドレス|コールセンター"   # 案内だけのもの（どの章にあっても「そのほか」）
GENERAL = r"に関する条例$|基本方針|基準の性格|基準省令の性格|^趣旨|^定義|総則|運営に関する基準$|^附則|^別表|^別紙(?!様式)|^準用|その他準用"
# 見出しの語で決まるもの（上から順に見て、最初に当たったもの）。最初の EARLY は章の決まりより先に見る
EARLY = [
    ("keiyaku", r"変更届|加算届|届出"),
    ("kaisei", r"改定|性暴力防止法|施行時期"),
    ("santei", r"利用者負担額.*軽減|軽減.*要綱|支援措置事業"),
    ("kasan", r"加算|処遇改善|中山間地域|特別地域|LIFE|科学的介護"),
    ("anzen", r"事故"),
    ("jin", r"人材確保|人材の確保|技能実習|監理団体"),
    ("keikaku", r"^別紙様式|様式例|指示書|計画書"),
]
RULES = [
    ("kenri", r"身体拘束|身体的拘束|虐待|秘密保持|個人情報|苦情|掲示|情報の提供|利益供与|提供拒否|差別|人権|性的少数者|ハラスメント|意思決定|権利擁護|身元保証|成年後見|広告"),
    ("santei", r"療養費|費$|費について|単価|^単位数|所定単位数|保険医|医療保険|調整告示|規模による区分|時間以上.*時間未満|特別の指示|20分未満|営業日以外|退院日|療法士等による|^理学療法士、作業療法士又は言語聴覚士$|^定期巡回・随時対応型訪問介護$|ケアプラン|指導\(I"),
    ("keikaku", r"口腔衛生|口腔の管理|栄養ケア|給食|^食事|取扱方針|計画書|報告書|情報提供|プロセス|指示を行った|行うべき業務|の業務$|入院期間中|入所期間中|^居宅療養管理指導について|居宅療養管理指導の内容"),
    ("anzen", r"業務継続|非常災害|災害|防火|防災|消防|安全|所在の確認|(?<!歯科)衛生|感染|食中毒|事故|緊急|協力医療機関|協力歯科|防犯|被災|喀痰吸引|酸素|褥瘡|健康管理|常時の連絡体制"),
    ("keiyaku", r"説明及び同意|説明と同意|内容及び手続|契約|受給者|受給資格|資格の確認|支給の申請|給付決定の申請|市町村への通知|都道府県\)?への通知|許可の単位|指定取消|指定手続|みなし指定"),
    ("santei", r"利用者負担|利用料|費用|金銭|預り金|預かり金|遺留金|給付費|会計|法定代理|支払|領収|請求|軽減|助成|保険外|区分支給限度|居住費|食費|日割|月額|包括|給付調整|療養の給付|単位|算定|報酬|所要時間|乗降介助|早朝|夜間|深夜|身体介護|(?<!共同|自立)生活援助|規模区分|特別診療費|療養費|工賃|賃金|入院又は外泊|外泊|経過措置|長期利用|通院が困難|単一建物|同一建物|同一の建物|同一の敷地|12月を超え|価格|保険給付"),
    ("keiyaku", r"申請|届出|変更|指定の|指定申請|指定更新|指定業務|更新|情報公表|公表制度|重要事項|体制等状況一覧|業務管理体制|指導監督|実施方針|行政処分|監査|質問受付|ダウンロード|連絡調整|あっせん|サービス提供困難|への通知|連携|地域との|入所申込|入所指針|入所検討|入所者の決定|入所評価|入所継続|評価票|照会書|登録|要綱|調査票|申込書"),
    ("jin", r"員数|人員|職員|指導員|専門員|栄養士|相談員|看護師|配置医師|管理責任者|サービス提供責任者|管理者|責任者の|担当者|勤務|常勤|兼務|配置|資格要件|資格|定員|運営規程|用語の定義|^※?用語$|多機能型|設備|備品|居室|構造|面積|夜勤|研修|講師|ファシリテーター|療法士|身分を証する|生産性|人材|ユニット"),
    ("keikaku", r"計画|プログラム|記録|提供|内容|評価|介護|看護|訓練|リハビリ|栄養|口腔|入浴|排せつ|相談|援助|支援|日常生活|社会生活|便宜|生産活動|就労|実習|求職|定着|雇用|通勤|離職|就職|訪問|通報|心身の状況|モニタリング|アセスメント|処遇|自立|地域移行|地域生活|地域社会|包摂|移行|検討等|入退所|退所|入所|療養|医師|歯科|薬剤|指示|診療|主治|台帳|体験|宿泊|開始及び終了|入退居|入居|チェックリスト|事業の内容"),
]
# 見出しごとに決めたもの（規則では誤るもの。照合係2人の指摘 2026-10-31）。(資料, 見出しそのまま, 何件目) → テーマ。
# "-" を付けたテーマは、見出しに「減算」とあっても減算として扱わない（中身が減算の決まりでないもの）
OVERRIDE = {
    ("houmon", "エ 主な留意事項", 1): "santei",              # 要点は1回の訪問の算定区分の決め方と保険外サービス
    ("houmon", "【算定要件】(老企第36号 第2の2の(14))", 1): "kasan",   # 要点は特定事業所加算の要件
    ("kango", "難病患者等の利用", 1): "santei",              # 要点「…の場合の給付の扱い」
    ("tokuyo", "7 適正運用", 1): "keiyaku",                # 入所指針の続き
    ("tokuyo", "(別紙1)", 1): "santei",                   # 医療保険と介護保険の給付調整の表
    ("tokuyo", "(別紙2)", 1): "santei",
    ("tokuyo", "7 特別養護老人ホーム等の職員(看護師、理学療法士等)が行った医療行為については、", 1): "santei",   # 要点「診療報酬を算定できない」
    ("tokutei", "(7)病院及び診療所の療養病床転換による機能訓練指導員の配置に関する基準の緩和の経過措置", 1): "jin",
    ("kcb", "（５）リハビリテーション・個別機能訓練、栄養、口腔の実施及び一体的取組について", 1): "kasan",   # 要点「各加算の基本的な考え方…」
    ("tanryo", "ユニットにおける職員に係る減算について", 2): "-santei",   # 中身は身体拘束・虐待・BCP などの減算をまとめたもの
    ("tanryo", "ユニットにおける職員に係る減算について", 3): "-santei",
    ("iryoin", "夜勤体制による減算及び加算の特例について", 1): "-kasan",   # 中身は夜間勤務等看護の加算（同じ名前の「(3) …」は減算の決まり）
}
# 減算 → (テーマ, 基準の見出しの探し方（上から順に。(見出しの語, 章の語)）, 基準の要点に含まれているはずの語)。
# 同じ章に基準があればそれを先に使う。テーマが違う基準（高齢の身体拘束＝取扱方針）は、その基準を減算のテーマにも出す
GENSAN = [
    (r"身体拘束", "kenri", [(r"身体拘束等の禁止|身体的拘束等の禁止|身体的?拘束等の適正化|^身体拘束", None), (r"取扱方針", None)], "拘束"),
    (r"虐待", "kenri", [(r"虐待の防止|虐待等の禁止|^虐待防止", None)], "虐待"),
    (r"業務継続", "anzen", [(r"業務継続計画の策定", None)], "業務継続"),
    (r"定員超過", "jin", [(r"定員の遵守", None)], "定員"),
    (r"人員欠如|人員基準欠如", "jin", [(r"の員数", None), (r"介護職員及び看護職員|看護職員及び介護職員", None), (r"人員に関する基準", None)], None),
    (r"計画未作成", "keikaku", [(r"計画の作成", None)], "計画"),
    (r"支援プログラム", "keikaku", [(r"支援プログラム", None)], "プログラム"),
    (r"自己評価", "keikaku", [(r"取扱方針", None)], "自己評価"),
    (r"情報公表", "keiyaku", [(r"情報公表", None)], "公表"),
    (r"夜勤", "jin", [], None),
    (r"ユニット", "jin", [(r"ユニット.*勤務体制", None), (r"勤務体制の確保", r"ユニット"), (r"勤務体制の確保", None)], "ユニット"),
    (r"安全管理体制", "anzen", [(r"事故発生", None)], "事故"),
    (r"栄養管理", "keikaku", [(r"^栄養管理", None)], "栄養"),
]
# 基準から外すもの（県の要点が対象を絞っているもの）。(資料, 減算の名前) → 外す見出しの語
GENSAN_EXCL = {("ji", r"人員欠如|人員基準欠如"): r"^児童発達支援センターの員数|入所施設の員数",   # 要点「児発（センター…を除く）…が対象」
               ("tokutei", r"人員欠如|人員基準欠如"): r"人員に関する基準"}   # この資料の「人員に関する基準」の要点は外部サービス利用型・生産性向上の特例


def nf(s):
    return unicodedata.normalize("NFKC", s or "")


LAW = re.compile(r"[(〔](?=[^()〔〕]*(?:基準省令|施設省令|入所基準|施設サービス基準|省令|条例|告示|老企|老計|老振|通知|規則|第\d|条))[^()〔〕]*(?:\([^()]*\)[^()〔〕]*)?[)〕]")
LEAD = re.compile(r"^\s*(?:【[^】]*】|〔[^〕]*〕|\(\d+(?:-\d)?\)|\d+(?:-\d+)?[.．](?!\d)|\d+-\d+\s|第[0-9一二三四五六七八九十]+(?:\s|(?=[^\d]))|[①-⑳]|[一二三四五六七八九十]+[、.]|\([ア-ン]\)|[ア-ン](?=\s)|[○〇◯●・]|\d+(?:\s|(?=[^\d.単円人回日月年分%])))\s*")


def clean(t):
    """見出しを比べ・並べるための形（番号・根拠条文・対象の印を除く）"""
    t = nf(t)
    t = re.sub(r"[<〈][^>〉]*[>〉]", "", t)
    t = LAW.sub("", t)
    t = re.sub(r"[(〔][^()〔〕]*(?:届出|単位|算定|準用|運輸局|改正|改定)[^()〔〕]*[)〕](?:新設)?", "", t)   # 「(届出が必要)」「(令和6年度介護報酬改正)新設」のような添え書き
    base = t
    for _ in range(2):
        t = LEAD.sub("", t)
    t = t.strip(" 　")
    return t or re.sub(r"[【】〔〕()]", "", base).strip(" 　")


def flat(d):
    f = []
    for ci, s in enumerate(d["secs"]):
        f.append({"t": s["t"], "c": ci, "sec": None, "n": len(s["sub"])})
        for x in s["sub"]:
            f.append({"t": x["t"], "c": ci, "sec": s["t"]})
    return f


def classify(t, ch):
    """(テーマ, 減算の名前 or None)"""
    ct, cc = clean(t), clean(ch or "")
    if "減算" in ct:
        for pat, th, _, _ in GENSAN:
            if re.search(pat, ct):
                return th, pat
        return "santei", ""
    if re.search(INFO, ct):
        return "sonota", None
    if ch and not QA_CH.search(nf(ch)) and re.search(r"改定|性暴力防止法", cc):
        return "kaisei", None   # 改定の章の中は、加算の見出しでも「制度の改正」
    for th, pat in EARLY:   # 届出・改定・加算などは章より先
        if re.search(pat, ct):
            return th, None
    if ch and not QA_CH.search(nf(ch)) and not re.search(r"その他", cc):
        for th, pat in CH_RULES:
            if re.search(pat, cc):
                return th, None
    if re.search(GENERAL, ct):
        return "sonota", None
    for th, pat in RULES:
        if re.search(pat, ct):
            return th, None
    return "sonota", None


def number_of(t):
    m = re.match(r"^\s*\((\d+(?:-\d)?)\)", nf(t))
    return m.group(1) if m else None


def build(fid, toc, notes):
    """戻り値: (埋め込むデータ, 止めるべき問題の一覧, 一覧の行)"""
    if fid not in THEMES:
        return None, [], []
    BY = {d["id"]: d for d in toc}
    cm = COMMON[fid]
    errs, rows = [], []
    th, gs, xt, used_ov = {}, {}, {}, set()
    for d in toc:
        did = d["id"]
        if did in cm["docs"]:
            continue
        F = flat(d)
        if not F:
            th[did] = [DOC_THEME.get(did, "sonota")]
            rows.append((did, "", d["t"], th[did][0], ""))
            continue
        arr, seen = [], {}
        for h, f in enumerate(F):
            if f["sec"] is None and f["n"]:
                arr.append(None)   # 見出しを持つ章は入れ物（章のページで読む）
                continue
            if did in DOC_THEME:
                arr.append(DOC_THEME[did]); rows.append((did, f["sec"] or "", f["t"], DOC_THEME[did], "")); continue
            t, g = classify(f["t"], f["sec"])
            seen[f["t"]] = seen.get(f["t"], 0) + 1
            ov = OVERRIDE.get((did, f["t"], seen[f["t"]]))
            if ov:
                used_ov.add((did, f["t"], seen[f["t"]]))
                t = ov.lstrip("-")
                if ov.startswith("-"):
                    g = None
                elif g is not None:
                    g = ""   # 減算の見出しのまま、テーマだけ変える（基準には付けない）
            arr.append(t)
            if g is not None:
                gs.setdefault(did, {})[str(h)] = {"pat": g, "ch": f["c"]}
            rows.append((did, f["sec"] or "", f["t"], t, "減算" if g is not None else ""))
        th[did] = arr
    # 減算 → 基準の見出し
    gout = {}
    for did, m in gs.items():
        F = flat(BY[did])
        nmap = notes.get(did) or {}

        def ntext(b):
            n = nmap.get(b) or {}
            return nf(" ".join([F[b]["t"], n.get("gist", "")] + list(n.get("points") or [])))
        for hs, g in m.items():
            h = int(hs)
            ch_t = F[h]["sec"] or ""
            if QA_CH.search(nf(ch_t)):
                continue   # Q&A・指摘事例の中の減算は、テーマの1項目として出す
            rule = next((r for r in GENSAN if r[0] == g["pat"]), None)
            excl = next((v for (dd, pp), v in GENSAN_EXCL.items() if dd == did and pp == g["pat"]), None)
            bases = []
            for bpat, cpat in (rule[2] if rule else []):
                cand = []
                for b, f in enumerate(F):
                    if b == h or th[did][b] is None or f["sec"] is None and f["n"]:
                        continue
                    if QA_CH.search(nf(f["sec"] or "")) or "減算" in f["t"] or "加算" in f["t"]:
                        continue
                    if not re.search(bpat, clean(f["t"])) or (cpat and not re.search(cpat, nf(f["sec"] or ""))):
                        continue
                    if excl and re.search(excl, clean(f["t"])):
                        continue
                    if rule[3] and rule[3] not in ntext(b):
                        continue   # 基準の要点に、減算の話（拘束・事故など）が出てこないものは付けない
                    if "減算" in nf((nmap.get(b) or {}).get("gist", "")):
                        continue   # 概要が減算の取扱いを説明している見出し（報酬の側の見出し）は基準にしない
                    cand.append(b)
                if cand:
                    same = [b for b in cand if F[b]["c"] == F[h]["c"]]
                    bases = same or cand
                    break
            # 県の要点が「2（46）」のように基準の見出しを番号で指しているときは、それと合うか確かめる
            n = nmap.get(h) or {}
            txt = nf(" ".join([n.get("gist", "")] + list(n.get("points") or [])))
            ref = re.search(r"(\d)\((\d+)\)", txt)
            if ref and bases:
                want = ref.group(2)
                hit = [b for b in bases if number_of(F[b]["t"]) == want and F[b]["c"] + 1 == int(ref.group(1))]
                if not hit:
                    errs.append(f"{did}: 減算「{clean(F[h]['t'])}」の要点は {ref.group(0)} を指すが、規則で選んだ基準は {[F[b]['t'][:16] for b in bases]}")
                else:
                    bases = hit + [b for b in bases if b not in hit]
            # テーマが違う基準（例: 高齢の身体拘束は取扱方針に書かれている）は、減算のテーマのページにも出す
            for b in bases:
                if th[did][b] != th[did][h]:
                    xt.setdefault(did, {}).setdefault(str(b), [])
                    if th[did][h] not in xt[did][str(b)]:
                        xt[did][str(b)].append(th[did][h])
            gout.setdefault(did, {})[hs] = bases
            rows.append((did, ch_t, "  └ 減算「" + F[h]["t"] + "」の付け先", th[did][h], " / ".join(clean(F[b]["t"]) + ("〔" + th[did][b] + "から〕" if th[did][b] != th[did][h] else "") for b in bases) or "（基準の見出しなし・単独で出す）"))
    # 共通の資料
    citems = {}
    for did in cm["docs"]:
        d = BY.get(did)
        if not d:
            continue
        F = flat(d)
        lv = cm["level"] if isinstance(cm["level"], str) else cm["level"].get(did, "sub")
        for h, f in enumerate(F):
            if lv == "chap":
                if f["sec"] is not None:
                    continue
            elif f["sec"] is None and f["n"]:
                continue
            if did in DOC_THEME:
                t = DOC_THEME[did]
            else:
                t, _ = classify(f["t"], f["sec"] if lv == "sub" else None)
                if (did, f["t"], 1) in OVERRIDE:
                    used_ov.add((did, f["t"], 1))
                    t = OVERRIDE[(did, f["t"], 1)].lstrip("-")
            citems.setdefault(t, []).append([did, h])
            rows.append((did, f["sec"] or "", f["t"], t, "共通"))
    for k in OVERRIDE:
        if k[0] in BY and k not in used_ov:
            print(f"  {fid}: 見出しごとに決めたテーマ（OVERRIDE）が見出しに当たりません。資料の差し替えで見出しが変わったら直す: {k}")   # 止めない（古い指定は害がない）
    out = {"list": [{"id": i, "t": t} for i, t in THEMES[fid]], "th": th, "gs": gout, "xt": xt,
           "cm": {"label": cm["label"], "short": cm["short"], "items": citems}}
    # 見出しの数え漏れ
    for d in toc:
        if d["id"] in cm["docs"]:
            continue
        F = flat(d)
        if F and len(th[d["id"]]) != len(F):
            errs.append(f"{d['id']}: テーマの数と見出しの数が合いません")
    return out, errs, rows


def main():
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(SRC))
    import build as B   # noqa
    outdir = SRC / "_review"
    outdir.mkdir(exist_ok=True)
    allrows = []
    for fid in ("shogai", "kourei"):
        src = SRC if fid == "shogai" else SRC / fid
        toc = json.loads((src / "toc.json").read_text(encoding="utf-8"))
        notes, _, _ = B.load_notes(toc, src)
        data, errs, rows = build(fid, toc, notes)
        for e in errs:
            print(fid, "問題:", e)
        names = dict(THEMES[fid])
        from collections import Counter
        c = Counter(r[3] for r in rows if r[4] != "共通" and not r[2].startswith("  └"))
        print(fid, {names[k]: v for k, v in c.items()})
        allrows += [(fid,) + r[:3] + (names.get(r[3], r[3]), r[4]) for r in rows]
    with open(outdir / "themes.tsv", "w", encoding="utf-8") as f:
        f.write("分野\t資料\t章\t見出し\tテーマ\t備考\n")
        for r in allrows:
            f.write("\t".join(str(x).replace("\t", " ") for x in r) + "\n")
    print(outdir / "themes.tsv", len(allrows), "行")


if __name__ == "__main__":
    main()
