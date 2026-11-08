# Installed-disk layout (spec §19.2): GPT with a 2 GiB ESP (PARTLABEL agentos-esp, FAT label AGENTOS-ESP) and a
# LUKS2 container (PARTLABEL agentos-luks) holding one Btrfs filesystem (label agentos-root) with fixed subvolumes.
# Everything is addressed by label, so the base release closure is the same on every machine; the installer only
# writes /etc/agentos/install.json (hashed as hardwareConfigHash) and never a per-machine Nix fragment.
{ config, lib, pkgs, utils, ... }:
let
  # Public, well-known key of the qcow2 TEMPLATE disk only (spec §19.1 "空白 qcow2"). It protects nothing: a template
  # carries no identity, account or data. First boot refuses to start machined until the operator has replaced it
  # with their own passphrase. The initrd keeps a verified unlock password only in /run for unfinished setup.
  templateKey = ./template-disk.key;
  rootCryptUnit = "systemd-cryptsetup@${utils.escapeSystemdPath "agentos-root"}.service";
  rootDeviceUnit = "${utils.escapeSystemdPath "/dev/disk/by-partlabel/agentos-luks"}.device";
  sub = name: extra: { device = "/dev/mapper/agentos-root"; fsType = "btrfs"; options = [ "subvol=${name}" "noatime" "compress=zstd:1" ] ++ extra; };
