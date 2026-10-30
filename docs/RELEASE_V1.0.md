# AgentOS v1.0 — release materials (spec §32 V1-O10)

**Status: not a completed release.** V1-O10 requires all 100 acceptance items with evidence and no open blocking
issue. docs/ACCEPTANCE_V1.0.md lists the items that are still partial or not passed (including every item that needs a
physical machine). This file is the material that must ship with a release; it is kept current so that the release
can be cut once the remaining evidence exists. Nothing here claims an untested piece of hardware works.

## What a release consists of

| Artifact | Built by | Notes |
|---|---|---|
| ReleaseManifest (`manifest.json`), SBOM (`sbom.json`), `SHA256SUMS` | `nix build .#agentos-release` | unsigned in this tree; signed only in the release environment (§20.1). `releaseSequence` monotonic, `expiresAt`/`supportUntil` = publish time + 365 days, `hardwareProfiles = ["qemu-virtio"]`. |
| Installer ISO | `nix build .#agentos-iso` | carries the whole release closure and the OCI archive: offline install. |
| VM template | `nix build .#agentos-qcow2` | same toplevel, same installer, public template LUKS key replaced on first boot (`agentos-disk-rekey`). |
| Approved OCI images | `nix build .#agentos-oci` | built offline from fixed inputs; image IDs must equal the manifest's `ociDigests`. |

Verification on the target: `agentosctl update verify` (signature against a trusted key, every field, sequence,
expiry, closure NAR hashes, OCI image IDs, files present); Nix `require-sigs = true`.

## Supported hardware

| Profile | State |
|---|---|
| `qemu-virtio` (x86_64 UEFI, virtio-blk, virtio-gpu, QEMU/KVM) | tested in KVM VM checks (os/tests, docs/V1.0_VM_TESTS.md) |
| Intel/AMD GPU on bare metal, real displays, Wi-Fi, audio/backlight, suspend, physical disks, serial devices | **not tested — not supported in this tree** (V1-H01…H08, D10, U01/U02 on real disks, V3-E04) |

Minimum disk for an install: 64 GiB (the installer refuses smaller disks and system disks).

## Support period and limits

- Support period: the signed manifest's `supportUntil`; this tree has published no signed release, so no support
  period is promised yet.
- Known limits (details in docs/ACCEPTANCE_V1.0.md and docs/V1.0_PROGRESS.md):
  - clones of one qcow2 template share the LUKS volume key until an administrator runs `cryptsetup reencrypt`
    (recorded in `/var/lib/agentos-machine/disk-origin`);
  - reference-machine timings (O04/O05) are not measured;
  - performance and hardware claims are limited to the `qemu-virtio` profile.

## Recovery materials

| Situation | Tool |
|---|---|
| machine-wide cold backup / abandon a dead backup | `agentosctl backup --out DIR [--pinned] [--include-archived]`, `agentosctl backup abandon` |
| off-machine copy | `agentosctl backup export --set DIR --recipient age1… --out DEST` (read back and verified before `verified`) |
| same-machine restore (resumable) | `agentosctl restore --set DIR` / `--restore-id ID` |
| move workspaces to another machine | `agentosctl clone --set DIR --owner LOGIN` (sets from the same machine are refused: use restore) |
| machine directory lost | machined enters recovery mode; `agentosctl recover --new-identity` keeps the old state as evidence |
| failed update | one-shot trial boot; the persistent default stays on known-good until the health gate passes (`agentos-update-worker commit --health-gate`) |
| support bundle (root only, no passwords) | `agentosctl support-bundle` |
| reinstall | the installer ISO (offline); data comes back from an exported set with `restore`/`clone` |
