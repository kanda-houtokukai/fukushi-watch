#!/usr/bin/env python3
"""国の「介護保険施設等運営指導マニュアル」別添「確認項目及び確認文書」（介護保険最新情報 Vol.1288・令和6年7月5日、
老発0704第7号の別紙2）の PDF から、サービスごとの確認項目を取り出す（手で実行する。依存 pdfplumber）。

  python3 syudan/_src/tenken_tools/kakunin_kaigo.py 001272356.pdf

出力: syudan/_src/kourei/tenken/kaigo.json
  {"source": {...}, "services": [{"id", "t", "g", "src": "kaigo", "rows": [{"k", "sec": "質"|"体制", "t", "law", "items": [{"k","x"}], "docs": [...]}]}]}
文は通知のまま（改行でつながった語をつなぐだけ）。○ が確認項目、◆ が確認文書。
福岡県の集団指導（介護保険）の個別資料が扱うサービスだけを取り出す（居宅介護支援・介護予防支援・地域密着型の多くは市町村の所管）。
"""
import hashlib, json, pathlib, re, sys
import pdfplumber

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / "syudan" / "_src" / "kourei" / "tenken" / "kaigo.json"
SOURCE = {"by": "厚生労働省老健局長", "of": "介護保険施設等運営指導マニュアル（令和6年7月改正）",
          "u": "https://www.mhlw.go.jp/content/001272356.pdf", "note": "介護保険最新情報 Vol.1288（令和6年7月5日）・老発0704第7号 別紙2"}
# 番号 → (id, 県の個別資料のまとまり)
USE = {
    "101": ("houmonkaigo", "houmon"), "102": ("houmonnyuyoku", "houmon"), "103": ("houmonkango", "houmon"),
    "401": ("y-houmonnyuyoku", "houmon"), "402": ("y-houmonkango", "houmon"),
    "106": ("tsushokaigo", "tsusho"), "609": ("chiiki-tsusho", "tsusho"), "107": ("tsushoriha", "tsusho"), "104": ("houmonriha", "tsusho"),
    "405": ("y-tsushoriha", "tsusho"), "403": ("y-houmonriha", "tsusho"),
    "303": ("iryoin", "iryo"), "109": ("tankiryoyo", "iryo"), "108": ("tankiseikatsu", "iryo"), "407": ("y-tankiryoyo", "iryo"), "406": ("y-tankiseikatsu", "iryo"),
    "110": ("tokutei", "tokutei"), "408": ("y-tokutei", "tokutei"), "606": ("chiiki-tokutei", "tokutei"),
    "111": ("yogutaiyo", "yogu"), "112": ("yoguhanbai", "yogu"), "409": ("y-yogutaiyo", "yogu"), "410": ("y-yoguhanbai", "yogu"),
    "301": ("tokuyo", "tokuyo"), "607": ("chiiki-tokuyo", "tokuyo"),
    "302": ("roken", "roken"),
    "105": ("ryoyo", "ryoyo"), "404": ("y-ryoyo", "ryoyo"),
}
SEC = {"個別サービスの質に関する事項": "質", "個別サービスの質を確保するための体制に関する事項": "体制"}
X1, XO, X2, XD = 180, 200, 368, 388   # 列の境（項目｜○｜確認項目｜◆｜確認文書）


def key(*a):
    return hashlib.sha1("|".join(a).encode()).hexdigest()[:10]


def join(parts):
    """改行で切れた文をつなぐ。番号の行（1.〜）の前では改行を残す"""
    out = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if out and re.match(r"^\d+[.．]", p):
            out += "\n" + p
        else:
            out += p
    return re.sub(r"\s+(?=[^\x00-\x7f])|(?<=[^\x00-\x7f])\s+", "", out).strip()


def lines_of(page):
    ws = page.extract_words(keep_blank_chars=False, use_text_flow=False)
    rows = {}
    for w in ws:
        t = round(w["top"] / 3)
        rows.setdefault(t, []).append(w)
    out = []
    for t in sorted(rows):
        ln = sorted(rows[t], key=lambda w: w["x0"])
        out.append(ln)
    # 近い top を同じ行にまとめる（±3pt）
    merged = []
    for ln in out:
        if merged and abs(ln[0]["top"] - merged[-1][0]["top"]) < 3.5:
            merged[-1] = sorted(merged[-1] + ln, key=lambda w: w["x0"])
        else:
            merged.append(ln)
    return merged


