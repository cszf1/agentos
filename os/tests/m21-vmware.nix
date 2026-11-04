# VMware-class boot on KVM (fix-vm-boot G): the release VM profile (hardware/vm.nix, systemd initrd) on QEMU's VMware
# SVGA II adapter (-vga vmware, PCI 15ad:0405, the device vmwgfx binds to). Checks that no "Load Kernel Modules" unit
# fails, that a first boot cut off after install.ensure and before closeFirstBoot asks again on the console and then
# completes, that greetd's bounded retry ends in the tty1 notice with a working text login, and that an install from
# before the first-boot-closed marker is not sent back into first boot.
# QEMU's SVGA II has no pitchlock register, so vmwgfx refuses it (probe -38) after it has already removed the firmware
# framebuffer: there is no DRM device and ReGreet cannot show here. A VMware host (Workstation/ESXi, 3D off) is still a
# manual check; ReGreet, Sway and the Shell on a working output are m5-desktop and m20-sway (virtio-gpu).
{ pkgs, modules }:
pkgs.testers.runNixOSTest {
  name = "agentos-m21-vmware";
  enableOCR = false;
  nodes.machine = { lib, ... }: {
    imports = modules ++ [ ../hardware/vm.nix ];
    boot.initrd.systemd.enable = true;     # as the release images (hardware/disk-layout.nix)
    agentos.enable = true;
    agentos.softwareRendering = true;
    agentos.releaseImages = pkgs.agentos-oci;
    virtualisation = { memorySize = 4096; cores = 2; diskSize = 8192; qemu.options = [ "-vga vmware" ]; };
    environment.systemPackages = [ pkgs.sqlite ];
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./m21-vmware.py;
}
