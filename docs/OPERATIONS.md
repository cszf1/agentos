# AgentOS — existing system build and operations

This document explains the Linux/NixOS implementation that remains in the repository: build outputs, administration,
updates and recovery. It is not the current development roadmap or a complete-OS delivery checklist. The project is
simplifying redundant code within the existing Linux architecture while retaining all functionality; see
[README](../README.md). This does not introduce cross-platform adapters. No signed public release exists,
and no untested hardware or hypervisor is claimed supported.

## Build outputs

| Artifact | Built by | Notes |
|---|---|---|
| ReleaseManifest (`manifest.json`), SBOM (`sbom.json`, with the firmware list), firmware list (`firmware.json`: every file of the system firmware path, its store package and sha256), `SHA256SUMS` | `nix build .#agentos-release` | unsigned in this tree; signed only in the release environment (§20.1). `releaseSequence` monotonic, `expiresAt`/`supportUntil` = publish time + 365 days, `hardwareProfiles = ["qemu-virtio"]`. |
| Installer ISO | `nix build .#agentos-iso` | carries the whole release closure and the OCI archive: offline install. Carries the same disk, input and GPU drivers as the installed system (`os/hardware/vm-drivers.nix`). Boots in UEFI mode on every hypervisor below. |
| VM template | `nix build .#agentos-qcow2` | same toplevel, same installer and layout (GPT, ESP, LUKS2, Btrfs). GPT/partition UUIDs and the ESP are byte-identical across builds; the LUKS2 volume key, salts and UUID are fresh per build. The template's LUKS2 partition is 16 GiB. On first boot `agentos-disk-rekey` asks for the operator's passphrase, destroys every other key slot (the public template key included), re-encrypts the partition online with a fresh volume key (resumable after a power cut) and grows it to the whole disk, all before machined starts: clones never share a volume key. |
| VirtualBox disk | `nix build .#agentos-vdi` | `agentos.vdi` (dynamic) and `SHA256SUMS`: the `agentos-qcow2` template converted with `qemu-img`, same content, so first boot runs `agentos-disk-rekey` exactly as for the qcow2. Nominal size 64 GiB; the file holds only written blocks. |
| VMware disk | `nix build .#agentos-vmdk` | `agentos.vmdk` (streamOptimized) and `SHA256SUMS`, converted the same way. |
| Hyper-V disk | `nix build .#agentos-vhdx` | `agentos.vhdx` (dynamic) and `SHA256SUMS`, converted the same way. |
| Checked image set | `nix build .#agentos-vm-images` | the three images, one `SHA256SUMS` and `report.txt`. Builds only if each image has its format and the qcow2's nominal size (at least 64 GiB), passes `qemu-img check` and converts back to a raw disk byte-identical to the qcow2's. CI: `build-vm-images`. |
| Approved OCI images | `nix build .#agentos-oci` | built offline from fixed inputs; image IDs must equal the manifest's `ociDigests`. |

Verification on the target: `agentosctl update verify` (signature against a trusted key, every field, sequence,
expiry, closure NAR hashes, OCI image IDs, files present); Nix `require-sigs = true`.

## Supported hardware

| Profile | State |
|---|---|
| `qemu-virtio` (x86_64 UEFI, virtio-blk, virtio-gpu, QEMU/KVM) | verified in the existing KVM checks in `os/tests` |
| VirtualBox 7 (UEFI, AHCI, VMSVGA) | drivers, guest tools and the `.vdi` image added; **not boot-verified in CI, needs manual verification** |
| VMware Workstation, Player, ESXi (UEFI, NVMe/SATA/PVSCSI, SVGA) | drivers, guest tools and the `.vmdk` image added; **not boot-verified in CI, needs manual verification** |
| Hyper-V Generation 2 (UEFI, storvsc, hyperv_drm) | drivers, guest tools and the `.vhdx` image added; **not boot-verified in CI, needs manual verification** |
| Intel/AMD GPU on bare metal, real displays, Wi-Fi, audio/backlight, suspend, physical disks, serial devices | **not tested — not supported in this tree** (V1-H01…H08, D10, U01/U02 on real disks, V3-E04) |

