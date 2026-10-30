# V1-W09 on two real Hosts in a NixOS VM: two workspaces register the SAME systemd unit (agentos-lab.service) in the
# root broker policy under different keys, each enables a bounded "keep running" maintenance policy, and the broker's
# counts and cooldown follow the physical unit, not the workspace (see m17-shared.py). This node is a test variant:
# the lab unit, its polkit rule and the runtime-written policy entries never exist in a release configuration.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m17-shared";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 4096; inherit cores; diskSize = 6144; };
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
    systemd.services.agentos-lab = {
      description = "AgentOS lab unit shared by two workspaces (test only)";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = { ExecStart = "${pkgs.coreutils}/bin/sleep infinity"; DynamicUser = true; };
    };
    # the service worker may start/stop exactly this unit (what the administrator's catalog install does on v0.4)
    security.polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (subject.user != "agentos-svc") return polkit.Result.NOT_HANDLED;
        if (action.id == "org.freedesktop.systemd1.manage-units") {
          var unit = action.lookup("unit"), verb = action.lookup("verb");
          if (unit == "agentos-lab.service" && (verb == "start" || verb == "stop")) return polkit.Result.YES;
        }
        return polkit.Result.NO;
      });
    '';
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m17-shared.py;
}