def main():
    pdf = pdfplumber.open(sys.argv[1])
    # 目次（PDFの25頁目）: 番号 サービス 頁
    toc = []
    t = pdf.pages[24].extract_text()
    for m in re.finditer(r"(\d{3})\s+(\S+?)\s+(\d+)(?=\s|$)", t):
        toc.append((m.group(1), m.group(2), int(m.group(3))))
    toc.sort(key=lambda x: x[2])
    first = next(i for i in range(25, 40) if pdf.pages[i].extract_text().strip().startswith("101"))
    off = first - 1   # 印字頁 1 → PDF の index
    services = []
    for n, (code, name, pp) in enumerate(toc):
        end = toc[n + 1][2] if n + 1 < len(toc) else None
        if code not in USE:
            continue
        sid, g = USE[code]
        a = pp + off
        b = (end + off) if end else a + 6
        rows, cur, sec, item, doc = [], None, None, None, None
        full_name = None
        for pi in range(a, b):
            page = pdf.pages[pi]
            txt = page.extract_text() or ""
            head = txt.strip().splitlines()[0] if txt.strip() else ""
            if not head.startswith(code):
                break
            full_name = re.sub(r"^\d{3}\s*", "", head).strip()
            for ln in lines_of(page):
                s = "".join(w["text"] for w in ln)
                if s.startswith(code) or s in ("確認項目確認文書",) or re.fullmatch(r"\d+", s):
                    continue
                if s.startswith("注）") or s.startswith("注)"):
                    break
                if s in SEC:
                    sec = SEC[s]
                    continue
                c1 = [w["text"] for w in ln if w["x0"] < X1]
                o = any(w["text"] == "○" and X1 <= w["x0"] < XO for w in ln)
                c2 = [w["text"] for w in ln if XO <= w["x0"] < X2 and w["text"] != "○"]
                d = any(w["text"] == "◆" and X2 <= w["x0"] < XD for w in ln)
                c3 = [w["text"] for w in ln if w["x0"] >= XD]
                if "確認項目" in c2 and "確認文書" in c3:
                    continue
                if c1 and (cur is None or cur["closed"]):
                    cur = {"sec": sec, "t1": [], "items": [], "docs": [], "closed": False}
                    rows.append(cur)
                    item = doc = None
                if cur is None:
                    continue
                if c1:
                    cur["t1"].append("".join(c1))
                    if re.search(r"条[^）)]*[）)]\s*$", "".join(cur["t1"])) or "".join(c1).endswith("）") and "第" in "".join(cur["t1"]):
                        cur["closed"] = True
                if o:
                    item = []
                    cur["items"].append(item)
                if c2 and item is not None:
                    item.append(" ".join(c2))
                if d:
                    doc = []
                    cur["docs"].append(doc)
                if c3 and doc is not None:
                    doc.append(" ".join(c3))
        out_rows = []
        for r in rows:
            t1 = join(r["t1"])
            m = re.search(r"[（(]第.*$", t1)
            law = m.group(0) if m else ""
            title = t1[:m.start()] if m else t1
            items = [join(x) for x in r["items"] if join(x)]
            docs = [join(x) for x in r["docs"] if join(x)]
            if not title or not items:
                continue
            k = key(sid, r["sec"] or "", title)
            out_rows.append({"k": k, "sec": r["sec"], "t": title, "law": law.replace(" ", ""),
                             "items": [{"k": key(k, x), "x": x} for x in items], "docs": docs, "note": []})
        services.append({"id": sid, "code": code, "t": full_name or name, "g": g, "src": "kaigo", "rows": out_rows})
        print(code, full_name, "行", len(out_rows), "確認項目", sum(len(r["items"]) for r in out_rows))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"source": SOURCE, "services": services}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("書いた", OUT, "サービス", len(services))


if __name__ == "__main__":
    main()
