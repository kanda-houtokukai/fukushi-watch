"""文字の取れないページ（日本語20字未満）を pdfminer で読み直す。CIDフォントのページ（poppler の文字の対応表がなく取れない）は文字が取れる。
本当に画像だけのページは pypdfium2 で画像にし直す（poppler の pdftoppm は日本語の字形を描けないため）。
  python3 tools/thin_fix.py   → thin/<添付>.json {頁: 文字}・img/ を作り直す
"""
import json, os, re, sys, unicodedata, glob
from pdfminer.high_level import extract_text
import pypdfium2 as pdfium
W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = "/tmp/claude-0/-home-claude/d3e68208-19dc-5758-b37a-438c236beec9/scratchpad/kourei/pdf/"
jp = lambda s: len(re.findall(r"[ぁ-んァ-ン一-龥]", s))
os.makedirs(f"{W}/thin", exist_ok=True)
res = {}
for f in sorted(glob.glob(f"{W}/txt/[0-9]*.txt")):
    aid = os.path.basename(f)[:-4]
    if not os.path.exists(PDF + aid + ".pdf"):
        continue
    pg = open(f, encoding="utf-8").read().split("\f")
    if pg and not pg[-1].strip(): pg = pg[:-1]
    thin = [i for i, p in enumerate(pg) if jp(p) < 20]
    if not thin: continue
    out = {}
    doc = pdfium.PdfDocument(PDF + aid + ".pdf")
    for i in thin:
        t = extract_text(PDF + aid + ".pdf", page_numbers=[i])
        out[i + 1] = t if jp(t) >= 20 else ""
    json.dump(out, open(f"{W}/thin/{aid}.json", "w"), ensure_ascii=False)
    res[aid] = (len(thin), sum(1 for v in out.values() if v))
    print(aid, "薄い頁", len(thin), "pdfminer で取れた", res[aid][1], flush=True)
