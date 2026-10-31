#!/usr/bin/env python3
"""v1doc.py — edit docs/ACCEPTANCE_V1.0.md + V1.0_CHECKLIST.md rows and recompute every statistic.
  v1doc.py set ID STATE 'LEVEL' 'CHECKNOTE'   (stdin: new evidence text that replaces the "外部审查降级…原证据：" lead,
                                                or is prepended)   STATE: 通过|部分|未通过
  v1doc.py stats                               recompute counts in ACCEPTANCE (line, table, lists, 统计), HANDOFF
"""
import os, re, sys, collections
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..") + "/"
A, C, H = D + "ACCEPTANCE_V1.0.md", D + "V1.0_CHECKLIST.md", D + "HANDOFF_V1.0.md"
ROW = re.compile(r'^\| (V1-[A-Z]\d\d) \| ([^|]*) \| (通过|部分|未通过) \| ([^|]*) \| (.*) \|$')
MARK = {"通过": "☑", "部分": "◐", "未通过": "☐"}


def rows():
    L = open(A, encoding="utf-8").read().split("\n")
    R = {}
    for n, l in enumerate(L):
        m = ROW.match(l)
        if m:
            R[m.group(1)] = [n] + list(m.groups()[1:])
    return L, R


def tier(lv):
    if "KVM" in lv: return "K"
    if "TCG" in lv: return "T"
    if lv.startswith("Host"): return "H"
    if lv.startswith("需实体机"): return "W"
    if lv == "未验收": return "N"
    return "U"


def stats():
    L, R = rows()
    cnt = collections.Counter(v[2] for v in R.values())
    p, q, f = cnt["通过"], cnt["部分"], cnt["未通过"]
    t = collections.defaultdict(collections.Counter); ids = collections.defaultdict(list)
    for i in sorted(R, key=lambda k: L.index(L[R[k][0]])):
        st, lv = R[i][2], R[i][3]
        t[tier(lv)][st] += 1
        ids[tier(lv)].append(i + ("" if st == "通过" else ("◐" if st == "部分" else "☐")))
    s = "\n".join(L)
    s = re.sub(r"\*\*通过 \d+ / 部分 \d+ / 未通过 \d+（共 100 项）\*\*", f"**通过 {p} / 部分 {q} / 未通过 {f}（共 100 项）**", s)
    names = {"K": "KVM VM（Actions）", "T": "TCG VM", "U": "单元/集成", "H": "Host 级真实模型", "W": "需实体机，未验收", "N": "无可用证据"}
    for k, nm in names.items():
        c = t[k]; tot = sum(c.values())
        s = re.sub(r"^\| " + re.escape(nm) + r" \| \d+ \| \d+ \| \d+ \| \d+ \|", f"| {nm} | {c['通过']} | {c['部分']} | {c['未通过']} | {tot} |", s, flags=re.M)
        s = re.sub(r"^- \*\*" + re.escape(nm) + r"\*\*（\d+）：.*$", f"- **{nm}**（{tot}）：" + "、".join(ids[k]), s, flags=re.M)
    s = re.sub(r"^未通过 \d+ 项，通过 \d+ 项，部分 \d+ 项（共 100 项）。", f"未通过 {f} 项，通过 {p} 项，部分 {q} 项（共 100 项）。", s, flags=re.M)
    open(A, "w", encoding="utf-8").write(s)
    h = open(H, encoding="utf-8").read()
    h = re.sub(r"^\*\*\d+ 通过 / \d+ 部分 / \d+ 未通过\*\*", f"**{p} 通过 / {q} 部分 / {f} 未通过**", h, flags=re.M)
    hn = {"K": "KVM（Actions）", "T": "TCG VM", "U": "单元/集成", "H": "Host 级真实模型", "W": "需实体机，未验收", "N": "无可用证据（O10）"}
    for k, nm in hn.items():
        c = t[k]
        h = re.sub(r"^\| " + re.escape(nm) + r" \| \d+ \| \d+ \| \d+ \|", f"| {nm} | {c['通过']} | {c['部分']} | {c['未通过']} |", h, flags=re.M)
    h = re.sub(r"^\| 合计 \| \d+ \| \d+ \| \d+ \|", f"| 合计 | {p} | {q} | {f} |", h, flags=re.M)
    open(H, "w", encoding="utf-8").write(h)
    # checklist marks must agree
    ck = open(C, encoding="utf-8").read().split("\n"); bad = []
    for l in ck:
        m = re.match(r"- (.) \*\*(V1-[A-Z]\d\d)\*\*", l)
        if m and MARK[R[m.group(2)][2]] != m.group(1) and not (m.group(1) == "⛔" and R[m.group(2)][2] == "未通过"):
            bad.append(m.group(2))
    print(f"{p}/{q}/{f}", {k: dict(v) for k, v in t.items()}, "checklist mismatch:", bad)


def setrow(i, st, lv, note):
    text = sys.stdin.read().strip()
    L, R = rows()
    n, name, _, _, ev = R[i]
    m = re.match(r"\*\*外部审查降级（2026-10-31）\*\*：.*?原证据：", ev)
    if text:
        ev = (text + " 原证据：" + ev[m.end():]) if m else (text + " " + ev)
    L[n] = f"| {i} | {name} | {st} | {lv} | {ev} |"
    open(A, "w", encoding="utf-8").write("\n".join(L))
    ck = open(C, encoding="utf-8").read().split("\n")
    for k, l in enumerate(ck):
        mm = re.match(r"- (.) \*\*" + i + r"\*\*", l)
        if mm:
            l = MARK[st] + l[3:] if False else "- " + MARK[st] + l[3:]
            l = re.sub(r"（证据：[^）]*(?:）[^）]*)?）(?= |$)", "（证据：" + lv + "）", l, count=1)
            if note:
                l = re.sub(r" 【外部审查[^】]*】$", "", l) + f" 【{note}】"
            ck[k] = l
    open(C, "w", encoding="utf-8").write("\n".join(ck))
    stats()


if __name__ == "__main__":
    if sys.argv[1] == "stats":
        stats()
    else:
        setrow(*sys.argv[2:6])
