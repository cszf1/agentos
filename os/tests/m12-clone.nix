# M9 clone to another machine (spec §24.2, V1-R10): a machine set taken on one machine, exported with age, carried
# to a SECOND machine with its own identity, and cloned there (see m12-clone.py).
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m12-clone";
  nodes = let
    node = { lib, ... }: {
      imports = modules;
      agentos.enable = true;
      agentos.graphical = false;
      virtualisation = { memorySize = 3072; inherit cores; diskSize = 6144; };
      environment.systemPackages = [ pkgs.python3 pkgs.sqlite pkgs.age ];
      environment.etc."agentos-test/rpc.py".source = ./rpc.py;
    };
  in { machine = node; target = node; };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m12-clone.py;
}