in {
  boot.initrd.systemd.enable = true;   # scripted stage 1 is deprecated in 26.05; the installed and qcow2 disks use this one
  boot.initrd.luks.devices."agentos-root" = { device = "/dev/disk/by-partlabel/agentos-luks"; allowDiscards = true; keyFile = "/run/agentos-disk-unlock/key"; crypttabExtraOpts = [ "headless=yes" ]; };
  boot.initrd.systemd.contents."/etc/agentos-template-disk.key".source = templateKey;
  boot.initrd.systemd.contents."/etc/agentos-first-setup-handoff" = lib.mkIf config.agentos.graphical { source = pkgs.emptyFile; };
  boot.initrd.systemd.services.agentos-disk-unlock = {
    requiredBy = [ rootCryptUnit ];
    before = [ rootCryptUnit ];
    requires = [ rootDeviceUnit ];
    after = [ rootDeviceUnit ];
    unitConfig.DefaultDependencies = false;
    path = [ pkgs.cryptsetup pkgs.systemd pkgs.coreutils pkgs.util-linux ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; UMask = "0077"; LimitCORE = 0; TimeoutStartSec = "infinity"; };
    script = builtins.readFile ./disk-unlock.sh;
  };
  environment.etc."agentos/template-disk.key".source = templateKey;

  # Template disk guard (review F01): before machined or the greeter start, a disk that still opens with the public
  # template key gets the operator's passphrase (asked on the console, twice), every other key slot is destroyed and
  # the LUKS2 volume key is replaced by online re-encryption, so two clones of one template never share a volume
  # key; then the partition grows to the disk. Installed disks skip this (the key does not open them).
  systemd.services.agentos-disk-rekey = {
    description = "AgentOS: replace the qcow2 template disk key";
    wantedBy = [ "multi-user.target" ];
    requiredBy = [ "agentos-machine.service" ];
    before = [ "agentos-machine.service" "display-manager.service" "systemd-user-sessions.service" ];
    after = [ "local-fs.target" ];
    unitConfig.DefaultDependencies = false;
    path = [ pkgs.cryptsetup pkgs.systemd pkgs.coreutils pkgs.util-linux pkgs.gnused pkgs.gnugrep pkgs.btrfs-progs ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; StandardOutput = "journal+console"; UMask = "0077"; TimeoutStartSec = "infinity"; LimitCORE = 0; };
    script = ''
      [ "$(findmnt -n -o FSTYPE --target /run)" = tmpfs ] || { echo "agentos: refusing password custody outside tmpfs"; exit 1; }
        valid_account_password() {
          [ -n "$1" ] && [ "$(printf '%s' "$1" | wc -c)" -le 511 ] || return 1
          case "$1" in *$'\n'*) return 1 ;; esac
        }
      unlock=/run/agentos-disk-unlock/key
      f=""
      trap 'rm -f "$unlock"; if [ -n "$f" ]; then shred -u "$f" 2>/dev/null || rm -f "$f"; fi' EXIT
      if [ ! -e /etc/agentos/first-setup-handoff ] || [ -e /var/lib/agentos-machine/first-boot-closed ]; then
        rm -f /run/agentos-first-setup/password
      fi
      dev=/dev/disk/by-partlabel/agentos-luks
      key=/etc/agentos/template-disk.key
      [ -e "$dev" ] || exit 0
      real=$(readlink -f "$dev")
      label=$(cryptsetup luksDump "$real" | sed -n 's/^Label:[[:space:]]*//p')
      reenc=0; cryptsetup luksDump "$real" | grep -q 'online-reencrypt' && reenc=1
      tpl=0; cryptsetup open --test-passphrase --key-file="$key" "$real" 2>/dev/null && tpl=1
      # Stages are kept in the LUKS2 header label, so a power cut at any point resumes on the next boot:
      #   agentos-rekey-pending  passphrase being replaced / volume key being re-encrypted
      #   agentos-rekey-grow     new volume key in place; partition + LUKS + Btrfs not yet grown to the disk
      #   agentos-luks           done (an installed disk never gets a label and is skipped like a finished one)
      case "$label" in agentos-rekey-*) pending=1 ;; *) pending=$reenc ;; esac
      [ "$tpl" = 1 ] || [ "$pending" = 1 ] || exit 0
      f=$(mktemp -p /run agentos-newkey.XXXXXX)
      if [ "$tpl" = 1 ]; then
        echo "agentos: template disk detected; a new disk passphrase is required"
        # Quick start (graphical VM images): this one password also becomes the administrator's (agentos-first-setup)
        handoff=0; [ -e /etc/agentos/first-setup-handoff ] && handoff=1
        if [ "$handoff" = 1 ]; then
          echo "agentos: welcome. Choose the password for this machine: it unlocks the disk at boot and signs you in as admin."
          ask1="Choose your AgentOS password (at least 8 characters):"; ask2="Repeat the password:"
        else
          ask1="New AgentOS disk passphrase (at least 8 characters):"; ask2="Repeat the disk passphrase:"
        fi
        echo "agentos: passwords must be at most 511 UTF-8 bytes; newline is not supported."
        new=""
        for i in 1 2 3 4 5; do
          a=$(systemd-ask-password --timeout=0 --no-tty "$ask1") || continue
          b=$(systemd-ask-password --timeout=0 --no-tty "$ask2") || continue
          if [ "$a" = "$b" ] && [ ''${#a} -ge 8 ] && valid_account_password "$a"; then new=$a; break; fi
          echo "agentos: passphrases differ, are shorter than 8 characters, exceed 511 bytes, or contain an unsupported newline"
        done
        [ -n "$new" ] || { echo "agentos: no disk passphrase set; machined stays stopped"; exit 1; }
        printf '%s' "$new" > "$f"
        if [ "$handoff" = 1 ]; then
          install -d -m 0700 /run/agentos-first-setup
          (umask 077; printf '%s' "$new" > /run/agentos-first-setup/password)
        fi
        new=""; a=""; b=""
        cryptsetup config --label agentos-rekey-pending "$real"
        cryptsetup luksAddKey --batch-mode --key-file="$key" "$real" "$f"
      else
        echo "agentos: the first-boot disk re-key was interrupted; enter the disk passphrase to finish it"
        ok=0
        if [ -s "$unlock" ] && valid_account_password "$(cat "$unlock")" && cryptsetup open --test-passphrase --key-file="$unlock" "$real" 2>/dev/null; then
          cp "$unlock" "$f"
          ok=1
        fi
        for i in 1 2 3 4 5; do
          [ "$ok" = 0 ] || break
          a=$(systemd-ask-password --timeout=0 --no-tty "AgentOS disk passphrase (finishing the first-boot re-key, maximum 511 bytes):") || continue
          valid_account_password "$a" || { a=""; echo "agentos: password must be 1..511 UTF-8 bytes without newline"; continue; }
          printf '%s' "$a" > "$f"; a=""
          if cryptsetup open --test-passphrase --key-file="$f" "$real" 2>/dev/null; then ok=1; break; fi
          echo "agentos: that passphrase does not open the disk"
        done
        [ "$ok" = 1 ] || { echo "agentos: disk re-key not finished; machined stays stopped"; exit 1; }
        # quick start after a power cut: the same password still becomes the administrator's (first boot is open)
        if [ -e /etc/agentos/first-setup-handoff ] && [ ! -e /var/lib/agentos-machine/first-boot-closed ]; then
          install -d -m 0700 /run/agentos-first-setup
          (umask 077; cp "$f" /run/agentos-first-setup/password)
        fi
      fi
      if [ "$(cryptsetup luksDump "$real" | sed -n 's/^Label:[[:space:]]*//p')" != agentos-rekey-grow ]; then
        if [ "$reenc" = 1 ]; then
          echo "agentos: resuming the interrupted disk re-encryption"
          cryptsetup reencrypt --resume-only --batch-mode --key-file="$f" --active-name agentos-root "$real"
        else
          # Only the operator's slot may remain: the template slot (public key) and any slot left by an earlier
          # interrupted attempt are destroyed before the volume key is replaced.
          slot=$(cryptsetup open --test-passphrase -v --key-file="$f" "$real" 2>&1 | sed -n 's/^Key slot \([0-9]*\) unlocked.*/\1/p')
          [ -n "$slot" ] || { echo "agentos: cannot find the new key slot"; exit 1; }
          for s in $(cryptsetup luksDump "$real" | sed -n 's/^  \([0-9][0-9]*\): luks2$/\1/p'); do
            [ "$s" = "$slot" ] || cryptsetup luksKillSlot --batch-mode --key-file="$f" "$real" "$s"
          done
          if cryptsetup open --test-passphrase --key-file="$key" "$real" 2>/dev/null; then echo "agentos: template key still opens the disk"; exit 1; fi
          # Every clone of one template starts with the same LUKS volume key (the template's). Replace it before
          # any machine data is written: online LUKS2 re-encryption of the (small) template partition with a fresh
          # random volume key; resilience=checksum lets a power cut resume instead of corrupting the hot zone.
          echo "agentos: re-encrypting the disk with a new volume key"
          cryptsetup reencrypt --batch-mode --resilience checksum --key-file="$f" --active-name agentos-root "$real"
        fi
        if cryptsetup luksDump "$real" | grep -q 'online-reencrypt'; then echo "agentos: re-encryption did not finish"; exit 1; fi
        cryptsetup config --label agentos-rekey-grow "$real"
      fi
      # The template partition is deliberately small (only it had to be re-encrypted); give the rest of the disk to
      # it now. The new space was never written under the template key.
      part=$(basename "$real")
      disk=/dev/$(basename "$(readlink -f "/sys/class/block/$part/..")")
      nr=$(cat "/sys/class/block/$part/partition")
      sfdisk --relocate gpt-bak-std "$disk" || true
      echo ", +" | sfdisk --no-reread --no-tell-kernel -N "$nr" "$disk"
      partx --update --nr "$nr" "$disk"
      # partx changes the partition under udev: let it recreate /dev/disk/by-partlabel/agentos-luks (the next boot's
      # initrd and the operator use that name; m6-qcow2 41203693428 found it missing right after the grow)
      udevadm trigger --action=change --settle "/dev/$part" 2>/dev/null || { udevadm trigger --action=change "/dev/$part"; udevadm settle; }
      cryptsetup resize --key-file="$f" agentos-root
      btrfs filesystem resize max /
      cryptsetup config --label agentos-luks "$real"
      mkdir -p /var/lib/agentos-machine && printf '%s\n' "volume-key-regenerated-at-first-boot" > /var/lib/agentos-machine/disk-origin
      echo "agentos: disk passphrase set (template key removed, new volume key, disk grown)"
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
