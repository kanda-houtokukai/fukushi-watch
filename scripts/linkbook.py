"""資料リンク集（両ガイドの #sources）を組み立てる共通部品。kaitei/_src/build.py と dbs/_src/build.py が使う。

しくみ（漏れを出さないため）:
  1. 書き出す前のHTML（本文・埋め込みデータ・部品のすべて）から、外部へのリンクを全部拾う（collect_urls）
  2. 台帳（links.json など）にないリンクは、呼び出し側が渡す手がかり（題名・日付・グループ）で自動で足す（merge）
  3. 書き出したリンク集に、拾ったリンクが1件でも欠けていたら書き出しを止める（missing）
依存は Python 標準ライブラリだけ。
"""
import html as H
import re

# リンク集に載せないもの（フォント・自サイト・SVGの名前空間など、資料ではないもの）
SKIP = ("fonts.googleapis.com", "fonts.gstatic.com", "fukushi-watch.fknd.jp", "www.w3.org", "schema.org")
URL_RE = re.compile(r"https?://[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+")
PLACEHOLDER = "<!--LINKBOOK-->"


def esc(s):
    return H.escape(s or "", quote=True)


def clean(u):
    u = H.unescape(u)
    while u and u[-1] in ".,;:":
        u = u[:-1]
    return u


def collect_urls(text):
    """text に出てくる外部リンクを、出てきた順に重複なしで返す"""
    out, seen = [], set()
    for m in URL_RE.finditer(text):
        u = clean(m.group(0))
        if any(s in u for s in SKIP) or u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def url_date(u):
    """こども家庭庁などの PDF の URL にある公表日（/20261023_…）を YYYY-MM-DD で返す"""
    m = re.search(r"/(20\d{2})(\d{2})(\d{2})_", u)
    return "%s-%s-%s" % m.groups() if m else ""


def kind(u):
    p = u.lower().split("?")[0]
    if p.endswith(".pdf"):
        return "PDF"
    if "youtube.com/" in u or "youtu.be/" in u:
        return "動画"
    return ""


def fmt_date(d):
    return d.replace("-", ".") if d else ""


def date_words(d):
    """絞り込みで引けるよう、日付をいくつかの書き方で並べる（10/15・10月15日・2026.10.15 など）"""
    if not d:
        return ""
    y, m, dd = d.split("-")
    mi, di = int(m), int(dd)
    return " ".join([d, fmt_date(d), "%s/%s/%s" % (y, mi, di), "%d/%d" % (mi, di), "%d月%d日" % (mi, di), "%s年%d月%d日" % (y, mi, di), "%s年%d月" % (y, mi)])


def resolve_cites(text, items):
    """本文の根拠表記（例「GL p.94、Q&A応用6-21、横浜市ページ」）を、台帳の資料（cite の呼び名）に結びつける。
    戻り値: (結びついた資料の URL の一覧, 結びつかなかった部分の一覧)。
    「、」で区切った各部分の先頭が資料の呼び名。「・」の後ろが番号だけなら、前の資料の続き（4-5・4-6 など）とみなす。"""
    aliases = sorted(((a, it["u"]) for it in items for a in it.get("cite", [])), key=lambda x: -len(x[0]))

    def hit(part):
        for a, u in aliases:
            if part.startswith(a):
                nxt = part[len(a):len(a) + 1]
                if len(a) == 1 and nxt and not re.match(r"[0-9０-９〜第]", nxt):
                    continue   # 「法」「令」は条番号が続くときだけ（「法人」「令和」に当てない）
                return u
        return None
    found, bad = [], []
    for chunk in re.split(r"[、，,]", text):
        last = None
        for part in chunk.split("・"):
            part = part.strip()
            if not part:
                continue
            u = hit(part)
            if u:
                last = u
                found.append(u)
            elif not (last and re.match(r"^[0-9０-９p別図基応No〜\-（(]", part)):
                bad.append(part)
    return found, bad


def merge(items, found, hints, guess_group):
    """台帳 items に、found のうち未掲載のリンクを足す。hints[url] = {"t", "d", "g"}。足したものを返す"""
    have = set()
    for it in items:
        have.add(it["u"])
        for s in it.get("sub", []):
            have.add(s["u"])
    added = []
    for u in found:
        if u in have:
            continue
        h = hints.get(u) or {}
        added.append({"g": h.get("g") or guess_group(u), "t": h.get("t") or u, "u": u, "d": h.get("d") or url_date(u), "auto": True})
        have.add(u)
    return added


def missing(found, items):
    have = set()
    for it in items:
        have.add(it["u"])
        for s in it.get("sub", []):
            have.add(s["u"])
    return [u for u in found if u not in have]


def _row(it, cls):
    d = it.get("d", "")
    ty = kind(it["u"])
    q = " ".join(x for x in [it["t"], it.get("n", ""), date_words(d), ty] + list(it.get("cite", [])) if x)
    # 題名や注記の「10月15日」も「10/15」で引けるように
    q += "".join(" %s/%s" % m for m in re.findall(r"(\d{1,2})月(\d{1,2})日", it["t"] + it.get("n", "")))
    sub = it.get("sub") or []
    out = ['<li class="%s" data-q="%s">' % (cls, esc(q))]
    if cls == "lk-i":
        out.append('<span class="lk-d">%s</span>' % esc(fmt_date(d)))
    out.append('<span class="lk-b"><a href="%s" target="_blank" rel="noopener">%s</a>' % (esc(it["u"]), esc(it["t"])))
    if ty:
        out.append('<span class="lk-ty">%s</span>' % ty)
    if it.get("n"):
        out.append('<span class="lk-n">%s</span>' % esc(it["n"]))
    if sub:
        out.append('<ul class="lk-sub">' + "".join(_row(s, "lk-s") for s in sub) + "</ul>")
    out.append("</span></li>")
    return "".join(out)


def render(groups, items, example=""):
    """グループごとの一覧と、資料名・日付で絞り込む入力欄"""
    parts = ['<label class="lk-find" for="lk-q"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
             '<input type="search" id="lk-q" placeholder="資料名・日付で探す' + ("（例：" + esc(example) + "）" if example else "")
             + '" aria-label="資料名・日付で探す" autocomplete="off" enterkeyhint="search"></label>',
             '<div class="lk" id="lk">']
    for g in groups:
        its = [i for i in items if i["g"] == g["id"]]
        if not its:
            continue
        parts.append('<div class="lk-g"><h3 class="lk-h">%s</h3><ul class="lk-l">%s</ul></div>' % (esc(g["t"]), "".join(_row(i, "lk-i") for i in its)))
    parts.append('<p class="lk-none" hidden>該当する資料はありません。</p></div>')
    return "\n".join(parts)


def build(html, groups, items, hints, guess_group, example=""):
    """html（PLACEHOLDER を含む）にリンク集を差し込んで返す。戻り値: (html, 足した件数, 欠けているリンク)"""
    found = collect_urls(html.replace(PLACEHOLDER, ""))
    gids = {g["id"] for g in groups}
    for it in items:
        if it["g"] not in gids:
            raise SystemExit("資料リンク集: 未定義のグループ " + it["g"] + " … " + it["t"])
    added = merge(items, found, hints, guess_group)
    allitems = items + added
    block = render(groups, allitems, example)
    listed = set(collect_urls(block))          # 書き出したリンク集に実際に載ったもの
    lost = [u for u in found if u not in listed]
    out = html.replace(PLACEHOLDER, block)
    return out, added, lost, len(listed)
