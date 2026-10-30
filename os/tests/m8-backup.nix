# M8 cold checkpoint / restore / encrypted export on real execution UIDs (spec §23–24, V1-R01/R03/R04/R05 in a VM).
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m8-backup";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 3072; inherit cores; diskSize = 6144; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite pkgs.age ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./m8-backup.py;
}
