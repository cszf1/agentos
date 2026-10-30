# W03: SIGKILL of the real machined at workspace-creation breakpoints in a NixOS VM (see m14-create.py). Test variant
# only: AGENTOS_TEST_FAULTS=1 lets machined read a one-shot crash point from /run/agentos-test/machine-fault.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m14-create";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 3072; inherit cores; diskSize = 4096; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
    systemd.services.agentos-machine.environment.AGENTOS_TEST_FAULTS = "1";
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m14-create.py;
}
