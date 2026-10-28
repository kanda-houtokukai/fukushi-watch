#!/usr/bin/env python3
"""ページやPDFをシェルから取得して、文字だけにして出す（毎朝の更新タスク用）。

WebFetch はURLによって実行が許可待ちで止まることがあるため、毎朝の更新タスクは
ページをこのスクリプトで読む。リポジトリには何も書かない。

使い方:
  python3 scripts/fetchtext.py URL                 # 文字を標準出力へ
  python3 scripts/fetchtext.py URL -o 保存先.txt    # 文字をファイルへ（リポジトリの外に置く）
  python3 scripts/fetchtext.py URL --links         # ページ内のリンク（文字とURL）も末尾に出す
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


def pdf_text(body):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "a.pdf")
        with open(p, "wb") as f:
            f.write(body)
        r = subprocess.run(["pdftotext", "-layout", p, "-"], capture_output=True)
        return r.stdout.decode("utf-8", "replace")


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
    url, out, with_links = args[0], None, "--links" in args
    if "-o" in args:
        out = args[args.index("-o") + 1]
    body, ctype, final = fetch(url)
    if body is None:
        return 1
    if body[:5] == b"%PDF-" or "pdf" in (ctype or "").lower():
        text = pdf_text(body)
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
