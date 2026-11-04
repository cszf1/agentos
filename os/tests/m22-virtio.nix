# The released VM system (vm-release-node.nix: hardware/vm.nix, systemd initrd, software rendering) on virtio-gpu
# reaches ReGreet. On c4786ac this combination left VT1 black: card0 was never initialized in udev, so seat0 had no
# drm:card0 and Cage found no GPU. m5-desktop and m20-sway use virtio-gpu too, but without hardware/vm.nix and the
# systemd initrd. A VMware, VirtualBox or Hyper-V display is not covered here (m21-vmware, manual checks).
{ pkgs, modules }:
pkgs.testers.runNixOSTest {
  name = "agentos-m22-virtio";
  enableOCR = false;
  nodes.machine = {
    imports = [ (import ./vm-release-node.nix { inherit pkgs modules; }) ];
    virtualisation.qemu.options = [ "-vga none -device virtio-gpu-pci" ];
  };
  testScript = "PNGTOPNM = \"${pkgs.netpbm}/bin/pngtopnm\"\n" + builtins.readFile ./lib.py + builtins.readFile ./pnm.py + builtins.readFile ./m22-virtio.py;
}
