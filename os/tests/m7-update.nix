# M7 trial boot on real systemd-boot + OVMF (spec §21.2–21.3, V1-U07/U08/U10/U12): the update worker writes
# complete BLS entries, arms the one-shot, the firmware boots the candidate once, the default stays known-good
# until commit; a bad candidate falls back to known-good and is never retried; GC keeps registered entries it must.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m7-update";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 2048; inherit cores; diskSize = 4096; useBootLoader = true; useEFIBoot = true; };
    boot.loader.systemd-boot.enable = true;
    boot.loader.efi.canTouchEfiVariables = lib.mkForce true;
    environment.systemPackages = [ pkgs.jq pkgs.openssl ];
  };
  testScript = builtins.readFile ./m7-update.py;
}
