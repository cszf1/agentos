# V1-O09 drill, part "import → off-machine restore" on one commit (see m18-o09.py). ISO install (m6-install), update
# (m7-update) and the reproducible build (build-repro) run as their own checks on the same commit; the acceptance
# report lists the four runs together.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m18-o09";
  nodes = let
    node = { lib, ... }: {
      imports = modules;
      agentos.enable = true;
      agentos.graphical = false;
      virtualisation = { memorySize = 3072; inherit cores; diskSize = 8192; };
      environment.systemPackages = [ pkgs.python3 pkgs.sqlite pkgs.age ];
      environment.etc."agentos-test/rpc.py".source = ./rpc.py;
      environment.etc."agentos-test/v04-backup".source = ./fixtures/v04-backup;
    };
  in {
    machine = node;
    target = node;
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m18-o09.py;
}
