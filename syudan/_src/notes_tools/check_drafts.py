"""下書き（drafts/*.json）を機械で確かめる。
  python3 check_drafts.py [下書きの名前…]
確かめること: 鍵の漏れ・並び／根拠の抜き出しが原文にあるか／文中の数字が原文にあるか／原文の写しすぎ／使わない言葉
"""
import json, pathlib, re, sys, unicodedata
from difflib import SequenceMatcher

import os
BASE = pathlib.Path(__file__).resolve().parent
CH = os.environ.get("CHUNKS", "chunks")
DR = os.environ.get("DRAFTS", "drafts")
nk = lambda s: unicodedata.normalize("NFKC", s or "")
sq = lambda s: re.sub(r"\s+", "", nk(s))


def stmts(it):
    out = [("gist", it.get("gist", ""))]
    out += [(f"points.{i}", x) for i, x in enumerate(it.get("points", []))]
    out += [(f"shiteki.{i}", x) for i, x in enumerate(it.get("shiteki", []))]
    return [(k, v) for k, v in out if v]


def longest_common(a, b):
    m = SequenceMatcher(None, a, b, autojunk=False).find_longest_match(0, len(a), 0, len(b))
    return a[m.a:m.a + m.size]


BAN = re.compile(r"まだ|(?<![ぁ-ん])いま(?![すせしそ])|今すぐ|いますぐ")


def check(name, chunk_names):
    src = {}
    for c in chunk_names:
        for it in json.loads((BASE / CH / f"{c}.json").read_text())["items"]:
            src[it["k"]] = it
    d = json.loads((BASE / DR / f"{name}.json").read_text())
    probs = []
    ks = [it["k"] for it in d["items"]]
    if ks != list(src):
        probs.append(("ALL", "鍵の漏れ・並び違い", f"足りない {sorted(set(src) - set(ks))[:5]} 余分 {sorted(set(ks) - set(src))[:5]}"))
    for it in d["items"]:
        s = src.get(it["k"])
        if not s:
            continue
        text = sq(s["text"]) + sq(s["t"])
        evs = it.get("ev", [])
        for to, v in stmts(it):
            if not any(e.get("to") == to for e in evs):
                probs.append((it["k"], to, "根拠なし"))
            for n in re.findall(r"\d+(?:\.\d+)?", nk(v)):
                if n not in text:
                    probs.append((it["k"], to, f"数字 {n} が原文にない: {v[:50]}"))
            lc = longest_common(sq(v), text)
            if len(lc) > 24:
                probs.append((it["k"], to, f"写しすぎ({len(lc)}字): {lc[:40]}"))
            if BAN.search(v):
                probs.append((it["k"], to, f"使わない言葉: {v[:40]}"))
        for e in evs:
            if sq(e.get("q", "")) not in text:
                probs.append((it["k"], e.get("to"), f"抜き出しが原文にない: {e.get('q', '')[:40]}"))
    return d, probs


if __name__ == "__main__":
    groups = json.loads((BASE / "groups.json").read_text())
    names = sys.argv[1:] or list(groups)
    total = 0
    for n in names:
        if not (BASE / DR / f"{n}.json").exists():
            print(n, "下書きなし"); continue
        d, probs = check(n, groups[n])
        nst = sum(len(stmts(it)) for it in d["items"])
        print(f"== {n} 項目 {len(d['items'])} 文 {nst} 問題 {len(probs)}")
        for p in probs:
            print("  ", *p)
        total += len(probs)
    print("問題の合計", total)
