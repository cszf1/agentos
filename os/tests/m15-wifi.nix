# Wi-Fi and model-credential secrets on a real NetworkManager in a NixOS VM (see m15-wifi.py; V1-I11, H04 VM part).
# The radio is mac80211_hwsim (two simulated radios): hostapd serves a WPA2-Personal network on wlan1 from a config
# the test writes at run time (so the key is never in the Nix store), NetworkManager manages wlan0. No real Wi-Fi
# hardware: KVM VM evidence only. The model endpoint is the local fake-model.py; this node is a test variant.
{ pkgs, modules, cores ? 2 }:
pkgs.testers.runNixOSTest {
  name = "agentos-m15-wifi";
  nodes.machine = { lib, ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 4096; inherit cores; diskSize = 6144; };
    boot.kernelModules = [ "mac80211_hwsim" ];
    boot.extraModprobeConfig = "options mac80211_hwsim radios=2";
    networking.wireless.enable = lib.mkForce false;
    networking.networkmanager.unmanaged = [ "wlan1" ];
    environment.systemPackages = [ pkgs.python3 pkgs.sqlite pkgs.hostapd pkgs.iw ];
    environment.etc."agentos-test/rpc.py".source = ./rpc.py;
    systemd.services.agentos-fake-model = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${./fake-model.py}";
    };
    # no model environment here: the workspace gets its model only through workspaces.modelCredential.set
  };
  testScript = builtins.readFile ./lib.py + builtins.readFile ./members_lib.py + builtins.readFile ./m15-wifi.py;
}
