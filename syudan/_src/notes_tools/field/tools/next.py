"""次に立てる係を n 件出す（下書きと照合を交互に。片方が空ならもう片方）。出したものは待ち行列から外す。 python3 tools/next.py n"""
import sys, os
W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
n = int(sys.argv[1]) if len(sys.argv) > 1 else 1
Q = {}
for f in ("queue_draft_todo.txt", "queue_verify.txt"):
    p = f"{W}/{f}"
    Q[f] = [l.strip() for l in open(p) if l.strip()] if os.path.exists(p) else []
tp = f"{W}/queue_turn.txt"
out, turn = [], int(open(tp).read() or 0) if os.path.exists(tp) else 0
order = [("queue_draft_todo.txt", "draft"), ("queue_verify.txt", "verify")]
while len(out) < n and any(Q[f] for f, _ in order):
    f, kind = order[turn % 2]
    if Q[f]:
        out.append((kind, Q[f].pop(0)))
    turn += 1
open(tp, "w").write(str(turn))
for f in Q:
    open(f"{W}/{f}", "w").write("".join(x + "\n" for x in Q[f]))
for k, x in out:
    print(k, x)
