# V1-D02…D07, D09, D11, D12 in a real session (review F12): first boot on the console, ReGreet/greetd/PAM login,
# Sway on the virtio-gpu output, and the native Shell's controller + fixed QML (agentos-shell-e2e, phase "sway") as a
# real Wayland client in that session (QT_QPA_PLATFORM=wayland, not offscreen). Every user step is real QMP input
# (USB tablet clicks, wheel, keyboard) that the e2e asks the driver for (E2E-ASK handshake, desktop/tests/e2e_sway.hpp);
# results are checked in the Shell's models, in Sway's scanned-out pixels and in the Host's database. The Host uses
# the formal faux model (deterministic, no network): a test variant, never a release configuration. Not a real GPU,
# display or input-method test (D10, H0x need a physical machine).
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m20-sway";
  enableOCR = false;
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.softwareRendering = true;
    agentos.releaseImages = pkgs.agentos-oci;
    virtualisation = { memorySize = 6144; inherit cores; diskSize = 12288; qemu.options = [ "-vga none -device virtio-gpu-pci" "-device qemu-xhci,id=xhci -device usb-tablet,bus=xhci.0" ]; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite pkgs.agentos-shell-e2e pkgs.wl-clipboard ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
    fonts.packages = [ pkgs.dejavu_fonts pkgs.noto-fonts-cjk-sans ];
    systemd.user.services."agentos-host@".serviceConfig.EnvironmentFile = lib.mkAfter [ "-/run/agentos-test/model.env" ];
    systemd.tmpfiles.rules = [ "d /run/agentos-test 0755 root root -" "f /run/agentos-test/model.env 0644 root root - AGENTOS_MODEL_MODE=faux" ];
  };
  testScript = "PNGTOPNM = \"${pkgs.netpbm}/bin/pngtopnm\"\n" + builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m20-sway.py;
}
