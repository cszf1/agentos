#!/usr/bin/env python3
"""V1-O09: explain why two clean builds of agentos-qcow2 differ (os/packages/qcow2.nix, decision 11).

Usage: repro-explain-qcow2.py <a.qcow2> <b.qcow2> [<template key>]   (needs qemu-img, sfdisk, cryptsetup, mtools,
losetup, mount and sudo on PATH)
Converts both images to sparse raw files, compares the GPT, then every partition. A difference is *expected* only
inside the LUKS2 partition: luksFormat draws a fresh volume key, keyslot salts and UUID by design (the template key is
public, the first boot replaces it), so every ciphertext byte differs. Anything else (GPT, ESP, gaps) is reported as
unexplained and the script exits 1.

Review F09: with the template key (public at build time, os/modules/template-disk.key) both LUKS2 partitions are
opened read-only and the Btrfs trees compared: the set of subvolumes and paths, file types, permissions and owners,
symlink targets, the Nix closure (store path names) and the sha256 of every regular file. Any difference there is
unexplained, except three narrow cases checked file by file (explain_file: the Nix database compared row by row
with registration times reported, /etc/shadow in another line order, SQLite -shm scratch). File times are reported,
not judged (they are not part of the image's content).
"""
import hashlib, json, os, stat as S, subprocess, sys

def sh(*a):
    # sudo resets PATH (secure_path): hand it the tools from this PATH (the nix shell) by absolute path
    if a and a[0] == "sudo" and len(a) > 1 and "/" not in a[1]:
        import shutil
        a = ("sudo", shutil.which(a[1]) or a[1]) + tuple(a[2:])
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


def tree(root):
    """{relpath: (type, mode, uid, gid, sha256|target)} for every entry under root (no following links)."""
    out = {}
    for d, dirs, files in os.walk(root):
        dirs.sort()
        for n in sorted(dirs) + sorted(files):
            p = os.path.join(d, n)
            st = os.lstat(p)
            rel = os.path.relpath(p, root)
            if S.S_ISLNK(st.st_mode):
                v = ("l", st.st_mode & 0o7777, st.st_uid, st.st_gid, os.readlink(p))
            elif S.S_ISDIR(st.st_mode):
                v = ("d", st.st_mode & 0o7777, st.st_uid, st.st_gid, None)
            elif S.S_ISREG(st.st_mode):
                h = hashlib.sha256()
                with open(p, "rb") as fh:
                    for blk in iter(lambda: fh.read(1 << 20), b""):
                        h.update(blk)
                v = ("f", st.st_mode & 0o7777, st.st_uid, st.st_gid, h.hexdigest())
            else:
                v = ("o", st.st_mode, st.st_uid, st.st_gid, None)
            out[rel] = v
    return out

def explain_file(rel, pa, pb):
    """Why one regular file differs between the two trees, or None when the difference is not explained.
    Only three narrow cases are accepted (run 41202870389): the Nix database (same paths, hashes, sizes, references;
    registration times and row ids are reported, not judged), /etc/shadow written in a different line order (Perl hash
    order in update-users-groups; the same set of lines), and a SQLite shared-memory index (-shm, derived scratch)."""
    import sqlite3, shutil, tempfile
    base = rel.split("/", 1)[-1]
    if rel.endswith(".sqlite-shm"):
        return "SQLite shared-memory index (derived scratch, not content)"
    if base == "etc/shadow":
        la, lb = open(pa, encoding="utf-8").read().splitlines(), open(pb, encoding="utf-8").read().splitlines()
        if sorted(la) == sorted(lb):
            return f"same {len(la)} lines, different order"
        da = sorted(set(la) - set(lb)); db_ = sorted(set(lb) - set(la))
        mask = lambda L: [l.split(":")[0] + ":<field2 " + str(len(l.split(":")[1])) + " chars>:" + ":".join(l.split(":")[2:]) for l in L]
        print(f"    /etc/shadow lines only in a {mask(da)}, only in b {mask(db_)}")
        return None
    if base == "nix/var/nix/db/db.sqlite" or rel.endswith("/nix/db/db.sqlite"):
        def dump(path):
            d = tempfile.mkdtemp(); c = os.path.join(d, "db.sqlite"); shutil.copy(path, c)
            con = sqlite3.connect(c)
            vp = {r[0]: r[1:] for r in con.execute("select path, hash, narSize, ifnull(deriver,''), ifnull(ca,''), ultimate from ValidPaths")}
            refs = sorted(con.execute("select a.path, b.path from Refs r join ValidPaths a on a.id=r.referrer join ValidPaths b on b.id=r.reference"))
            times = sorted({r[0] for r in con.execute("select registrationTime from ValidPaths")})
            con.close(); shutil.rmtree(d)
            return vp, refs, times
        (va, ra, ta), (vb, rb, tb) = dump(pa), dump(pb)
        if va == vb and ra == rb:
            return f"Nix database: same {len(va)} valid paths (hash, narSize, deriver, ca) and {len(ra)} references; registration times a {ta[:3]}{'…' if len(ta) > 3 else ''} b {tb[:3]}{'…' if len(tb) > 3 else ''}"
        print(f"    nix db: paths only in a {sorted(set(va)-set(vb))[:5]}, only in b {sorted(set(vb)-set(va))[:5]}, changed {[k for k in va if k in vb and va[k]!=vb[k]][:5]}, refs equal {ra == rb}")
        return None
    return None

