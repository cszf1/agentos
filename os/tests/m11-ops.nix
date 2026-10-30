# Operations checks across two real Hosts (see m11-ops.py): own/shared runs (I05), switching after accept (W06),
# native entry abuse (O07), SIGKILL of broker/machined/gateway (O06 part). Same local holding endpoint as m10.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m11-ops";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 4096; inherit cores; diskSize = 6144; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
    environment.etc."agentos-test/ops-fuzz.py".source = ./ops-fuzz.py;
    systemd.services.agentos-fake-model = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${./fake-model.py}";
    };
    # test-only model route: the workspace id is the first path segment so the endpoint can count per workspace
    systemd.user.services."agentos-host@".environment = {
      AGENTOS_MODEL_PROVIDER = "openai-compatible";
      AGENTOS_MODEL_ID = "fake";
      AGENTOS_MODEL_BASE_URL = "http://127.0.0.1:18080/%i/v1";
      AGENTOS_MODEL_API_KEY = "test-endpoint-no-secret";
    };
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m11-ops.py;
}
