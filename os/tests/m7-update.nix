# M7 trial boot on real systemd-boot + OVMF (spec §21.2–21.3, V1-U07/U08/U10/U12): the update worker writes
# complete BLS entries, arms the one-shot, the firmware boots the candidate once, the default stays known-good
# until commit; a bad candidate falls back to known-good and is never retried; GC keeps registered entries it must.
{ pkgs, modules, cores ? 2, older }:
pkgs.testers.runNixOSTest {
  name = "agentos-m7-update";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 2048; inherit cores; diskSize = 4096; useBootLoader = true; useEFIBoot = true; };
    boot.loader.systemd-boot.enable = true;
    boot.loader.efi.canTouchEfiVariables = lib.mkForce true;
    environment.systemPackages = [ pkgs.jq pkgs.openssl pkgs.sqlite pkgs.python3 ];
    # review R2-1: two small real OCI (docker-archive) images; the U04 subtest signs releases over their real bytes
    environment.etc."agentos-u04/a.tar.gz".source = pkgs.dockerTools.buildImage { name = "agentos-u04-a"; tag = "a"; copyToRoot = pkgs.writeTextDir "u04" "image a\n"; };
    environment.etc."agentos-u04/b.tar.gz".source = pkgs.dockerTools.buildImage { name = "agentos-u04-b"; tag = "b"; copyToRoot = pkgs.writeTextDir "u04" "image b\n"; };
    # U11: a second, really different system closure (its own toplevel, init and /etc) for the older generation the
    # rollback boots; the running system is the newer one. The older generation runs the AgentOS programs of an
    # earlier v1.0 commit (flake.nix olderAgentos; same schemas, declared compatible 1..2).
    environment.etc."agentos-generation".text = "current\n";
    environment.etc."agentos-programs".text = "${pkgs.agentos-native}\n${pkgs.agentos-node}\n";
    specialisation.oldgen.configuration = {
      environment.etc."agentos-generation".text = lib.mkForce "oldgen\n";
      environment.etc."agentos-oldgen-only".text = "this file exists only in the older generation's closure\n";
      agentos.nativePackage = lib.mkForce older.native;
      agentos.nodePackage = lib.mkForce older.node;
      environment.etc."agentos-programs".text = lib.mkForce "${older.native}\n${older.node}\n";
    };
  };
  testScript = builtins.readFile ./m7-update.py;
}
