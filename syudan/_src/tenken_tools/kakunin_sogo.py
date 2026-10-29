#!/usr/bin/env python3
"""国の「確認項目及び確認文書」（障害福祉サービス・令和8年6月）の Excel を、点検表のデータにする。

  python3 syudan/_src/tenken_tools/kakunin_sogo.py <確認項目及び確認文書.xlsx>
  → syudan/_src/tenken/sogo.json

- 出典: 厚生労働省「指定障害福祉サービス事業者等の指導監査について」（令和8年6月8日 障発0608第1号）の
  関係資料「確認項目及び確認文書」 https://www.mhlw.go.jp/content/260608-22.xlsx
- 国の通知の別添なので、文は変えずにそのまま持つ（折り返しの改行と行頭の字下げだけを取る）。
- 1シート＝1サービス。行＝確認項目のまとまり（例「設備（第２１０条）」）、○＝確認項目、◇＝確認文書。
依存: openpyxl
"""
import json, pathlib, re, sys, hashlib
import openpyxl

OUT = pathlib.Path(__file__).resolve().parent.parent / "tenken" / "sogo.json"
SRC_URL = "https://www.mhlw.go.jp/content/260608-22.xlsx"
PAGE_URL = "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/hukushi_kaigo/shougaishahukushi/kanriseibi/index.html"

# シート名 → (県の区分, 点検表での呼び名)。自立支援医療機関は福祉サービスではないので載せない
SHEETS = {
    "居宅介護": "kyotaku", "重度訪問介護": "kyotaku", "同行援護": "kyotaku", "行動援護": "kyotaku",
    "重度障害者包括支援": "kyotaku",
    "療養介護": "nicchu", "生活介護": "nicchu", "短期入所": "nicchu",
    "自立訓練（機能訓練）": "nicchu", "自立訓練（生活訓練）": "nicchu",
    "就労移行支援": "nicchu", "就労選択支援": "nicchu", "就労継続支援Ａ型": "nicchu", "就労継続支援Ｂ型": "nicchu",
    "就労定着支援": "nicchu", "自立生活援助": "nicchu", "支援施設": "nicchu",
    "共同生活援助": "gh",
    "地域移行支援": "soudan", "地域定着支援": "soudan", "計画相談支援": "soudan",
}
NAME = {"支援施設": "障害者支援施設"}
SID = {
    "居宅介護": "kyotaku-kaigo", "重度訪問介護": "judo-homon", "同行援護": "doko", "行動援護": "kodo",
    "重度障害者包括支援": "hokatsu", "療養介護": "ryoyo", "生活介護": "seikatsu", "短期入所": "tanki",
    "自立訓練（機能訓練）": "kino", "自立訓練（生活訓練）": "seikatsu-kunren", "就労移行支援": "iko",
    "就労選択支援": "sentaku", "就労継続支援Ａ型": "a-gata", "就労継続支援Ｂ型": "b-gata", "就労定着支援": "teichaku",
    "自立生活援助": "jiritsu-enjo", "支援施設": "shisetsu", "共同生活援助": "gh",
    "地域移行支援": "chiiki-iko", "地域定着支援": "chiiki-teichaku", "計画相談支援": "keikaku",
}
SECTION = {"個別サービスの質に関する事項": "質", "個別サービスの質を確保するための体制に関する事項": "体制"}


def key(*parts):
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


def join_wrapped(block, mark):
    """「○　…⏎　…」の折り返しをつなぐ。行頭が mark なら新しい項目。①などの小項目は改行を残す"""
    items, cur = [], None
    for ln in str(block).replace("\r", "").split("\n"):
        if not ln.strip():
            continue
        s = ln.strip()
        if s.startswith(mark):
            if cur is not None:
                items.append(cur)
            cur = s[len(mark):].strip()
        elif cur is None:
            cur = s
        elif re.match(r"^[①-⑳]|^[（(][ア-ン0-9０-９][）)]", s):
            cur += "\n" + s
        else:
            cur += s
    if cur is not None:
        items.append(cur)
    return items


def docs_of(block):
    """確認文書「◇　勤務実績表⏎◇　出勤簿（タイム⏎　　カード）」→ ["勤務実績表", "出勤簿（タイムカード）"]。
    【目視】など ◇ のない行は前の文書に付けず、別に返す"""
    out, extra = [], []
    cur = None
    for ln in str(block or "").replace("\r", "").split("\n"):
        s = ln.strip()
        if not s:
            continue
        if s.startswith("◇"):
            if cur is not None:
                out.append(cur)
            cur = s[1:].strip()
        elif s.startswith("【") or cur is None:
            if cur is not None:
                out.append(cur); cur = None
            extra.append(s)
        else:
            cur += s
    if cur is not None:
        out.append(cur)
    return out, extra


def main(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    services = []
    for ws in wb.worksheets:
        if ws.title not in SHEETS:
            continue
        rows, sec, seen = [], None, set()
        for r in ws.iter_rows(values_only=True):
            r = list(r) + [None] * 4
            b, c, d = r[1], r[2], r[3]
            if b and str(b).strip() in SECTION:
                sec = SECTION[str(b).strip()]
                continue
            if b and str(b).strip() == "確認項目":
                continue
            if b and str(b).strip() == ws.title:
                continue
            if not c:
                continue
            head = [x.strip() for x in str(b or "").split("\n") if x.strip()]
            title = head[0] if head else ""
            law = "".join(head[1:])
            items = join_wrapped(c, "○")
            docs, extra = docs_of(d)
            rk = key(ws.title, title, law)
            while rk in seen:
                rk = key(rk, "+")
            seen.add(rk)
            its = []
            for x in items:
                ik = key(ws.title, title, law, x)
                while ik in seen:   # 同じまとまりに同じ文が2回あるとき
                    ik = key(ik, "+")
                seen.add(ik)
                its.append({"k": ik, "x": x})
            rows.append({"k": rk, "sec": sec, "t": title, "law": law, "items": its, "docs": docs, "note": extra})
        services.append({"id": SID[ws.title], "t": NAME.get(ws.title, ws.title), "g": SHEETS[ws.title],
                         "src": "sogo", "rows": rows})
    out = {"source": {"t": "確認項目及び確認文書（障害福祉サービス）", "by": "厚生労働省",
                      "of": "指定障害福祉サービス事業者等の指導監査について（令和8年6月8日 障発0608第1号）",
                      "u": SRC_URL, "page": PAGE_URL},
           "services": services}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n = sum(len(r["items"]) for s in services for r in s["rows"])
    print(OUT, "サービス", len(services), "まとまり", sum(len(s["rows"]) for s in services), "確認項目", n)


if __name__ == "__main__":
    main(sys.argv[1])
