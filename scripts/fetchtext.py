#!/usr/bin/env python3
"""ページやPDFをシェルから取得して、文字だけにして出す（毎朝の更新タスク用）。

WebFetch はURLによって実行が許可待ちで止まることがあるため、毎朝の更新タスクは
ページをこのスクリプトで読む。リポジトリには何も書かない。

使い方:
  python3 scripts/fetchtext.py URL                 # 文字を標準出力へ
  python3 scripts/fetchtext.py URL -o 保存先.txt    # 文字をファイルへ（リポジトリの外に置く）
  python3 scripts/fetchtext.py URL --links         # ページ内のリンク（文字とURL）も末尾に出す
  python3 scripts/fetchtext.py URL --ocr           # PDFの文字の出ない頁を OCR で読む（検索の索引を作るときだけ。tesseract の jpn が要る）
終了コード: 0=取得できた / 1=取得できなかった（理由は標準エラーへ）
"""
import html
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse

sys.dont_write_bytecode = True
UA = "Mozilla/5.0 (compatible; fukushi-watch/1.0; +https://fukushi-watch.fknd.jp/)"


def fetch(url):
    fd, path = tempfile.mkstemp(prefix="fetch-")
    os.close(fd)
    r = subprocess.run(
        ["curl", "-sS", "-L", "--max-time", "90", "--retry", "2", "-A", UA,
         "-o", path, "-w", "%{http_code}\t%{content_type}\t%{url_effective}", url],
        capture_output=True, text=True)
    meta = r.stdout.split("\t", 2) + ["", ""]
    code, ctype, final = meta[0], meta[1], meta[2]
    with open(path, "rb") as f:
        body = f.read()
    os.unlink(path)
    if r.returncode != 0 or not code.startswith("2"):
        sys.stderr.write(f"取得できませんでした: {url}（HTTP {code or '-'} {r.stderr.strip()}）\n")
        return None, None, None
    return body, ctype, final or url


def fill_pages(path, text, ocr=False):
    """pdftotext で文字がほとんど出ない頁だけを pdfminer で読み直して差し替える（2026-11-02・P75）。
    県の資料には、頁によって日本語のフォント（CID）の文字が pdftotext で出ないものがある（集団指導の共通資料３・４〜６ など）。
    頁の数と順（改ページ文字 \\f の数）は変えない。pdfminer のほうが文字が多い頁だけ差し替える。"""
    ps = text.split("\f")
    tail = ps[-1] if ps and not ps[-1].strip() else None
    body = ps[:-1] if tail is not None else ps
    low = [i for i, t in enumerate(body) if len(re.sub(r"\s", "", t)) < 40]
    if not low or len(low) == len(body):   # 全頁が空なら pdf_text の側で全体を読み直す
        return text
    try:
        from pdfminer.high_level import extract_text
        alt = extract_text(path, page_numbers=set(low)).split("\f")
    except Exception as e:  # pdfminer が無い・読めない
        sys.stderr.write(f"文字の少ない頁を pdfminer で読み直せませんでした（{e}）\n")
        return text
    n = 0
    for i, t in zip(low, alt):
        if len(re.sub(r"\s", "", t)) > len(re.sub(r"\s", "", body[i])):
            body[i] = t
            n += 1
    if n:
        sys.stderr.write(f"pdftotext で文字が出なかった {n} 頁を pdfminer で読みました\n")
    if ocr:
        n = ocr_pages(path, body, [i for i in low if len(re.sub(r"\s", "", body[i])) < 40])
        if n:
            sys.stderr.write(f"文字が線で描かれている {n} 頁を OCR で読みました（誤読を含む。検索の索引にだけ使う）\n")
    return "\f".join(body + ([tail] if tail is not None else []))


