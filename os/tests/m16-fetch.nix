# V1-U06 download part in a NixOS VM (see m16-fetch.py): `agentosctl update fetch` pulls a candidate closure from a
# signed binary cache that the test builds and serves inside the VM (throttled, one transfer at a time), the link is
# cut mid-way, and the same command resumes. KVM VM evidence; the cache is local, not a real release server.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m16-fetch";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 3072; inherit cores; diskSize = 6144; writableStore = true; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./m16-fetch.py;
}
