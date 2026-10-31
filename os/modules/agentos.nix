# AgentOS v1.0 system module (spec §5, §8, §9, §17). Fixed services, fixed sockets, no TCP listener.
{ config, lib, pkgs, ... }:
let
  cfg = config.agentos;
  native = cfg.nativePackage;
  node = cfg.nodePackage;
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
  # spec §19.4: first boot creates the local administrator and the default workspace from the local console, then
  # the unauthenticated first-boot entry closes for good (the unit's condition: machine.secret exists afterwards).
  # Graphical systems only: it runs on tty1 before greetd; the password is read without echo and handed to
  # agentosctl on stdin (never argv, never a log). Review F11: before this an installed system had no way to create
  # its first account (root is locked), so the ISO install could never reach the ReGreet login.
  # Runs as the greeter user before each ReGreet start (see default_session below). Keeps ReGreet's last user, maps
  # every local login account (UID 1000-59999 with a login shell) to the AgentOS session.
  greeterDefaults = pkgs.writeShellScript "agentos-greeter-defaults" ''
    export PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.gnugrep pkgs.gawk pkgs.getent pkgs.util-linux ]}
    f=/var/lib/regreet/state.toml
    if ! { [ -d /var/lib/regreet ] && [ -w /var/lib/regreet ]; }; then
      logger -t agentos-greeter-defaults "/var/lib/regreet missing or not writable for uid $(id -u); state not written"
      exit 0
    fi
    last=$(grep -m1 '^last_user *= *"[a-z_][a-z0-9_-]*"$' "$f" 2>/dev/null)
    users=$(getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 && $7 !~ /(nologin|false)$/ && $1 ~ /^[a-z_][a-z0-9_-]*$/ { print $1 }')
    [ -n "$last" ] || { u=$(printf '%s\n' "$users" | head -n1); [ -n "$u" ] && last="last_user = \"$u\""; }
    { [ -n "$last" ] && printf '%s\n\n' "$last"; printf '[user_to_last_sess]\n'; for u in $users; do printf '%s = "AgentOS"\n' "$u"; done; } > "$f.tmp" && mv -f "$f.tmp" "$f"
    # run as root before greetd starts (ExecStartPre) the file must still belong to the greeter, which rewrites it
    [ "$(id -u)" = 0 ] && chown --reference=/var/lib/regreet "$f" 2>/dev/null
    logger -t agentos-greeter-defaults "mapped to AgentOS: $(printf '%s ' $users)"
    exit 0
  '';
  firstSetup = pkgs.writeShellScript "agentos-first-setup" ''
    set -u
    export PATH=${lib.makeBinPath [ native pkgs.coreutils pkgs.util-linux pkgs.gnugrep ]}
    log() { logger -t agentos-first-setup "$*"; }
    installed() { test -e /var/lib/agentos-machine/machine.secret; }
    o=""
    for i in $(seq 120); do
      installed && exit 0
      o=$(agentosctl status 2>&1) && break
      case "$o" in *"not installed"*) break ;; esac
      sleep 1
    done
    case "$o" in *"not installed"*) ;; *) log "machined is not waiting for first boot; nothing to set up"; exit 0 ;; esac
    log "waiting for the administrator on the local console"
    # read with a timeout so that a first boot completed some other way (agentosctl as root) lets greetd start
    ask() { # $1 prompt, $2 "-s" for a secret
      printf '%s' "$1"
      while :; do
        if IFS= read -r ''${2:-} -t 5 REPLY; then [ -n "''${2:-}" ] && echo; return 0; fi
        installed && { echo; log "first boot was completed elsewhere"; exit 0; }
      done
    }
    while :; do
      clear 2>/dev/null || true
      echo "AgentOS 首次设置 / first-boot setup"
      echo "创建本机管理员和默认工作区。Create the machine administrator and the default workspace."
      echo
      ask "管理员登录名 / administrator login: "; name=$REPLY
      if ! printf '%s' "$name" | grep -Eqx '[a-z_][a-z0-9_-]{0,31}'; then echo "登录名只能用小写字母、数字、_ 和 -。"; sleep 3; continue; fi
      ask "口令 / password: " -s; pw=$REPLY
      ask "再次输入口令 / password again: " -s; pw2=$REPLY
      if [ -z "$pw" ] || [ "$pw" != "$pw2" ]; then pw=; pw2=; echo "两次口令不一致或为空。"; sleep 3; continue; fi
      ask "默认工作区名称 / default workspace name [Home]: "; ws=''${REPLY:-Home}
      if out=$(printf '%s' "$pw" | agentosctl firstboot --admin "$name" --workspace "$ws" 2>&1); then
        pw=; pw2=
        log "first boot completed for administrator $name"
        echo "完成。正在进入登录界面。Done."
        sleep 2
        exit 0
      fi
      pw=; pw2=
      log "first boot refused: $(printf '%s' "$out" | tail -1)"
      echo "失败 / failed: $(printf '%s' "$out" | tail -1)"; sleep 5
    done
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
  workerUids = { agentos-file = 961; agentos-svc = 962; agentos-net = 963; agentos-serial = 964; };
  workerDefs = {
    file = { dir = "file"; user = "agentos-file"; extra = { ReadWritePaths = [ "/var/lib/agentos-managed" ]; PrivateNetwork = true; PrivateDevices = true; CapabilityBoundingSet = ""; }; };
    service = { dir = "service"; user = "agentos-svc"; extra = { PrivateNetwork = true; PrivateDevices = true; CapabilityBoundingSet = ""; }; };
    # no lab network is registered in the release image, so the network worker gets no capability and no network
    network = { dir = "net"; user = "agentos-net"; extra = { PrivateNetwork = true; CapabilityBoundingSet = ""; }; };
    serial = { dir = "serial"; user = "agentos-serial"; extra = { PrivateNetwork = true; SupplementaryGroups = [ "dialout" ]; }; };
  };
