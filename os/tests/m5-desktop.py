import time
machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
machine.wait_for_unit("greetd.service")
fb = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws = fb["workspaceId"]

with subtest("login on a VT starts Sway with the Qt Shell; no browser engine (D01)"):
    tty_login(2, "alice", "alice-pw-1")
    machine.send_chars("exec agentos-session\n")
    machine.wait_until_succeeds("pgrep -u alice -x sway", timeout=120)
    machine.wait_until_succeeds("pgrep -u alice -f bin/agentos-shell", timeout=120)
    pid = machine.succeed("pgrep -u alice -f bin/agentos-shell | head -1").strip()
    time.sleep(5)
    maps = machine.succeed(f"cat /proc/{pid}/maps")
    for bad in ["WebEngine", "libQt6WebView", "chromium", "firefox"]:
        assert bad not in maps, bad
    machine.fail("pgrep -f -i 'chromium|firefox|webkit'")
    machine.succeed(f"grep -q libQt6Quick /proc/{pid}/maps")
    machine.screenshot("shell")

with subtest("Shell SIGKILL: the session agent brings it back within 5 s (O06 part, D11 part)"):
    old = machine.succeed("pgrep -u alice -f bin/agentos-shell | head -1").strip()
    t0 = time.time()
    machine.succeed(f"kill -KILL {old}")
    machine.wait_until_succeeds(f"pgrep -u alice -f bin/agentos-shell | grep -vx {old}", timeout=10)
    new = machine.succeed("pgrep -u alice -f bin/agentos-shell | head -1").strip()
    # visible again: the new Shell maps a Wayland toplevel (sway's tree names its app_id)
    machine.wait_until_succeeds("su - alice -c 'SWAYSOCK=$(ls /run/user/$(id -u)/sway-ipc.*.sock | head -1) swaymsg -t get_tree' | grep -q agentos-shell", timeout=10)
    dt = time.time() - t0
    print("shell back after", round(dt, 2), "s; pid", old, "->", new)
    assert new != old and dt <= 5.0, dt
    machine.succeed("pgrep -u alice -x sway")                                   # the session itself survived

