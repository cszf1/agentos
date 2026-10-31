# V1-U01/O09 (review F11): the release ISO is the only install entry. A clean UEFI VM boots the ISO's own kernel,
# initrd and command line ("Serial console" entry of its isolinux menu, so the console can be driven), installs to a
# blank 64 GiB virtio disk with a serial number, powers off; the installed disk then boots with nothing else attached:
# first disk unlock and the first-boot administrator on the local console (keyboard + screen OCR), ReGreet login,
# the Qt Shell checked in Sway's pixels and driven with tablet clicks. A second ISO boot opens the disk read-only to
# read the installed system's journal and state as evidence. The installed system is the plain release toplevel:
# no test backdoor, no serial console.
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
  name = "agentos-m19-iso";
  enableOCR = true;
  nodes = { };
  testScript = ''
    ISO_DIR = "${isoBoot}"
    QEMU = "${pkgs.qemu_test}/bin/qemu-kvm"
    QEMU_IMG = "${pkgs.qemu_test}/bin/qemu-img"
    OVMF_CODE = "${pkgs.OVMF.firmware}"
    OVMF_VARS = "${pkgs.OVMF.variables}"
    PNGTOPNM = "${pkgs.netpbm}/bin/pngtopnm"
  '' + builtins.readFile ./pnm.py + builtins.readFile ./m19-iso.py;
}
