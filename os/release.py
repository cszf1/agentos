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
sbom = {"formatVersion": 1, "kind": "agentos-closure-sbom", "root": top, "components": [
    {"storePath": p["path"], "name": re.sub(r"^/nix/store/[a-z0-9]{32}-", "", p["path"]), "narHash": p["narHash"], "narSize": p["narSize"]} for p in sorted(paths, key=lambda x: x["path"])]}
sbom_s = canon(sbom)
open(f"{out}/sbom.json", "w").write(sbom_s)
lm = int(lm) * 1000
clean = bool(re.fullmatch(r"[0-9a-f]{40}", rev))
manifest = {
    "formatVersion": 1,
    "releaseId": str(uuid.UUID(hashlib.sha256(("agentos.release.id\n" + top).encode()).hexdigest()[:32], version=4)),
    "releaseSequence": 1, "version": ver, "channel": "stable" if clean else "dev",
    "publishedAt": lm, "expiresAt": lm + 365 * 86400 * 1000, "supportUntil": lm + 365 * 86400 * 1000,
    "sourceCommit": rev if clean else "0" * 40, "flakeLockHash": lockh, "nixpkgsRevision": nixrev, "platform": "x86_64-linux",
    "hardwareProfiles": ["qemu-virtio"], "baseClosurePath": top, "baseClosureHash": "sha256:" + hashlib.sha256("\n".join(hashes).encode()).hexdigest(),
    "closureContentHashes": hashes, "kernelVersion": kver[:64], "initrdHash": sha(initrd), "ociDigests": oci_digests,
    "sbomHash": "sha256:" + hashlib.sha256(sbom_s.encode()).hexdigest(),
    "compatibility": {"workspaceSchema": [5, 5], "machineSchema": [1, 1], "brokerSchema": [4, 4], "brokerProtocol": [3, 3], "nativeRpc": [1, 1]},
    "migrationClass": "none", "healthProfile": "v1-default", "minRecoveryVersion": "1.0.0", "keyId": "unsigned",
}
open(f"{out}/manifest.json", "w").write(canon(manifest))
open(f"{out}/SHA256SUMS", "w").write(f"{hashlib.sha256(canon(manifest).encode()).hexdigest()}  manifest.json\n{hashlib.sha256(sbom_s.encode()).hexdigest()}  sbom.json\n")
open(f"{out}/UNSIGNED", "w").write("This manifest is not signed. Signing is done in the release environment (spec §20.1).\n")
