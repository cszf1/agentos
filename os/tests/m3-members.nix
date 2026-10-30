# M3 checks on real Linux UIDs in a NixOS VM: role matrix, revocation with and without the Host, last owner,
# disabled account, lock/logout epochs, two parallel workspaces, stop/archive (see m3-members.py).
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m3-members";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 4096; inherit cores; diskSize = 6144; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./m3-members.py;
}
