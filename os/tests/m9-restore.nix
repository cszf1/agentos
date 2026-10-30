# M8/M9 machine backup/restore on real UIDs in a NixOS VM: one barrier over all workspaces, interrupted restore,
# epochs/incarnations, root-side facts newer than the set, broker and machine directory loss (see m9-restore.py).
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m9-restore";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 4096; inherit cores; diskSize = 6144; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m9-restore.py;
}
