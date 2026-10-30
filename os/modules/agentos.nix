# AgentOS v1.0 system module (spec §5, §8, §9, §17). Fixed services, fixed sockets, no TCP listener.
{ config, lib, pkgs, ... }:
let
  cfg = config.agentos;
  native = pkgs.agentos-native;
  node = pkgs.agentos-node;
  shell = pkgs.agentos-shell;
  sysPath = lib.makeBinPath (with pkgs; [ shadow util-linux systemd coreutils podman ]);
  swayConfig = pkgs.writeText "agentos-sway.conf" ''
    # AgentOS session (spec §9.1): Sway is the compositor, the Qt Shell is the only application surface.
    default_border none
    default_floating_border none
    font pango:Noto Sans CJK SC 10
    output * bg #202020 solid_color
    seat * hide_cursor 8000
    for_window [app_id="agentos-shell"] fullscreen enable
    exec ${pkgs.dbus}/bin/dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP=sway
    exec fcitx5 -d --replace
    exec ${native}/bin/agentos-session-agent
  '';
  session = pkgs.writeShellScriptBin "agentos-session" ''
    # Started by greetd after PAM (a real logind session on seat0). Nothing here comes from the network or a model.
    export XDG_CURRENT_DESKTOP=sway XDG_SESSION_TYPE=wayland QT_QPA_PLATFORM=wayland QT_IM_MODULE=fcitx XMODIFIERS=@im=fcitx
    export AGENTOS_SHELL=${shell}/bin/agentos-shell AGENTOS_GATEWAY_SOCKET=/run/agentos/gateway.sock
    ${lib.optionalString cfg.softwareRendering "export WLR_RENDERER=pixman WLR_NO_HARDWARE_CURSORS=1 QT_QUICK_BACKEND=software"}
    exec ${pkgs.sway}/bin/sway --unsupported-gpu -c ${swayConfig}
  '';
  sessionDesktop = pkgs.writeTextFile {
    name = "agentos-session-desktop";
    destination = "/share/wayland-sessions/agentos.desktop";
    text = ''
      [Desktop Entry]
      Name=AgentOS
      Exec=${session}/bin/agentos-session
      Type=Application
    '';
    passthru.providedSessions = [ "agentos" ];
  };
