# M0/M1/M2 real-Linux checks in a NixOS VM (spec §28 level "真实 Linux 多 UID"): machined + gateway + two execution
# UIDs, real PAM login on tty1 (seat0), session binding from the kernel peer, isolation of data and sockets.
{ pkgs, modules }:
pkgs.testers.runNixOSTest {
  name = "agentos-m2-identity";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 3072; cores = 1; diskSize = 6144; };
    environment.systemPackages = [ pkgs.python3 ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
  };
  testScript = builtins.readFile ./m2-identity.py;
}
