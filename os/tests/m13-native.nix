# M6/D08/O03 through the native Shell (spec §32 V1-D08, V1-M06, V1-O03): the Shell's own controller and fixed QML
# (agentos-shell-e2e, offscreen, test-only) against the REAL session gateway, machined and workspace Host. The Host
# uses the formal faux model (deterministic, no network); this node is a test variant, never a release configuration.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m13-native";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    agentos.releaseImages = pkgs.agentos-oci;   # code apps build from the release's fixed images (offline)
    virtualisation = { memorySize = 6144; inherit cores; diskSize = 12288; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite pkgs.agentos-shell-e2e ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
    fonts.packages = [ pkgs.dejavu_fonts pkgs.noto-fonts-cjk-sans ];
    # test-only model switch: EnvironmentFile overrides the unit's Environment= (faux now, "no model" for O03)
    systemd.user.services."agentos-host@".serviceConfig.EnvironmentFile = lib.mkAfter [ "-/run/agentos-test/model.env" ];   # after the workspace model.env: later file wins
    systemd.tmpfiles.rules = [ "d /run/agentos-test 0755 root root -" "f /run/agentos-test/model.env 0644 root root - AGENTOS_MODEL_MODE=faux" ];
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m13-native.py;
}
