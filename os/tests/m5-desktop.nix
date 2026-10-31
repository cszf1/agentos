# M4/M5 native session in a KVM VM (virtio-gpu, software rendering): first boot on the local console, real
# greetd/ReGreet/PAM login (wrong password, logout, login again), Sway + the Qt Shell as the only surface checked in
# the scanned-out pixels with tablet clicks and keyboard shortcuts, no browser engine in the Shell process, logind-confirmed lock through swaylock, a killed
# locker ends the session instead of exposing the desktop. Not a real GPU, display or input-method test.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m5-desktop";
  enableOCR = false;
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.softwareRendering = true;
    agentos.releaseImages = pkgs.agentos-oci;   # the approved images from the release (offline: the VM has no network)
    virtualisation = { memorySize = 4096; inherit cores; diskSize = 8192; qemu.options = [ "-vga none -device virtio-gpu-pci" "-device qemu-xhci,id=xhci -device usb-tablet,bus=xhci.0" ]; };   # review F12: usb-tablet = an absolute pointer for real clicks
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
  };
  testScript = "PNGTOPNM = \"${pkgs.netpbm}/bin/pngtopnm\"\n" + builtins.readFile ./lib.py + builtins.readFile ./pnm.py + builtins.readFile ./m5-desktop.py;
}
