# Machine scheduling across two real Hosts in a NixOS VM (see m10-sched.py): model permits (S01 S02), revocation
# while waiting (I07), machined unreachable (S08), runWhenLoggedOut (W08). The Hosts use a LOCAL test endpoint
# (fake-model.py) that only holds requests; this node is a test variant and never a release configuration.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m10-sched";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 4096; inherit cores; diskSize = 6144; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
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
      # a one-turn task conversation is compactable only with a tiny kept-recent window (Pi's default keeps it all:
      # run 41132924898 "nothing older than the kept-recent window to summarise" → no background request ever sent)
      AGENTOS_COMPACTION_KEEP_RECENT_TOKENS = "1";
    };
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m10-sched.py;
}