in {
  options.agentos = {
    enable = lib.mkEnableOption "AgentOS";
    graphical = lib.mkOption { type = lib.types.bool; default = true; description = "greetd + Sway + Qt Shell session (off only for headless VM checks)"; };
    softwareRendering = lib.mkOption { type = lib.types.bool; default = false; description = "pixman/software rendering for virtual GPUs (QEMU profile)"; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [ { assertion = cfg.graphical -> config.programs.sway.enable; message = "the AgentOS session needs Sway"; } ];
    environment.systemPackages = [ native node ] ++ lib.optionals cfg.graphical [ shell session pkgs.swaylock pkgs.swayidle pkgs.wl-clipboard pkgs.wireplumber ];
    services.displayManager.sessionPackages = lib.mkIf cfg.graphical [ sessionDesktop ];
    services.greetd.enable = cfg.graphical;
    programs.regreet.enable = cfg.graphical;
    security.pam.services.swaylock = lib.mkIf cfg.graphical { };
    # Gateway re-authentication of a machine administrator (spec §12.2): plain local unix auth, no other module.
    security.pam.services.agentos-admin-auth = { unixAuth = true; };

    users.mutableUsers = true; # machined owns dynamic accounts (spec §21.2: activation must not reset them)
    users.groups.agentos-broker = { };
    users.users = lib.genAttrs [ "agentos-file" "agentos-svc" "agentos-net" "agentos-serial" ] (n: { isSystemUser = true; group = n; });
    users.groups.agentos-file = { };
    users.groups.agentos-svc = { };
    users.groups.agentos-net = { };
    users.groups.agentos-serial = { };

    systemd.tmpfiles.rules = [
      "d /var/lib/agentos 0711 root root -"
      "d /var/lib/agentos/workspaces 0711 root root -"
      "d /var/lib/agentos-runtime 0711 root root -"
      "d /var/lib/agentos-snapshots 0700 root root -"
      "d /run/agentos 0755 root root -"
      "d /run/agentos/workspaces 0711 root root -"
      "d /etc/agentos/broker 0755 root root -"
    ];

    environment.etc."agentos/broker/policy.json".text = builtins.toJSON {
      policyFormat = 1;
      machineInstallId = "pending-machine-registry";
      hosts = [ ];
      managedRoots = [ ];
      units = [ ];
      labNetworks = [ ];
      serial = [ ];
      maintenance = [ ];
      workers = { };
      testMode = false;
    };

    systemd.services.agentos-machine = {
      description = "AgentOS machine directory (machined)";
      wantedBy = [ "multi-user.target" ];
      after = [ "local-fs.target" "dbus.service" "systemd-logind.service" ];
      before = [ "display-manager.service" ];
      path = [ pkgs.shadow pkgs.util-linux pkgs.systemd pkgs.coreutils pkgs.procps ];
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        Type = "notify";
        NotifyAccess = "all";
        ExecStart = "${native}/bin/agentos-machined --init-program ${node}/bin/agentos-admin";
        StateDirectory = "agentos-machine";
        StateDirectoryMode = "0700";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 1;
        LimitCORE = 0;
      };
    };

    systemd.services.agentos-session-gateway = {
      description = "AgentOS session gateway";
      wantedBy = [ "multi-user.target" ];
      requires = [ "agentos-machine.service" ];
      after = [ "agentos-machine.service" ];
      before = [ "display-manager.service" ];
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        Type = "notify";
        NotifyAccess = "all";
        ExecStart = "${native}/bin/agentos-session-gateway";
        Restart = "on-failure";
        RestartSec = 1;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ReadWritePaths = [ "/run/agentos" ];
        RestrictAddressFamilies = [ "AF_UNIX" ];
        CapabilityBoundingSet = [ "CAP_CHOWN" "CAP_FOWNER" "CAP_DAC_OVERRIDE" ];
        LimitCORE = 0;
        MemoryMax = "256M";
      };
    };

    systemd.services.agentos-broker = {
      description = "AgentOS privileged broker";
      wantedBy = [ "multi-user.target" ];
      after = [ "agentos-machine.service" "dbus.service" ];
      unitConfig.StartLimitIntervalSec = 0;
      preStart = "[ -f /var/lib/agentos-broker/broker.sqlite ] || ${native}/bin/agentos-broker admin install-db";
      serviceConfig = {
        Type = "notify";
        NotifyAccess = "main";
        ExecStart = "${native}/bin/agentos-broker serve";
        RuntimeDirectory = "agentos-broker";
        RuntimeDirectoryMode = "0755";
        StateDirectory = "agentos-broker";
        StateDirectoryMode = "0700";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 1;
        LimitCORE = 0;
      };
    };

    # Per-workspace units live in the execution UID's own user manager (spec §17.2). They only start for a UID that
    # owns a registered workspace root; the Host itself proves its registration to machined over SO_PEERCRED.
    systemd.user.targets."agentos-workspace@" = {
      description = "AgentOS workspace %i";
      wants = [ "agentos-host@%i.service" "podman.socket" ];
      unitConfig.ConditionPathIsDirectory = "/var/lib/agentos/workspaces/%i/data";
    };
    systemd.user.services."agentos-host@" = {
      description = "AgentOS Host for workspace %i";
      unitConfig = {
        ConditionPathIsDirectory = "/var/lib/agentos/workspaces/%i/data";
        StartLimitIntervalSec = 300;
        StartLimitBurst = 5;
      };
      environment = {
        AGENTOS_MACHINE_MODE = "1";
        AGENTOS_WORKSPACE_ID = "%i";
        AGENTOS_DATA_DIR = "/var/lib/agentos/workspaces/%i/data";
        AGENTOS_RUNTIME = "podman";
        AGENTOS_PODMAN_SOCKET = "%t/podman/podman.sock";
        AGENTOS_MODEL_MODE = "real";
        NODE_ENV = "production";
      };
      path = [ pkgs.podman pkgs.util-linux pkgs.coreutils ];
      serviceConfig = {
        ExecStart = "${node}/bin/agentos-host";
        Restart = "on-failure";
        RestartSec = 2;
        TimeoutStopSec = 35;
        KillMode = "mixed";
        MemoryHigh = "2G";
        MemoryMax = "3G";
        LimitCORE = 0;
      };
    };

    virtualisation.podman.enable = true;
    virtualisation.containers.enable = true;
    systemd.coredump.settings.Coredump = { Storage = "none"; ProcessSizeMax = 0; };
  };
}
