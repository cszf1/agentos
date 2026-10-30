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
      virtualisation = { memorySize = 4096; inherit cores; diskSize = 10240; };
      environment.systemPackages = [ pkgs.python3 pkgs.sqlite pkgs.age ];
      environment.etc."agentos-test/rpc.py".source = ./rpc.py;
      # both machines run code apps from the release's fixed images; the source generates one with the formal faux
      # model (test variant only)
      agentos.releaseImages = pkgs.agentos-oci;
      systemd.user.services."agentos-host@".environment.AGENTOS_MODEL_MODE = lib.mkForce "faux";
    };
  in {
    machine = node;
    # the target rebuilds its containers from the release's fixed images only (offline; no graphroot travels)
    target = node;
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m12-clone.py;
}
