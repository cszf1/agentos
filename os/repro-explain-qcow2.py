#!/usr/bin/env python3
"""V1-O09: explain why two clean builds of agentos-qcow2 differ (os/packages/qcow2.nix, decision 11).

Usage: repro-explain-qcow2.py <a.qcow2> <b.qcow2>   (needs qemu-img, sfdisk, cryptsetup, mtools on PATH)
Converts both images to sparse raw files, compares the GPT, then every partition. A difference is *expected* only
inside the LUKS2 partition: luksFormat draws a fresh volume key, keyslot salts and UUID by design (the template key is
public, the first boot replaces it), so every ciphertext byte differs. Anything else (GPT, ESP, gaps) is reported as
unexplained and the script exits 1.
"""
import hashlib, json, subprocess, sys

def sh(*a):
    return subprocess.run(a, check=True, capture_output=True, text=True).stdout

def digest(f, off, size):
    h = hashlib.sha256()
    with open(f, "rb") as fh:
        fh.seek(off)
        left = size
        while left:
            b = fh.read(min(left, 1 << 22))
            if not b:
                break
            h.update(b)
            left -= len(b)
    return h.hexdigest()

def fat_files(raw, off):
    """{path: sha256} of every file in a FAT partition (mtools reads it at a byte offset; no mount needed)."""
    import os, tempfile
    d = tempfile.mkdtemp()
    env = dict(os.environ, MTOOLS_SKIP_CHECK="1")
    r = subprocess.run(["mcopy", "-s", "-n", "-i", f"{raw}@@{off}", "::/", d], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        return None
    out = {}
    for root, _, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            out[os.path.relpath(p, d)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    return out

def fat_diff(ra, rb, off, size):
    """Which files differ inside a FAT partition, or (same files) that only FAT metadata differs."""
    fa, fb = fat_files(ra, off), fat_files(rb, off)
    if fa is None or fb is None:
        return "files not readable (mtools missing or not FAT)"
    diff = sorted(k for k in set(fa) | set(fb) if fa.get(k) != fb.get(k))
    if diff:
        return f"files differing: {diff}"
    blocks = differing_blocks(ra, rb, off, size)
    return f"same {len(fa)} files; {len(blocks)} differing 4 KiB blocks outside file contents (FAT metadata or unallocated clusters), first at partition offsets {blocks[:8]}"

def differing_blocks(ra, rb, off, size=None, bs=4096):
    out = []
    with open(ra, "rb") as fa, open(rb, "rb") as fb:
        fa.seek(off)
        fb.seek(off)
        pos = 0
        while size is None or pos < size:
            a, b = fa.read(bs), fb.read(bs)
            if not a:
                break
            if a != b:
                out.append(pos)
            pos += bs
    return out

a, b = sys.argv[1], sys.argv[2]
for q, r in ((a, "/tmp/repro-a.raw"), (b, "/tmp/repro-b.raw")):
    sh("qemu-img", "convert", "-O", "raw", q, r)
ra, rb = "/tmp/repro-a.raw", "/tmp/repro-b.raw"
ta = json.loads(sh("sfdisk", "-J", ra))["partitiontable"]
tb = json.loads(sh("sfdisk", "-J", rb))["partitiontable"]
unexplained = []
same_layout = [(p["start"], p["size"], p["type"]) for p in ta["partitions"]] == [(p["start"], p["size"], p["type"]) for p in tb["partitions"]]
print("GPT disk id", "same" if ta.get("id") == tb.get("id") else f"DIFFERS {ta.get('id')} {tb.get('id')}")
print("partition layout (start/size/type)", "same" if same_layout else "DIFFERS")
if ta.get("id") != tb.get("id") or not same_layout:
    unexplained.append("GPT")
for pa, pb in zip(ta["partitions"], tb["partitions"]):
    off, size = pa["start"] * 512, pa["size"] * 512
    same = digest(ra, off, size) == digest(rb, off, size)
    with open(ra, "rb") as fh:
        fh.seek(off)
        magic = fh.read(6)
    luks = magic == b"LUKS\xba\xbe"
    line = f"partition {pa.get('name', '')!r} start={pa['start']} size={pa['size']} uuid {'same' if pa.get('uuid') == pb.get('uuid') else 'DIFFERS'} content {'same' if same else 'DIFFERS'}"
    if pa.get("uuid") != pb.get("uuid"):
        unexplained.append(f"partition uuid {pa.get('name')}")
    if luks:
        hdr = []
        for r in (ra, rb):
            with open(r, "rb") as fh, open(r + ".hdr", "wb") as out:
                fh.seek(off)
                out.write(fh.read(16 << 20))
            j = json.loads(sh("cryptsetup", "luksDump", "--dump-json-metadata", r + ".hdr"))
            u = sh("cryptsetup", "luksUUID", r + ".hdr").strip()
            hdr.append((u, [ks.get("kdf", {}).get("salt") for ks in j.get("keyslots", {}).values()], j.get("segments", {}).get("0", {}).get("encryption")))
        line += f"; LUKS2 uuid {'same' if hdr[0][0] == hdr[1][0] else 'differs'}, keyslot salts {'same' if hdr[0][1] == hdr[1][1] else 'differ'}, cipher {hdr[0][2]} / {hdr[1][2]} (fresh volume key per luksFormat: expected)"
        if hdr[0][2] != hdr[1][2]:
            unexplained.append("LUKS cipher")
    elif not same:
        unexplained.append(f"partition {pa.get('name')} content")
        line += "; " + fat_diff(ra, rb, off, size)
    print(line)
# bytes outside every partition (protective MBR, primary/backup GPT and gaps)
parts = sorted((p["start"] * 512, (p["start"] + p["size"]) * 512) for p in ta["partitions"])
pos, gaps = 0, []
for s, e in parts:
    if s > pos:
        gaps.append((pos, s - pos))
    pos = max(pos, e)
import os
total = os.path.getsize(ra)
if total > pos:
    gaps.append((pos, total - pos))
gap_diff = [g for g in gaps if digest(ra, *g) != digest(rb, *g)]
print("outside partitions (MBR, GPT headers/arrays, gaps):", "same" if not gap_diff else f"DIFFERS at {gap_diff}")
if gap_diff:
    unexplained.append("outside partitions")
print("UNEXPLAINED:", unexplained if unexplained else "none — the only difference is the LUKS2 partition (random volume key, salts, UUID)")
sys.exit(1 if unexplained else 0)