Minimum disk for an install: 64 GiB (the installer refuses smaller disks and system disks).

### Virtual machine settings

One system (`os/hardware/vm.nix`) serves every hypervisor. It boots only through UEFI (systemd-boot; no BIOS, no GRUB
on the installed disk) and always renders in software (`agentos.softwareRendering`): leave 3D acceleration off.
Software rendering covers the login screen as well as the session: the greeter (Cage and ReGreet) and the desktop
(Sway and the Shell) get the same settings (`WLR_RENDERER=pixman`, `WLR_NO_HARDWARE_CURSORS=1`, `GSK_RENDERER=cairo`,
`QT_QUICK_BACKEND=software`; `softwareRenderingEnv` in `os/modules/agentos.nix`), so neither needs OpenGL from the
virtual GPU.
Neither the ISO nor the images are signed, so Secure Boot must be off. The ISO also boots through BIOS, but only as
far as its menu: the installed system is UEFI-only, so enable EFI in the VM's settings before you install. (The
ISO keeps its isolinux menu because the `m19-iso` check reads its boot entries from `isolinux.cfg`.)

Size, from the existing QEMU checks in `os/tests`: 2 vCPUs in every check; memory 3072 MiB for the ISO install through
to the desktop (`m19-iso`), 4096 MiB for `m5-desktop` and 6144 MiB for `m20-sway`. Give at least 2 vCPUs and
3072 MiB; 6144 MiB matches the largest desktop check. Disk: at least 64 GiB.

| Hypervisor | Firmware | Disk controller | Display | Network |
|---|---|---|---|---|
| QEMU/KVM | OVMF (UEFI) | virtio-blk | virtio-gpu | virtio-net |
| VirtualBox 7 | System, tick **Enable EFI** | SATA (AHCI) | Graphics Controller **VMSVGA**, 3D off | Intel PRO/1000 or virtio-net |
| VMware | Firmware type **UEFI**, Secure Boot off | NVMe or SATA (see below) | 3D graphics off | vmxnet3 or e1000e |
| Hyper-V | **Generation 2**, Security: untick **Enable Secure Boot** | SCSI (the only Gen2 controller) | default (hyperv_drm) | network adapter (netvsc) |

The installer names its target by `/dev/disk/by-id/…`. VirtualBox SATA, VMware NVMe or SATA and Hyper-V SCSI disks
have such a name; a VMware SCSI (LSI or PVSCSI) disk has one only with `disk.EnableUUID = "TRUE"` in the `.vmx`.

VMware without 3D: with "Accelerate 3D graphics" off (or `mks.enable3d = "FALSE"` in the `.vmx`) the SVGA device
has no 3D, and the vmwgfx driver still gives a framebuffer and modesetting; AgentOS renders everything on the CPU,
so this is the expected setting, not a degraded one. The virtual GPU drivers (vmwgfx, virtio_gpu, vboxvideo,
hyperv_drm) are loaded by udev in the initrd only when their device is present, so a driver for another hypervisor
never fails "Load Kernel Modules". If the login screen still does not come up, greetd retries a few times and then
tty1 shows the last greeter log lines with "Press Enter to start the login screen again"; a text login is on
Ctrl+Alt+F2. For a report, collect `journalctl -b -u greetd`, `journalctl -b -t agentos-greeter -t
agentos-greeter-fallback` and `journalctl -b -u systemd-modules-load`. These paths are checked under QEMU's emulated VMware SVGA
(`-vga vmware`) only; a real VMware host still needs manual verification.

