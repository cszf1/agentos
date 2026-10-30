# Installed-disk layout (spec §19.2): GPT with a 2 GiB ESP (PARTLABEL agentos-esp, FAT label AGENTOS-ESP) and a
# LUKS2 container (PARTLABEL agentos-luks) holding one Btrfs filesystem (label agentos-root) with fixed subvolumes.
# Everything is addressed by label, so the base release closure is the same on every machine; the installer only
# writes /etc/agentos/install.json (hashed as hardwareConfigHash) and never a per-machine Nix fragment.
{ lib, pkgs, ... }:
let
  # Public, well-known key of the qcow2 TEMPLATE disk only (spec §19.1 "空白 qcow2"). It protects nothing: a template
  # carries no identity, account or data. First boot refuses to start machined until the operator has replaced it
  # with their own passphrase. On an installed disk the key never matches and systemd-cryptsetup falls back to the passphrase prompt.
  templateKey = ./template-disk.key;
  sub = name: extra: { device = "/dev/mapper/agentos-root"; fsType = "btrfs"; options = [ "subvol=${name}" "noatime" "compress=zstd:1" ] ++ extra; };
in {
  boot.initrd.systemd.enable = true;   # scripted stage 1 is deprecated in 26.05; the installed and qcow2 disks use this one
  boot.initrd.luks.devices."agentos-root" = { device = "/dev/disk/by-partlabel/agentos-luks"; allowDiscards = true; keyFile = "/etc/agentos-template-disk.key"; };
  boot.initrd.systemd.contents."/etc/agentos-template-disk.key".source = templateKey;
  environment.etc."agentos/template-disk.key".source = templateKey;

  # Template disk guard: before machined or the greeter start, a disk that still opens with the public template key
  # gets the operator's passphrase (asked on the console, twice) and the template slot is removed. Installed disks
  # skip this (the key does not open them).
  systemd.services.agentos-disk-rekey = {
    description = "AgentOS: replace the qcow2 template disk key";
    wantedBy = [ "multi-user.target" ];
    requiredBy = [ "agentos-machine.service" ];
    before = [ "agentos-machine.service" "display-manager.service" "systemd-user-sessions.service" ];
    after = [ "local-fs.target" ];
    unitConfig.DefaultDependencies = false;
    path = [ pkgs.cryptsetup pkgs.systemd pkgs.coreutils ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; StandardOutput = "journal+console"; UMask = "0077"; TimeoutStartSec = "infinity"; };
    script = ''
      dev=/dev/disk/by-partlabel/agentos-luks
      key=/etc/agentos/template-disk.key
      [ -e "$dev" ] || exit 0
      cryptsetup open --test-passphrase --key-file="$key" "$dev" 2>/dev/null || exit 0
      echo "agentos: template disk detected; a new disk passphrase is required"
      new=""
      for i in 1 2 3 4 5; do
        a=$(systemd-ask-password --timeout=0 --no-tty "New AgentOS disk passphrase (at least 8 characters):") || continue
        b=$(systemd-ask-password --timeout=0 --no-tty "Repeat the disk passphrase:") || continue
        if [ "$a" = "$b" ] && [ ''${#a} -ge 8 ]; then new=$a; break; fi
        echo "agentos: passphrases differ or are shorter than 8 characters"
      done
      [ -n "$new" ] || { echo "agentos: no disk passphrase set; machined stays stopped"; exit 1; }
      f=$(mktemp -p /run agentos-newkey.XXXXXX)
      trap 'shred -u "$f" 2>/dev/null || rm -f "$f"' EXIT
      printf '%s' "$new" > "$f"
      new=""; a=""; b=""
      cryptsetup luksAddKey --batch-mode --key-file="$key" "$dev" "$f"
      cryptsetup luksRemoveKey --batch-mode "$dev" "$key"
      if cryptsetup open --test-passphrase --key-file="$key" "$dev" 2>/dev/null; then echo "agentos: template key still opens the disk"; exit 1; fi
      # Clones of one template still share the LUKS volume key (only the passphrase slot changed). Re-generating it
      # means rewriting the whole partition (cryptsetup reencrypt), which is left to the operator; recorded here.
      mkdir -p /var/lib/agentos-machine && printf '%s\n' "template-volume-key-shared" > /var/lib/agentos-machine/disk-origin
      echo "agentos: disk passphrase set (template key removed; volume key shared with other clones of this template)"
    '';
  };
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
