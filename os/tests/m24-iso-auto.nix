# M24 the ISO installs by itself (docs/VM_QUICKSTART.md): a clean UEFI VM with one blank 64 GiB disk boots the release
# ISO's own kernel, initrd and command line and nobody touches it; after the 10 s countdown it installs to that disk
# and restarts. The installed disk alone then asks one password on its screen (twice), which unlocks the disk from
# then on and is the password of the administrator "admin"; the login screen comes up and admin signs in with it on a
# console. The next boot asks it once at the disk unlock. Keyboard and screen OCR only; no test backdoor anywhere.
{ pkgs, iso }:
let
  isoBoot = pkgs.runCommand "agentos-iso-serial-entry" { nativeBuildInputs = [ pkgs.xorriso pkgs.gawk ]; } ''
    set -euo pipefail
    img=$(echo ${iso}/iso/*.iso)
    mkdir -p $out
    xorriso -osirrox on -indev "$img" -extract /isolinux/isolinux.cfg $out/isolinux.cfg 2>/dev/null
    # the ISO's own "Serial console=ttyS0,115200n8" menu entry: its kernel, initrd and APPEND line, unchanged
    # (nixpkgs 26.05 names it on the submenu: "MENU BEGIN Serial console=ttyS0,115200n8", then "LABEL boot-serial")
    awk -v out=$out '
      /^MENU BEGIN/ { s = ($0 ~ /Serial console/) }
      /^LABEL/ { f = s }
      f && $1 == "LINUX"  { print $2 > (out "/kernel.path") }
      f && $1 == "APPEND" { sub(/^[ \t]*APPEND[ \t]+/, ""); print > (out "/append") }
      f && $1 == "INITRD" { print $2 > (out "/initrd.path"); f = 0; s = 0 }' $out/isolinux.cfg
    test -s $out/kernel.path && test -s $out/initrd.path && grep -q 'console=ttyS0' $out/append
    xorriso -osirrox on -indev "$img" -extract "$(cat $out/kernel.path)" $out/bzImage -extract "$(cat $out/initrd.path)" $out/initrd 2>/dev/null
    ln -s "$img" $out/agentos.iso
  '';
in
pkgs.testers.runNixOSTest {
  name = "agentos-m24-iso-auto";
  enableOCR = true;
  nodes = { };
  testScript = ''
    ISO_DIR = "${isoBoot}"
    QEMU = "${pkgs.qemu_test}/bin/qemu-kvm"
    QEMU_IMG = "${pkgs.qemu_test}/bin/qemu-img"
    OVMF_CODE = "${pkgs.OVMF.firmware}"
    OVMF_VARS = "${pkgs.OVMF.variables}"
    PNGTOPNM = "${pkgs.netpbm}/bin/pngtopnm"
  '' + builtins.readFile ./pnm.py + builtins.readFile ./m24-iso-auto.py;
}