Guest tools start only on their own hypervisor (systemd `ConditionVirtualization=` or the hypervisor's own device):
VBoxService and VBoxDRMClient on VirtualBox, vmtoolsd (headless build) on VMware, the Hyper-V KVP and VSS daemons on
Hyper-V. Each gives time sync, a clean shutdown from the host and, on VirtualBox and VMware, a screen size that follows
the window. X11-only parts (VBoxClient clipboard, seamless and drag and drop; vmware-user) and host-to-guest command or
file channels (VirtualBox guest control, VMware guest operations and customization, Hyper-V file copy) are off.

### Importing a disk image

Each image is the qcow2 template, an installed system: the first boot asks for **one password** (twice), replaces the
public template key with it, re-encrypts and grows the disk to its full size, and then creates the administrator
`admin` with that same password and the default workspace, with no further question (quick start,
[VM_QUICKSTART.md](VM_QUICKSTART.md)). The ISO installs the same way by itself: at boot it installs to the one
empty disk of at least 64 GiB after a 10 s countdown on its screen that any key cancels (`agentos-install auto`;
`--quick` layout: small LUKS behind the template key, grown and re-keyed at first boot), restarts, and the first boot
asks the one password. No disk, several disks, a disk with data or AgentOS already on it: it explains on screen and
writes nothing; `agentos.autoinstall=0` turns it off. The manual `plan`/`confirm`/`run` without `--quick` keeps the
full console setup (disk passphrase at install, administrator and workspace asked at first boot; `m19-iso`). For QEMU on Windows with WHPX,
`deploy/windows/Start-AgentOS.ps1` starts the qcow2 with the settings above. Check the file against
`SHA256SUMS` first. Grow the virtual disk before the first boot if it should be larger than 64 GiB.

- VirtualBox: create a VM (Linux, Other Linux 64-bit) with the settings above, then attach `agentos.vdi` to the SATA
  controller (copy it first; every copy of one file has the same VirtualBox medium UUID, so use
  `VBoxManage clonemedium` for a second VM).
- VMware: streamOptimized is an import format. ESXi: upload it and run
  `vmkfstools -i agentos.vmdk -d thin agentos-esxi.vmdk`, then attach the result. Workstation or Player:
  `vmware-vdiskmanager -r agentos.vmdk -t 0 agentos-ws.vmdk`, then attach the result as an existing disk. Use the
  settings above.
- Hyper-V: New Virtual Machine, Generation 2, "Use an existing virtual hard disk": `agentos.vhdx`; then in Settings,
  Security, untick Enable Secure Boot.

## Support period and limits

- Support period: the signed manifest's `supportUntil`; this tree has published no signed release, so no support
  period is promised yet.
- Known limits of the existing system layer:
  - reference-machine startup, interaction and sustained-background timings are not established;
  - performance and hardware claims are limited to the `qemu-virtio` profile;
  - the native frontend/machine-permission real-model flow and all slow-reader/cross-client event bounds are not fully verified.
  These are limitations, not a commitment to continue the retired full-OS acceptance programme.

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

### Removable recovery media and offline verification

From an active local login, use `udisksctl mount --block-device /dev/disk/by-label/LABEL --no-user-interaction`
to mount removable media. Keep the normal polkit policy: this does not grant access to system disks or inactive
sessions. Mounts normally appear under `/run/media/LOGIN/LABEL`; copy inputs to your own home before calling
`agentosctl admin`, and copy an already verified encrypted export back to the medium afterwards. The privileged
helper's path allowlist is unchanged; do not point it at arbitrary `/run` paths.

Verification refuses a new manifest without trusted time (spec §20.2). Check/fix the clock against a trusted source
first. For an explicitly chosen offline verification, the administrator can then pass `--trusted-time` to
`update adopt-base` / `update verify`; this is an authenticated assertion, not a default or an expiry bypass.
The isolated automated ISO drill checks the guest RTC against the test host immediately before making that
assertion. Manifest expiry, support limit, signature, content and sequence checks still apply.

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
