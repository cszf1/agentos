# AgentOS v1.0 — release materials (spec §32 V1-O10)

**Status: not a completed release.** V1-O10 requires all 100 acceptance items with evidence and no open blocking
issue. docs/ACCEPTANCE_V1.0.md lists the items that are still partial or not passed (including every item that needs a
physical machine). This file is the material that must ship with a release; it is kept current so that the release
can be cut once the remaining evidence exists. Nothing here claims an untested piece of hardware works.

## What a release consists of

| Artifact | Built by | Notes |
|---|---|---|
| ReleaseManifest (`manifest.json`), SBOM (`sbom.json`, with the firmware list), firmware list (`firmware.json`: every file of the system firmware path, its store package and sha256), `SHA256SUMS` | `nix build .#agentos-release` | unsigned in this tree; signed only in the release environment (§20.1). `releaseSequence` monotonic, `expiresAt`/`supportUntil` = publish time + 365 days, `hardwareProfiles = ["qemu-virtio"]`. |
| Installer ISO | `nix build .#agentos-iso` | carries the whole release closure and the OCI archive: offline install. |
| VM template | `nix build .#agentos-qcow2` | same toplevel, same installer and layout (GPT, ESP, LUKS2, Btrfs). GPT/partition UUIDs and the ESP are byte-identical across builds; the LUKS2 volume key, salts and UUID are fresh per build. The template's LUKS2 partition is 16 GiB. On first boot `agentos-disk-rekey` asks for the operator's passphrase, destroys every other key slot (the public template key included), re-encrypts the partition online with a fresh volume key (resumable after a power cut) and grows it to the whole disk, all before machined starts: clones never share a volume key. |
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
  - reference-machine timings (O04/O05) are not measured;
  - performance and hardware claims are limited to the `qemu-virtio` profile.

## Administration (no root shell)

An installed AgentOS has a **locked root account and no sudo** (V1-I09, spec §7.2). Machine-level administration is
done by a **machine administrator** (the account created at first boot, or one created with
`machine.users.create role=admin`) from **their own local login session** — a text console on the machine (Ctrl+Alt+F2, log in) — with `agentosctl admin <command>`:

1. the command becomes one fixed machine action (`admin.backup`, `admin.backup.export`, `admin.restore`,
   `admin.importSet`, `admin.clone`, `admin.importV04`, `admin.update`, or `power.reboot`) planned through the session
   gateway; the plan shows the exact root helper command and expires after 10 minutes;
2. `agentosctl admin` asks for **the administrator's own password** (`--password-stdin` for scripts); the gateway
   checks it with PAM (`agentos-admin-auth`), machined issues a one-time ticket valid 60 s bound to the planHash, and
   consumes it together with the operation intent and receipt in one transaction (spec §12.2);
3. only then machined starts the fixed root helper (the `agentosctl` subcommand below, argv built from validated
   parameters) as a transient unit, and the command prints the outcome read back from the helper's exit code
   (`succeeded`, `failed_no_effect` for a refusal before any change, or `indeterminate`). Every step is audited.

Paths an administrator may point the helper at: their own home, `/media`, `/mnt` (and `/nix/store` for release
files). Machine sets (plaintext workspace data) live only under the root-only `/var/lib/agentos-snapshots/<set>` and
are named, never given as a path; an exported copy is age-encrypted to the recipient the administrator names.
A non-administrator, a wrong password or a stale/expired plan is refused before anything runs.

## Recovery materials

| Situation | As the machine administrator (`agentosctl admin …`, no root) |
|---|---|
| machine-wide cold backup / abandon a dead backup | `agentosctl admin backup --name SET [--pinned] [--include-archived]`, `agentosctl admin backup abandon` |
| off-machine copy | `agentosctl admin backup export --set SET --recipient age1… --out ~/carry` (read back and verified before `verified`; the files are handed to you) |
| same-machine restore (resumable) | `agentosctl admin restore --set SET [--restore-id ID]` |
| move workspaces to another machine | on the new machine: `agentosctl admin import-set --in ~/carry --identity ~/carry/KEY --name SET`, then `agentosctl admin clone --set SET --owner LOGIN` (sets from the same machine are refused: use restore) |
| bring a v0.4 workspace over | copy the v0.4 cold backup into your home, then `agentosctl admin import-v04 --backup ~/DIR --owner LOGIN [--name NAME]` (a v0.4 cold backup becomes a new workspace; every file hash checked before anything is allocated; the import runs as the new execution UID; the backup is never modified; a store already on the machine is refused) |
| update | `agentosctl admin update trust-key --key-id ID --public-key HEX` (once per release key), `agentosctl admin update adopt-base --manifest M --signature S` (once, on a machine installed from an unsigned tree: the running system becomes the known-good release with its own boot entry), `agentosctl admin update verify --manifest M --signature S --open` (prints the updateId), `agentosctl admin update fetch --update-id ID --from https://… --closure /nix/store/…`, `agentosctl admin update activate --update-id ID`, then `agentosctl admin reboot` |
| failed update | the reboot runs the candidate **once** (one-shot); the persistent default stays on known-good. On the trial boot `agentosctl admin update commit --update-id ID` passes only if the health gate passes; otherwise (or if the trial boot does not come up) the next reboot returns to known-good and the update is `rolled_back` (`agentosctl admin status`) |
| machine directory lost | machined enters recovery mode (no socket, so no gateway action is possible): boot the installer ISO (the recovery medium; spec: "机器全量恢复必须从恢复 target/介质执行"), unlock the disk and run `agentosctl recover --new-identity` against it; the old state is kept as evidence |
| support bundle (no passwords) | `agentosctl support-bundle` (root on the recovery medium; administrators use `diagnostics.collect` in the Shell) |
| reinstall | the installer ISO (offline); data comes back from an exported set with `import-set` + `clone` |

Root-only forms of the same subcommands (`agentosctl backup|restore|clone|import-v04|import-set|update …`) are the
helpers the actions above run; they are used directly only from the recovery medium.