if sys.argv[1] == "--explain":       # helper mode, run under sudo: <mnt a> <mnt b> <rel>... -> {rel: reason|null}
    print(json.dumps({r: explain_file(r, os.path.join(sys.argv[2], r), os.path.join(sys.argv[3], r)) for r in sys.argv[4:]}))
    sys.exit(0)

if sys.argv[1] == "--tree":          # helper mode, run under sudo: print the tree of one mounted image as JSON
    print(json.dumps(tree(sys.argv[2])))
    sys.exit(0)

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

def open_tree(raw, off, size, key, tag):
    """Map the LUKS2 partition read-only with the template key and mount the Btrfs top level read-only."""
    loop = sh("sudo", "losetup", "--find", "--show", "--read-only", "-o", str(off), "--sizelimit", str(size), raw).strip()
    sh("sudo", "cryptsetup", "open", "--readonly", "--key-file", key, loop, f"repro-{tag}")
    mnt = f"/tmp/repro-mnt-{tag}"
    sh("sudo", "mkdir", "-p", mnt)
    sh("sudo", "mount", "-o", "ro,subvolid=5", f"/dev/mapper/repro-{tag}", mnt)
    return loop, mnt

def close_tree(loop, mnt, tag):
    import shutil
    subprocess.run(["sudo", "umount", mnt])
    subprocess.run(["sudo", shutil.which("cryptsetup") or "cryptsetup", "close", f"repro-{tag}"])
    subprocess.run(["sudo", "losetup", "-d", loop])

key = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "modules", "template-disk.key")
luks_parts = []
for pa in ta["partitions"]:
    with open(ra, "rb") as fh:
        fh.seek(pa["start"] * 512)
        if fh.read(6) == b"LUKS\xba\xbe":
            luks_parts.append(pa)
for pa in luks_parts:
    off, size = pa["start"] * 512, pa["size"] * 512
    opened = []
    try:
        for r, tag in ((ra, "a"), (rb, "b")):
            opened.append((*open_tree(r, off, size, key, tag), tag))
        # walk as root: the trees carry root-only files (machine/broker state dirs are empty in a template, /root, /etc/shadow)
        dump = []
        for loop, mnt, tag in opened:
            out = sh("sudo", sys.executable, os.path.abspath(__file__), "--tree", mnt)
            dump.append(json.loads(out))
        A, B = dump
        only_a, only_b = sorted(set(A) - set(B)), sorted(set(B) - set(A))
        changed = sorted(k for k in set(A) & set(B) if A[k] != B[k])
        def store(T):
            out = set()
            for k in T:
                parts = k.split("/")
                for i in range(1, len(parts) - 1):
                    if parts[i] == "store" and parts[i - 1] in ("nix", "@nix"):
                        out.add(parts[i + 1])
                        break
                else:
                    if parts[0] == "@nix" and len(parts) > 2 and parts[1] == "store":
                        out.add(parts[2])
            return sorted(out)
        sa, sb = store(A), store(B)
        perms = [k for k in changed if A[k][:4] != B[k][:4]]
        content = [k for k in changed if A[k][:4] == B[k][:4]]
        print(f"btrfs tree (LUKS opened with the template key): {len(A)} / {len(B)} entries; only in a {len(only_a)}, only in b {len(only_b)}; type/permission/owner differences {len(perms)}; content differences {len(content)}")
        print(f"nix closure in the image: {len(sa)} / {len(sb)} store paths, {'same set' if sa == sb else 'DIFFERENT sets'}")
        for name, lst in (("only in a", only_a), ("only in b", only_b), ("type/permission/owner", perms), ("content", content)):
            if lst:
                print(f"  {name}: {lst[:20]}")
        why = json.loads(sh("sudo", sys.executable, os.path.abspath(__file__), "--explain", opened[0][1], opened[1][1], *content)) if content else {}
        for k in content:
            print(f"  content {k}: {'explained: ' + why[k] if why.get(k) else 'UNEXPLAINED'}")
        content = [k for k in content if not why.get(k)]
        if only_a or only_b or perms or content or sa != sb:
            unexplained.append("btrfs tree")
    except subprocess.CalledProcessError as e:
        print("could not open the LUKS2 partition with the template key:", e, e.stderr)
        unexplained.append("btrfs tree not compared")
    finally:
        for loop, mnt, tag in opened:
            close_tree(loop, mnt, tag)

print("UNEXPLAINED:", unexplained if unexplained else "none — the only difference is the LUKS2 partition (random volume key, salts, UUID)")
sys.exit(1 if unexplained else 0)
