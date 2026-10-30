# agentos-qcow2 (spec §19.1, V1-U03): the blank VM template, made from the SAME release toplevel the ISO carries
# by running the SAME offline installer (agentos-install plan/confirm/run) inside a build VM against an empty
# qcow2. Layout is identical to an installed disk (GPT, ESP, LUKS2, Btrfs subvolumes). The LUKS container opens
# with the public template key; first boot (agentos-disk-rekey) makes the operator set a real passphrase and
# removes the template slot before machined may start. No machine identity, account or password is in the image.
{ lib, pkgs, vmTools, qemu, system, installer, name ? "agentos-qcow2", diskGiB ? 64 }:
let
  vm = vmTools.override {
    rootModules = [ "virtio_pci" "virtio_mmio" "virtio_blk" "virtio_balloon" "virtio_rng" "ext4" "virtiofs" "crc32c"
      "dm_mod" "cbc" "xts" "aesni_intel" "aes_ti" "af_alg" "algif_skcipher" "dm_crypt" "btrfs" "vfat" "nls_cp437" "nls_iso8859_1" ];
  };
  closure = pkgs.closureInfo { rootPaths = [ system ]; };
  tools = lib.makeBinPath (with pkgs; [ installer util-linux coreutils gptfdisk cryptsetup lvm2 procps btrfs-progs dosfstools mtools libfaketime nix nixos-install-tools systemd jq e2fsprogs ]);
in
vm.runInLinuxVM (pkgs.runCommand name {
  memSize = 3072;
  preVM = ''
    mkdir -p $out
    diskImage=$out/disk.qcow2
    ${qemu}/bin/qemu-img create -f qcow2 $diskImage ${toString diskGiB}G
  '';
  postVM = ''
    ${qemu}/bin/qemu-img convert -c -O qcow2 $out/disk.qcow2 $out/agentos.qcow2
    rm $out/disk.qcow2
    (cd $out && sha256sum agentos.qcow2 > agentos.qcow2.sha256)
    printf '%s\n' '${system}' > $out/system
  '';
} ''
  export PATH=${tools}:$PATH
  export NIX_STATE_DIR=$TMPDIR/state
  nix-store --load-db < ${closure}/registration
  ${pkgs.systemd}/lib/systemd/systemd-udevd --daemon || true
  udevadm trigger --action=add || true
  udevadm settle || true
  # no udev dm rules in the build VM: libdevmapper must not wait for udev cookies (it would wait forever)
  export DM_DISABLE_UDEV=1
  echo "build VM: $(nproc) cpus, $(free -m | awk '/Mem:/{print $2}') MiB; crypt: $(grep -c . /proc/crypto) lines; dm targets: $(dmsetup targets 2>&1 | tr '\n' ' ')"
  export AGENTOS_SYSTEM=${system} AGENTOS_INSTALL_ALLOW_PATH=1 AGENTOS_INSTALL_TEMPLATE_BUILD=1
  plan=$(agentos-install plan --disk /dev/vda --template --timezone UTC)
  echo "$plan"
  ph=$(echo "$plan" | jq -r .planHash)
  ser=$(echo "$plan" | jq -r '.plan.identity | (if .serial != "" then .serial elif .wwn != "" then .wwn else .majMin end)')
  agentos-install confirm --plan-hash "$ph" --serial "$ser"
  agentos-install run --passphrase-stdin < ${../modules/template-disk.key}
  test -z "$(ls -A /mnt/var/lib/agentos-machine 2>/dev/null)"
  jq -e '.template == true and .installId == null' /mnt/etc/agentos/install.json
  sync
  umount -R /mnt
  cryptsetup close agentos-root
'')
