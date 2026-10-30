# Installed-disk layout (spec §19.2): GPT with a 2 GiB ESP (PARTLABEL agentos-esp, FAT label AGENTOS-ESP) and a
# LUKS2 container (PARTLABEL agentos-luks) holding one Btrfs filesystem (label agentos-root) with fixed subvolumes.
# Everything is addressed by label, so the base release closure is the same on every machine; the installer only
# writes /etc/agentos/install.json (hashed as hardwareConfigHash) and never a per-machine Nix fragment.
{ lib, ... }:
let
  sub = name: extra: { device = "/dev/mapper/agentos-root"; fsType = "btrfs"; options = [ "subvol=${name}" "noatime" "compress=zstd:1" ] ++ extra; };
in {
  boot.initrd.luks.devices."agentos-root" = { device = "/dev/disk/by-partlabel/agentos-luks"; allowDiscards = true; };
  boot.initrd.supportedFilesystems = [ "btrfs" ];
  fileSystems = {
    "/" = sub "@root" [ ];
    "/nix" = sub "@nix" [ ];
    "/home" = sub "@home" [ "nosuid" "nodev" ];
    "/var/lib/agentos-machine" = sub "@machine" [ "nosuid" "nodev" "noexec" ];
    "/var/lib/agentos-broker" = sub "@broker" [ "nosuid" "nodev" "noexec" ];
    "/var/lib/agentos-snapshots" = sub "@snapshots" [ "nosuid" "nodev" "noexec" ];
    "/boot" = { device = "/dev/disk/by-partlabel/agentos-esp"; fsType = "vfat"; options = [ "umask=0077" ]; };
  };
  # Workspace data (@ws_<id>) and runtime (@runtime_<id>) subvolumes are created by machined at workspace creation.
  swapDevices = lib.mkForce [ ];
  zramSwap.enable = true;
}
