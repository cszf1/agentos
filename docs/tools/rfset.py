#!/usr/bin/env python3
"""rfset.py ID 'state' 'commits' 'evidence' 'remaining'  -> replace the row of docs/V1.0_REVIEW_FIXES.md (keeps level/items)"""
import os, sys, re
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "V1.0_REVIEW_FIXES.md")
i, st, cm, ev, rem = sys.argv[1:6]
L = open(p, encoding="utf-8").read().split("\n")
for k, l in enumerate(L):
    if l.startswith(f"| {i} |"):
        f = [x.strip() for x in l.strip("|").split("|")]
        f[3], f[4], f[5], f[6] = st, cm, ev, rem
        L[k] = "| " + " | ".join(f) + " |"
        break
else:
    sys.exit("no row " + i)
open(p, "w", encoding="utf-8").write("\n".join(L))
