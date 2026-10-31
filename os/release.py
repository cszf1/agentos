"""Build the unsigned release manifest + SBOM from a closureInfo registration (no network, no clock: times derive
from the flake's lastModified). Usage: release.py registration toplevel rev lastModified nixpkgsRev flakeLockHash
version kernel initrd kernelVersion outdir"""
import hashlib, json, re, sys, uuid

reg, top, rev, lm, nixrev, lockh, ver, kernel, initrd, kver, out = sys.argv[1:12]
oci_index = sys.argv[12] if len(sys.argv) > 12 else None
ALPHA = "0123456789abcdfghijklmnpqrsvwxyz"

def nix32_to_hex(s):
    n = len(s) * 5 // 8
    out = bytearray(n)
    for i, c in enumerate(reversed(s)):
        d = ALPHA.index(c)
        b = i * 5
        j, o = b // 8, b % 8
        out[j] |= (d << o) & 0xFF
        if j + 1 < n and (d >> (8 - o)):
            out[j + 1] |= d >> (8 - o)
    return bytes(out).hex()

lines = open(reg).read().split("\n")
paths = []
i = 0
while i < len(lines) and lines[i].startswith("/nix/store/"):
    p, h, size, deriver, nref = lines[i], lines[i + 1], lines[i + 2], lines[i + 3], int(lines[i + 4])
    i += 5 + nref
    algo, _, val = h.partition(":")
    hx = val if len(val) == 64 else nix32_to_hex(val)
    paths.append({"path": p, "narHash": "sha256:" + hx, "narSize": int(size)})
hashes = sorted({p["narHash"] for p in paths})
# Approved OCI images shipped in the closure (spec §19.1): image IDs (config digests) of the offline archive.
oci_digests = sorted({i["imageId"] for i in json.load(open(oci_index))["images"]}) if oci_index else []
sha = lambda f: "sha256:" + hashlib.sha256(open(f, "rb").read()).hexdigest()
canon = lambda v: json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
# Firmware list (spec §19.1, V1-B04): every file the system firmware path offers, with the store package it comes
# from and its content hash. Packages are also closure components, so the list is pinned by the same NAR hashes.
import os
narh = {p["path"]: p["narHash"] for p in paths}
fw_files, fw_pkgs = [], {}
fw_root = os.path.join(top, "firmware")
if os.path.isdir(fw_root):
    for d, _, fs in os.walk(fw_root, followlinks=True):
        for f in fs:
            full = os.path.join(d, f)
            real = os.path.realpath(full)
            if not os.path.isfile(real):
                continue
            pkg = "/".join(real.split("/")[:4])
            fw_pkgs[pkg] = narh.get(pkg, "not-in-closure")
            fw_files.append({"path": os.path.relpath(full, fw_root), "package": pkg,
                             "sha256": hashlib.sha256(open(real, "rb").read()).hexdigest()})
firmware = {"formatVersion": 1, "kind": "agentos-firmware-list", "root": fw_root,
            "packages": [{"storePath": k, "narHash": v} for k, v in sorted(fw_pkgs.items())],
            "files": sorted(fw_files, key=lambda x: x["path"])}
if any(v == "not-in-closure" for v in fw_pkgs.values()):
    sys.exit("firmware file outside the release closure")
# review R2-1: the offline OCI archive's bytes and image IDs are pinned through the signed sbomHash
def sha_stream(f):
    h = hashlib.sha256()
    with open(f, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return "sha256:" + h.hexdigest()
oci_archive = None
if oci_index:
    idx = json.load(open(oci_index))
    arch = os.path.join(os.path.dirname(oci_index), idx.get("archive", "images.tar"))
    oci_archive = {"file": idx.get("archive", "images.tar"), "sha256": sha_stream(arch), "indexSha256": sha(oci_index), "imageIds": oci_digests}
sbom = {"formatVersion": 1, "kind": "agentos-closure-sbom", "root": top, "firmware": firmware, "ociArchive": oci_archive, "components": [
    {"storePath": p["path"], "name": re.sub(r"^/nix/store/[a-z0-9]{32}-", "", p["path"]), "narHash": p["narHash"], "narSize": p["narSize"]} for p in sorted(paths, key=lambda x: x["path"])]}
sbom_s = canon(sbom)
open(f"{out}/sbom.json", "w").write(sbom_s)
# review R2-5: releaseSequence is allocated, never typed into JSON. Default: the source commit time in seconds (the
# flake's lastModified), which only grows along the release branch; the signing environment may pass an explicit
# AGENTOS_RELEASE_SEQUENCE. With AGENTOS_PREVIOUS_MANIFEST (the last published release) the build fails unless the new
# sequence is strictly greater, so a release can never repeat or step back.
seq = int(os.environ.get("AGENTOS_RELEASE_SEQUENCE") or lm)
if not 1 <= seq <= 9_007_199_254_740_991:
    sys.exit(f"bad releaseSequence {seq}")
prev_path = os.environ.get("AGENTOS_PREVIOUS_MANIFEST")
if prev_path:
    prev = json.load(open(prev_path))
    if seq <= int(prev["releaseSequence"]):
        sys.exit(f"releaseSequence {seq} is not above the previous release's {prev['releaseSequence']}")
lm = int(lm) * 1000
clean = bool(re.fullmatch(r"[0-9a-f]{40}", rev))
manifest = {
    "formatVersion": 1,
    "releaseId": str(uuid.UUID(hashlib.sha256((f"agentos.release.id\n{top}\n{seq}").encode()).hexdigest()[:32], version=4)),
    "releaseSequence": seq, "version": ver, "channel": "stable" if clean else "dev",
    "publishedAt": lm, "expiresAt": lm + 365 * 86400 * 1000, "supportUntil": lm + 365 * 86400 * 1000,
    "sourceCommit": rev if clean else "0" * 40, "flakeLockHash": lockh, "nixpkgsRevision": nixrev, "platform": "x86_64-linux",
    "hardwareProfiles": ["qemu-virtio"], "baseClosurePath": top, "baseClosureHash": "sha256:" + hashlib.sha256("\n".join(hashes).encode()).hexdigest(),
    "closureContentHashes": hashes, "kernelVersion": kver[:64], "initrdHash": sha(initrd), "ociDigests": oci_digests,
    "sbomHash": "sha256:" + hashlib.sha256(sbom_s.encode()).hexdigest(),
    "compatibility": {"workspaceSchema": [5, 5], "machineSchema": [1, 2], "brokerSchema": [4, 4], "brokerProtocol": [3, 3], "nativeRpc": [1, 1]},
    "migrationClass": "none", "healthProfile": "v1-default", "minRecoveryVersion": "1.0.0", "keyId": "unsigned",
}
open(f"{out}/manifest.json", "w").write(canon(manifest))
fw_s = canon(firmware)
open(f"{out}/firmware.json", "w").write(fw_s)
open(f"{out}/SHA256SUMS", "w").write(f"{hashlib.sha256(fw_s.encode()).hexdigest()}  firmware.json\n{hashlib.sha256(canon(manifest).encode()).hexdigest()}  manifest.json\n{hashlib.sha256(sbom_s.encode()).hexdigest()}  sbom.json\n")
print(f"firmware list: {len(fw_pkgs)} packages, {len(fw_files)} files")
open(f"{out}/UNSIGNED", "w").write("This manifest is not signed. Signing is done in the release environment (spec §20.1).\n")