def ocr_pages(path, body, idx):
    """文字が図形（線）で描かれた頁を、画像にして tesseract（jpn）で読む。--ocr のときだけ（集団指導の検索の索引用・P75）。
    誤読を含むので、毎朝のタスクが資料の文を確かめる読み方には使わない。tesseract か jpn が無ければ何もしない。"""
    if not idx:
        return 0
    try:
        langs = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True).stdout.split()
    except FileNotFoundError:
        langs = []
    if "jpn" not in langs:
        sys.stderr.write("OCR は tesseract の jpn が無いため行いませんでした（apt-get install tesseract-ocr-jpn）\n")
        return 0
    n = 0
    with tempfile.TemporaryDirectory() as d:
        for i in idx:
            img = os.path.join(d, "p")
            subprocess.run(["pdftoppm", "-f", str(i + 1), "-l", str(i + 1), "-r", "300", "-gray", "-png", "-singlefile", path, img], capture_output=True)
            if not os.path.exists(img + ".png"):
                continue
            r = subprocess.run(["tesseract", img + ".png", "-", "-l", "jpn", "--psm", "6"], capture_output=True)
            t = r.stdout.decode("utf-8", "replace")
            # 日本語の OCR は文字の間に空白が入るので詰める
            t = re.sub(r"(?<=[^\x00-\x7f]) (?=[^\x00-\x7f])", "", t)
            if len(re.sub(r"\s", "", t)) > len(re.sub(r"\s", "", body[i])):
                body[i] = t
                n += 1
            os.unlink(img + ".png")
    return n


def pdf_text(body, ocr=False):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "a.pdf")
        with open(p, "wb") as f:
            f.write(body)
        r = subprocess.run(["pdftotext", "-layout", p, "-"], capture_output=True)
        text = r.stdout.decode("utf-8", "replace")
        pages = max(1, text.count("\f"))
        text = fill_pages(p, text, ocr)
        if len(re.sub(r"\s", "", text)) < 40 * pages:
            # 日本語のフォントを埋め込んでいないPDFは pdftotext で文字が出ないので pdfminer で読み直す
            try:
                from pdfminer.high_level import extract_text
                alt = extract_text(p)
                if len(re.sub(r"\s", "", alt)) > len(re.sub(r"\s", "", text)):
                    sys.stderr.write("pdftotext で文字が出なかったため pdfminer で読みました\n")
                    return alt
            except Exception as e:  # pdfminer が無い・読めない
                sys.stderr.write(f"PDFの文字が少なく、pdfminer でも読めませんでした（{e}）。画像のPDFの可能性があります\n")
        return text


def decode(body, ctype):
    m = re.search(r"charset=([\w-]+)", ctype or "", re.I) or \
        re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', body[:4000], re.I)
    names = []
    if m:
        c = m.group(1)
        names.append(c.decode() if isinstance(c, bytes) else c)
    names += ["utf-8", "cp932", "euc-jp"]
    for n in names:
        try:
            return body.decode(n)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", "replace")


def html_text(src, base, with_links):
    src = re.sub(r"(?is)<(script|style|noscript|svg|template)\b.*?</\1>", " ", src)
    src = re.sub(r"(?s)<!--.*?-->", " ", src)
    # 取り消し線（訂正前の値）は、本文と混ざらないよう印を付ける
    src = re.sub(r"(?is)<(s|del|strike)\b[^>]*>(.*?)</\1>", r"〔取り消し線:\2〕", src)
    links = []
    if with_links:
        for m in re.finditer(r'(?is)<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', src):
            t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", m.group(2)))).strip()
            u = urllib.parse.urljoin(base, html.unescape(m.group(1)))
            if t and u.startswith("http"):
                links.append(f"{t}\t{u}")
    src = re.sub(r"(?i)<br\s*/?>", "\n", src)
    src = re.sub(r"(?i)</?(p|div|li|tr|h[1-6]|dt|dd|table|section|article|ul|ol|header|footer|nav|main)\b[^>]*>", "\n", src)
    src = re.sub(r"(?i)</t[dh]>", "\t", src)
    text = html.unescape(re.sub(r"<[^>]+>", "", src))
    lines = [re.sub(r"[ \t　]+", " ", ln).strip() for ln in text.splitlines()]
    out = "\n".join(ln for ln in lines if ln)
    if links:
        out += "\n\n--- リンク ---\n" + "\n".join(dict.fromkeys(links))
    return out


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        print(__doc__)
        return 1
    url, out, with_links, ocr = args[0], None, "--links" in args, "--ocr" in args
    if "-o" in args:
        out = args[args.index("-o") + 1]
    body, ctype, final = fetch(url)
    if body is None:
        return 1
    if body[:5] == b"%PDF-" or "pdf" in (ctype or "").lower():
        text = pdf_text(body, ocr)
    else:
        text = html_text(decode(body, ctype), final, with_links)
    if not text.strip():
        sys.stderr.write(f"文字を取り出せませんでした: {url}\n")
        return 1
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        sys.stderr.write(f"{url} → {out}（{len(text)}字）\n")
    else:
        sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