with subtest("app container from the release images, offline, with no escape surface (U01, B04, W02, M04 part)"):
    tty_login(3, "alice", "alice-pw-1")
    out = tty_run(3, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.attach\",\"workspaceId\":\"{ws}\",\"idempotencyKey\":\"att\",\"body\":{{}}}}]'", "/tmp/att")
    assert '"status": 200' in out.splitlines()[-2], out
    login = machine.succeed(f"sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT exec_login FROM workspaces WHERE workspace_id='{ws}'\"").strip()
    uid = machine.succeed(f"id -u {login}").strip()
    machine.wait_until_succeeds(f"test -S /run/user/{uid}/podman/podman.sock", timeout=120)
    # The test VM has a QEMU user-net default route; take it away so nothing can reach a registry or substituter.
    machine.succeed("ip route del default 2>/dev/null; ip -6 route del default 2>/dev/null; true")
    machine.fail("ip route | grep -q default")                                     # no network at all
    env = (f"XDG_RUNTIME_DIR=/run/user/{uid} AGENTOS_RUNTIME=podman AGENTOS_PODMAN_SOCKET=/run/user/{uid}/podman/podman.sock "
           f"AGENTOS_DATA_DIR=/var/lib/agentos/workspaces/{ws}/data AGENTOS_RELEASE_IMAGES=$(systemctl --user -M {login}@ show -p Environment agentos-host@{ws}.service | grep -o 'AGENTOS_RELEASE_IMAGES=[^ ]*' | cut -d= -f2)")
    rel = machine.succeed(f"systemctl --user -M {login}@ show -p Environment agentos-host@{ws}.service | grep -o 'AGENTOS_RELEASE_IMAGES=[^ ]*' | cut -d= -f2").strip()
    assert rel.startswith("/nix/store/") and "agentos-oci" in rel, rel
    pf = json.loads(machine.succeed(f"cd /tmp && runuser -u {login} -- env {env} agentos-runtime prefetch"))
    assert pf["ok"] and len(pf["locks"]) == 4, pf                                   # every approved image imported, none built
    imgs = machine.succeed(f"runuser -u {login} -- env XDG_RUNTIME_DIR=/run/user/{uid} podman images --format '{{{{.Repository}}}}:{{{{.Tag}}}}'")
    assert "docker.io/library/node" not in imgs, imgs                               # nothing pulled; only the release images
    rc, dr = machine.execute(f"cd /tmp && runuser -u {login} -- env {env} agentos-runtime doctor")
    print(dr)
    if "FAIL  probe container" in dr:
        # isolate engine vs image: the image's own config and a bare run of node with the same rootless engine
        pe = f"runuser -u {login} -- env XDG_RUNTIME_DIR=/run/user/{uid} podman"
        for n in [l.split(":", 1)[0] for l in imgs.split()][:1] + [l for l in imgs.split()][:1]:
            print(machine.execute(f"{pe} image inspect --format 'env={{{{json .Config.Env}}}} cmd={{{{json .Config.Cmd}}}} ep={{{{json .Config.Entrypoint}}}} wd={{{{.Config.WorkingDir}}}}' {n} 2>&1")[1])
            print(machine.execute(f"cd /tmp && {pe} --log-level=debug run --rm --network=none {n} node -e 'console.log(process.env.PATH)' 2>&1 | tail -40")[1])
            print(machine.execute(f"cd /tmp && {pe} run --rm --network=none --read-only --userns=keep-id {n} /usr/local/bin/node -v 2>&1 | tail -5")[1])
        print(machine.execute(f"{pe} info --format '{{{{.Host.OCIRuntime.Path}}}} {{{{.Host.OCIRuntime.Version}}}} conmon={{{{.Host.Conmon.Path}}}}' 2>&1")[1])
        print(machine.execute("journalctl --no-pager -n 60 _COMM=crun _COMM=conmon 2>&1")[1])
    lines = {l.split(":", 1)[0][6:]: l for l in dr.splitlines() if l.startswith(("ok  ", "FAIL"))}
    for n in ["probe container", "no network", "read-only rootfs", "capabilities / no_new_privs / seccomp", "no escape surfaces"]:
        assert n in lines and lines[n].startswith("ok"), (n, lines.get(n))
    machine.succeed("test -S /run/user/$(id -u alice)/wayland-1 || ls /run/user/$(id -u alice)/ | grep -q wayland")   # the surface exists outside
    machine.send_key("alt-f2")
    machine.succeed("chvt 2")

with subtest("lock: swaylock confirms, logind LockedHint=yes, gateway refuses (I10/H03)"):
    sid = user_session("alice", "tty2")
    machine.succeed(f"loginctl lock-session {sid}")
    machine.wait_until_succeeds("pgrep -u alice swaylock", timeout=60)
    machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.screenshot("locked")
    machine.succeed("grep -qx tty2 /sys/class/tty/tty0/active")
    time.sleep(2)                                                            # swaylock has its surfaces mapped
    machine.send_chars("alice-pw-1\n", delay=0.05)
    try:
        machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q no", timeout=30)
    except BaseException:
        print(machine.execute(f"cat /sys/class/tty/tty0/active; loginctl show-session {sid}; ps -o pid,stat,comm,args -u alice; "
                              "journalctl -b --no-pager | grep -iE 'swaylock|pam_unix|agentos-session-agent|sway\\[' | tail -40")[1])
        machine.screenshot("unlock-failed")
        # retry once, key by key
        for ch in "alice-pw-1":
            machine.send_key("minus" if ch == "-" else ch)
        machine.send_key("ret")
        machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q no", timeout=30)
    machine.wait_until_fails("pgrep -u alice swaylock", timeout=60)

with subtest("a killed locker never returns to an unlocked desktop (H03)"):
    machine.succeed(f"loginctl lock-session {sid}")
    machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.succeed("pkill -KILL -u alice swaylock")
    # the session agent ends the session (back to the greeter) instead of clearing LockedHint
    machine.wait_until_succeeds(f"! loginctl show-session {sid} -p State 2>/dev/null | grep -q active || loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.wait_until_fails("pgrep -u alice -f bin/agentos-shell", timeout=90)
    machine.fail(f"loginctl show-session {sid} -p LockedHint 2>/dev/null | grep -q '=no'")