in {
  options.agentos = {
    enable = lib.mkEnableOption "AgentOS";
    graphical = lib.mkOption { type = lib.types.bool; default = true; description = "greetd + Sway + Qt Shell session (off only for headless VM checks)"; };
    releaseImages = lib.mkOption {
      type = lib.types.nullOr lib.types.package; default = null;
      description = "approved OCI images (pkgs.agentos-oci) imported into each workspace's rootless storage instead of being built online; the release sets it";
    };
    # The AgentOS programs of this generation. Only m7's U11 older generation overrides them (an earlier v1.0 commit).
    nativePackage = lib.mkOption { type = lib.types.package; default = pkgs.agentos-native; description = "machined, gateway, broker, workers, agentosctl"; };
    nodePackage = lib.mkOption { type = lib.types.package; default = pkgs.agentos-node; description = "Host, admin tools, runtime adapter"; };
    softwareRendering = lib.mkOption { type = lib.types.bool; default = false; description = "pixman/software rendering for virtual GPUs (QEMU profile)"; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [ { assertion = cfg.graphical -> config.programs.sway.enable; message = "the AgentOS session needs Sway"; } ];
    environment.systemPackages = [ native node ] ++ lib.optionals cfg.graphical [ shell session pkgs.swaylock pkgs.swayidle pkgs.wl-clipboard pkgs.wireplumber ];
    # AgentOS is the only session the greeter offers (programs.sway would add a bare "Sway" session that bypasses the
    # Shell, spec §9.1 "登录后直接进入 AgentOS 全屏画布").
    services.displayManager.sessionPackages = lib.mkIf cfg.graphical (lib.mkForce [ sessionDesktop ]);
    # ReGreet 0.3 has no default session: with nothing remembered for a user it starts that user's login shell. Before
    # each greeting, map every local login account to the AgentOS session in ReGreet's state (review F02/F11: a fresh
    # install or a newly created user would otherwise land in bash instead of the Shell).
    # (greetd runs the command as "exec <command>" under /bin/sh, so the defaults step and the greeter are one script)
    services.greetd.settings.default_session.command = lib.mkIf cfg.graphical (lib.mkForce "${pkgs.writeShellScript "agentos-greeter" ''
      ${greeterDefaults}
      exec ${pkgs.dbus}/bin/dbus-run-session ${lib.getExe pkgs.cage} ${lib.escapeShellArgs config.programs.regreet.cageArgs} -- ${lib.getExe config.programs.regreet.package}
    ''}");
    services.greetd.enable = cfg.graphical;
    # also as root before greetd itself starts (m5 41205165186: the greeter-side run left no state.toml behind)
    systemd.services.greetd.serviceConfig.ExecStartPre = lib.mkIf cfg.graphical [ "+${greeterDefaults}" ];
    programs.regreet.enable = cfg.graphical;
    security.pam.services.swaylock = lib.mkIf cfg.graphical { };
    # Gateway re-authentication of a machine administrator (spec §12.2): plain local unix auth, no other module.
    security.pam.services.agentos-admin-auth = { unixAuth = true; };

    users.mutableUsers = true; # machined owns dynamic accounts (spec §21.2: activation must not reset them)
    # Provider worker accounts have fixed UIDs: the broker policy names them and proves each worker by SO_PEERCRED.
    users.users = lib.mapAttrs (n: uid: { isSystemUser = true; group = n; inherit uid; }) workerUids;
    users.groups = lib.mapAttrs (n: gid: { inherit gid; }) workerUids // { agentos-broker = { }; };

    systemd.tmpfiles.rules = [
      "d /var/lib/agentos 0711 root root -"
      "d /var/lib/agentos/workspaces 0711 root root -"
      "d /var/lib/agentos-runtime 0711 root root -"
      "d /var/lib/agentos-snapshots 0700 root root -"
      "d /run/agentos 0755 root root -"
      "d /run/agentos/workspaces 0711 root root -"
      "d /etc/agentos/broker 0755 root root -"
      "d /var/lib/agentos-managed 0755 agentos-file agentos-file -"
    ];

    # A real root-owned file (not a store symlink): the broker refuses a policy it cannot prove root-only.
    environment.etc."agentos/broker/policy.json".mode = "0444";
    environment.etc."agentos/broker/policy.json".text = builtins.toJSON {
      policyFormat = 1;
      machineInstallId = "machine-registry";
      hosts = [ ];
      managedRoots = [ ];
      units = [ ];
      labNetworks = [ ];
      serial = [ ];
      maintenance = [ ];
      workers = lib.mapAttrs (k: w: { socket = "/run/agentos-worker-${w.dir}/worker.sock"; unit = "agentos-worker-${w.dir}.service"; uid = workerUids.${w.user}; }) workerDefs;
      testMode = false;
    };

    # Provider workers (inherited v0.3 §16): the only writers of their resource class, reached only by the broker.
    systemd.services = lib.mapAttrs' (k: w: lib.nameValuePair "agentos-worker-${w.dir}" {
      description = "AgentOS ${k} worker";
      wantedBy = [ "multi-user.target" ];
      before = [ "agentos-broker.service" ];
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        ExecStart = "${native}/bin/agentos-worker ${k} /run/agentos-worker-${w.dir}/worker.sock";
        User = w.user; Group = w.user; UMask = "0022";
        RuntimeDirectory = "agentos-worker-${w.dir}"; RuntimeDirectoryMode = "0755";
        NoNewPrivileges = true; ProtectSystem = "strict"; ProtectHome = true; PrivateTmp = true;
        RestrictAddressFamilies = [ "AF_UNIX" ] ++ lib.optionals (k == "network") [ "AF_NETLINK" ];
        SystemCallArchitectures = "native"; MemoryMax = "128M"; TasksMax = 64; LimitCORE = 0;
        Restart = "on-failure"; RestartSec = 1;
      } // w.extra;
    }) workerDefs // {
    agentos-first-setup = lib.mkIf cfg.graphical {
      description = "AgentOS first-boot setup on the local console";
      wantedBy = [ "multi-user.target" ];
      wants = [ "agentos-machine.service" ];
      after = [ "agentos-machine.service" "agentos-disk-rekey.service" "systemd-user-sessions.service" ];
      before = [ "display-manager.service" "greetd.service" ];
      unitConfig.ConditionPathExists = "!/var/lib/agentos-machine/machine.secret";
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = firstSetup;
        StandardInput = "tty";
        StandardOutput = "tty";
        StandardError = "journal";
        TTYPath = "/dev/tty1";
        TTYReset = true;
        TTYVHangup = true;
        TTYVTDisallocate = true;
        TimeoutStartSec = "infinity";
      };
    };

    agentos-machine = {
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
        # review F10: least privilege for root machined. It creates and locks accounts (useradd/usermod/passwd/chpasswd
        # write /etc and /home), drops to execution UIDs (setpriv), owns /var/lib/agentos*, moves broker remnants in
        # recovery (/var/lib/agentos-broker), writes machine sets where root asks (/var, /root, /media, /mnt), and talks
        # to logind/systemd/NetworkManager over D-Bus. Nothing else is writable; no network, no kernel or clock access.
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ "/etc" "/home" "/root" "/var" "/run" "-/media" "-/mnt" ];   # "-": a missing directory is skipped (run 41202938788: /media absent → 226/NAMESPACE)
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        RestrictAddressFamilies = [ "AF_UNIX" "AF_NETLINK" ];
        CapabilityBoundingSet = [ "CAP_CHOWN" "CAP_FOWNER" "CAP_DAC_OVERRIDE" "CAP_DAC_READ_SEARCH" "CAP_SETUID" "CAP_SETGID" "CAP_KILL" "CAP_AUDIT_WRITE" ];
        LimitNOFILE = 8192;
        TasksMax = 512;
        MemoryMax = "2G";
      };
    };

    # Every boot (spec §21.2–21.3, V1-U08/U10): resolve an open update from machined's facts and what the loader
    # booted — enter validation on the trial boot, record a rollback, or finish a commit whose intent was recorded
    # (rewriting the default if a crash came before it). No open update: nothing to do. Before any login.
    agentos-update-reconcile = {
      description = "AgentOS update reconciliation at boot";
      wantedBy = [ "multi-user.target" ];
      wants = [ "agentos-machine.service" ];
      after = [ "agentos-machine.service" ];
      before = [ "display-manager.service" ];
      path = [ pkgs.systemd pkgs.coreutils ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        # before first boot or in recovery mode machined has nothing to resolve; that is not a boot failure
        ExecStart = "-${native}/bin/agentosctl update reconcile";
      };
    };

    agentos-session-gateway = {
      description = "AgentOS session gateway";
      wantedBy = [ "multi-user.target" ];
      # wants, not requires: when machined stops or dies the gateway stays up and refuses with STORE_UNAVAILABLE
      # (spec §13.2 "fail closed with a visible reason"); with requires= systemd stopped it and clients saw ECONNREFUSED.
      wants = [ "agentos-machine.service" ];
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

    agentos-broker = {
      description = "AgentOS privileged broker";
      wantedBy = [ "multi-user.target" ];
      after = [ "agentos-machine.service" "dbus.service" ];
      # The broker's log belongs to the machine identity (spec §19.4), which exists only after first boot. Before
      # that the unit is skipped (not failed); agentos-broker.path starts it when machined writes the identity.
      unitConfig.StartLimitIntervalSec = 0;
      unitConfig.ConditionPathExists = "/var/lib/agentos-machine/machine.secret";
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
        # review F10: the broker only writes its own log and socket (State/RuntimeDirectory), reads /etc/agentos and
        # the root policy, and reaches machined, the workers and D-Bus over UNIX sockets. It chowns its socket and
        # connects to worker sockets owned by their own users.
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        RestrictAddressFamilies = [ "AF_UNIX" ];
        CapabilityBoundingSet = [ "CAP_CHOWN" "CAP_FOWNER" "CAP_DAC_OVERRIDE" "CAP_DAC_READ_SEARCH" ];
        LimitNOFILE = 1024;
        TasksMax = 128;
        MemoryMax = "512M";
      };
    };

    };

    systemd.paths.agentos-broker = {
      description = "Start the AgentOS broker once the machine identity exists";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathExists = "/var/lib/agentos-machine/machine.secret";
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
        # the Host's unprivileged native reader (agentos-provider-user); without it every resource probe is
        # "native reader not installed" and maintenance only observes (m17 W09 run 41162223586)
        AGENTOS_NATIVE_BIN = "${native}/bin";
        NODE_ENV = "production";
      } // lib.optionalAttrs (cfg.releaseImages != null) { AGENTOS_RELEASE_IMAGES = "${cfg.releaseImages}"; };
      path = [ pkgs.podman pkgs.util-linux pkgs.coreutils ];
      serviceConfig = {
        ExecStart = "${node}/bin/agentos-host";
        # The workspace's model credential (machine action workspaces.modelCredential.set): 0600, execution UID,
        # outside data/ (no checkpoint/export carries it); settings in it override the defaults above.
        EnvironmentFile = [ "-/var/lib/agentos/workspaces/%i/model.env" ];
        Restart = "on-failure";
        RestartSec = 2;
        # 75: machined refused the start before any database opened (barrier/restore); machined starts it again.
        RestartPreventExitStatus = 75;
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
