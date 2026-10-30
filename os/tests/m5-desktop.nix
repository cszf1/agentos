# M4/M5 native session in a KVM VM (virtio-gpu, software rendering): real PAM login on a VT, Sway + the Qt Shell
# as the only surface, no browser engine in the Shell process, logind-confirmed lock through swaylock, a killed
# locker ends the session instead of exposing the desktop. Not a real GPU, display or input-method test.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m5-desktop";
  enableOCR = false;
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.softwareRendering = true;
    virtualisation = { memorySize = 4096; inherit cores; diskSize = 8192; qemu.options = [ "-vga none -device virtio-gpu-pci" ]; };
    environment.systemPackages = [ pkgs.python3 ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./m5-desktop.py;
}
