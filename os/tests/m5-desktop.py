import time, os, subprocess
machine.start()
machine.wait_for_unit("agentos-session-gateway.service")

# ---- helpers: the real Sway output (QEMU's display of the virtio-gpu scanout) and real input devices ----
def shot(name):
    """Screenshot of the VM display as (w, h, rgb bytes): what Sway actually scanned out."""
    machine.screenshot(name)
    raw = subprocess.run([PNGTOPNM, os.path.join(machine.out_dir, name + ".png")], check=True, capture_output=True).stdout
    return pnm_rgb(raw)

def px(img, x, y):
    w, _, d = img
    k = (y * w + x) * 3
    return tuple(d[k:k + 3])

def near(c, ref, tol=8):
    return all(abs(a - b) <= tol for a, b in zip(c, ref))

def hexc(c):
    return "#%02x%02x%02x" % c

TOPBAR, NAVBG, PRIMARY, BUTTON = (0x1f, 0x29, 0x37), (0xf3, 0xf4, 0xf6), (0xdc, 0xe7, 0xfb), (0xf4, 0xf4, 0xf4)

def click(x, y, w, h):
    """A left click at a screen pixel through the USB tablet (absolute pointer, as a real mouse/touchpad reaches Sway)."""
    ax, ay = round(x * 32767 / (w - 1)), round(y * 32767 / (h - 1))
    qsend = getattr(machine.qmp_client, "send")               # QMP input-send-event (HMP has no absolute pointer)
    qsend("input-send-event", {"events": [{"type": "abs", "data": {"axis": "x", "value": ax}}, {"type": "abs", "data": {"axis": "y", "value": ay}}]})
    time.sleep(0.3)
    qsend("input-send-event", {"events": [{"type": "btn", "data": {"down": True, "button": "left"}}]})
    time.sleep(0.15)
    qsend("input-send-event", {"events": [{"type": "btn", "data": {"down": False, "button": "left"}}]})

def nav_buttons(img):
    """The Shell's navigation buttons, found in the pixels: 1-px grey borders in a column left of the labels."""
    w, h, _ = img
    x, rows, y = 12, [], 0
    while y < h:
        c = px(img, x, y)
        if near(px(img, 3, y), NAVBG) and max(c) < 0xc0 and max(c) - min(c) < 24:            # border grey #9a9a9a (not the dark top bar: it is blue-grey)
            rows.append(y)
        y += 1
    # merge adjacent rows into lines, pair lines into buttons (top border, bottom border)
    lines = []
    for r in rows:
        if lines and r - lines[-1][1] <= 1: lines[-1][1] = r
        else: lines.append([r, r])
    btns = []
    k = 0
    while k + 1 < len(lines):
        top, bot = lines[k][1], lines[k + 1][0]
        if 18 <= bot - top <= 80:
            btns.append((top, bot)); k += 2
        else:
            k += 1
    return btns

def nav_width(img):
    w, h, _ = img
    y = h - 6
    x = 0
    while x < w and near(px(img, x, y), NAVBG, 3): x += 1
    return x

def shell_frame(name, timeout=90):
    """Wait until the Shell's frame is on the real output: dark top bar, light navigation column, 12 nav buttons."""
    end = time.time() + timeout
    while True:
        img = shot(name)
        w, h, _ = img
        ok = near(px(img, w - 4, 3), TOPBAR) and near(px(img, 3, h - 6), NAVBG) and len(nav_buttons(img)) == 12
        if ok or time.time() > end:
            print(name, "top", hexc(px(img, w - 4, 3)), "nav", hexc(px(img, 3, h - 6)), "buttons", nav_buttons(img), "navWidth", nav_width(img))
            assert ok, "the Shell frame is not on the output"
            return img
        time.sleep(3)

def auth_failures():
    return int(machine.succeed("journalctl -b --no-pager -o cat | grep -c 'pam_unix(greetd:auth): authentication failure' || true").strip() or "0")

def greetd_session(user="alice"):
    script = ("for s in $(loginctl list-sessions --no-legend | awk '{print $1}'); do "
              "echo \"$s $(loginctl show-session $s -p Name --value) $(loginctl show-session $s -p Class --value) "
              "$(loginctl show-session $s -p Service --value) $(loginctl show-session $s -p State --value)\"; done")
    for line in machine.succeed(script).splitlines():
        f = line.split() + ["", "", "", ""]
        if f[1] == user and f[2] == "user" and f[3] == "greetd" and f[4] in ("active", "online"):
            return f[0]
    return None

def greeter_diag():
    print(machine.execute("ps -eo pid,user,comm,args | grep -iE 'greet|cage|regreet' | grep -v grep; ls -la /var/lib/regreet /var/log/regreet; "
                          "cat /var/lib/regreet/state.toml; tail -40 /var/log/regreet/log; journalctl -b --no-pager -o short-monotonic "
                          "-u greetd -t agentos-greeter -t agentos-greeter-defaults | tail -60")[1])

def greeter_ready():
    try:
        machine.wait_until_succeeds("pgrep -u greeter -f '[r]egreet'", timeout=120)
    except BaseException:
        greeter_diag()
        raise
    machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active", timeout=60)
    # A running GTK process is not a mapped frame: first-start portal/shader setup can outlive a fixed sleep.
    end = time.time() + 120
    while True:
        img = shot("greeter-ready")
        colours = {px(img, x, y) for x in range(0, img[0], 37) for y in range(0, img[1], 23)}
        if len(colours) > 3:
            return
        if time.time() >= end:
            greeter_diag()
            raise AssertionError(f"greeter output is blank after 120 s: {colours}")
        time.sleep(2)

def type_secret(pw, keywise=False):
    if keywise:                                               # QEMU's fast injection can drop a key (see m5 lock notes)
        for ch in pw:
            machine.send_key("minus" if ch == "-" else ch, delay=0.08)
        machine.send_key("ret")
    else:
        machine.send_chars(pw + "\n", delay=0.08)

def regreet_login(pw):
    """ReGreet: the Login button has the focus (last user/session preselected); Enter, then the password prompt."""
    for attempt in range(3):
        f0 = auth_failures()
        machine.send_key("ret")
        time.sleep(3)
        type_secret(pw, keywise=attempt > 0)
        try:
            machine.wait_until_succeeds("pgrep -u alice -x sway", timeout=120)
            return
        except BaseException:
            machine.screenshot(f"regreet-attempt-{attempt}")
            print(machine.execute("tail -30 /var/log/regreet/log; journalctl -b --no-pager -u greetd | tail -20")[1])
            if auth_failures() > f0 and attempt < 2:
                time.sleep(6)                                 # a dropped key: ReGreet cancelled and shows the user again
                continue
            raise

ws = None
with subtest("first boot from the local console (spec 19.4, review F11): administrator and workspace typed on tty1, then the entry closes"):
    machine.wait_until_succeeds("systemctl show -p ActiveState --value agentos-first-setup.service | grep -qx activating", timeout=180)
    machine.fail("systemctl is-active greetd.service")       # no login screen before the machine has an administrator
    machine.wait_until_tty_matches("1", "administrator login", timeout=180)
    machine.send_chars("alice\n", delay=0.08)
    machine.wait_until_tty_matches("1", "password: ", timeout=60)
    type_secret("alice-pw-1")
    machine.wait_until_tty_matches("1", "password again", timeout=60)
    type_secret("alice-pw-1")
    machine.wait_until_tty_matches("1", "default workspace name", timeout=60)
    machine.send_chars("A\n", delay=0.08)
    machine.wait_until_succeeds("test -e /var/lib/agentos-machine/machine.secret", timeout=180)
    machine.wait_for_unit("greetd.service")
    st = json.loads(machine.succeed("agentosctl status"))
    print("after console first boot", st.get("workspaceList"))
    ws = st["workspaceList"][0]["workspaceId"]
    assert st["workspaceList"][0].get("displayName", "A") == "A", st["workspaceList"]
    machine.succeed("getent passwd alice && id -nG alice")
    machine.fail("journalctl -b --no-pager | grep -F alice-pw-1")   # the password is in no log
    # The setup unit owns tty1 with TTYVHangup=yes. Stop the greeter before testing the closed entry: stopping
    # the old oneshot while a new greeter owns that tty would hang up its PAM session (run 41218400569).
    machine.succeed("systemctl stop greetd.service")
    machine.succeed("systemctl restart agentos-first-setup.service")
    assert machine.succeed("systemctl show -p ConditionResult --value agentos-first-setup.service").strip() == "no"
    machine.succeed("systemctl start greetd.service")

with subtest("ReGreet: a wrong password is refused and the greeter recovers; the right one starts Sway + the Qt Shell through greetd/PAM; no browser engine (D01, review F02)"):
    # Fresh machine: nothing remembered by ReGreet. The greeter wrapper (agentos-greeter-defaults) maps every local
    # account to the AgentOS session, so Enter on the preselected user starts the Shell, not a login shell.
    try:
        machine.wait_until_succeeds("grep -q 'alice = \"AgentOS\"' /var/lib/regreet/state.toml", timeout=120)
    except BaseException:
        print(machine.execute("ls -la /var/lib/regreet; cat /var/lib/regreet/state.toml; journalctl -b --no-pager -o cat -t agentos-greeter-defaults; "
                              "getent passwd | awk -F: '$3>=1000'; systemctl cat greetd | grep -E 'Exec|command'; pgrep -a regreet; tail -20 /var/log/regreet/log")[1])
        raise
    greeter_ready()
    g = shot("greeter")
    assert len({px(g, x, y) for x in range(0, g[0], 37) for y in range(0, g[1], 23)}) > 3, "greeter output is blank"
    f0 = auth_failures()
    machine.send_key("ret")
    time.sleep(3)
    machine.send_chars("wrong-pw-9\n", delay=0.08)
    machine.wait_until_succeeds(f"test $(journalctl -b --no-pager -o cat | grep -c 'pam_unix(greetd:auth): authentication failure') -gt {f0}", timeout=60)
    assert greetd_session() is None
    machine.fail("pgrep -u alice -x sway")
    time.sleep(6)
    machine.screenshot("greeter-after-failure")
    machine.succeed("pgrep -u greeter -f '[r]egreet'")                     # the greeter is still there, ready for the next try
    regreet_login("alice-pw-1")
    machine.wait_until_succeeds("pgrep -u alice -f bin/agentos-shell", timeout=120)
    sid = greetd_session()
    assert sid, machine.succeed("loginctl list-sessions")
    assert machine.succeed(f"loginctl show-session {sid} -p Type --value").strip() == "wayland"
    swaypid = machine.succeed("pgrep -u alice -x sway | head -1").strip()
    machine.succeed(f"grep -q 'session-{sid}.scope' /proc/{swaypid}/cgroup")             # Sway lives in the greetd session
    machine.succeed(f"tr '\\0' ' ' < /proc/{swaypid}/cmdline | grep -q agentos-sway.conf")  # the AgentOS session entry, not typed
    machine.succeed("grep -q 'last_user = \"alice\"' /var/lib/regreet/state.toml && grep -q 'alice = \"AgentOS\"' /var/lib/regreet/state.toml")
    pid = machine.succeed("pgrep -u alice -f bin/agentos-shell | head -1").strip()
    time.sleep(5)
    maps = machine.succeed(f"cat /proc/{pid}/maps")
    for bad in ["WebEngine", "libQt6WebView", "chromium", "firefox"]:
        assert bad not in maps, bad
    machine.fail("pgrep -f -i 'chromium|firefox|webkit'")
    machine.succeed(f"grep -q libQt6Quick /proc/{pid}/maps")

with subtest("real output and input (review F12): the Shell frame in Sway's pixels; a tablet click changes the page; Ctrl+= / Ctrl+0 rescale"):
    img = shell_frame("shell")
    w, h, _ = img
    btns = nav_buttons(img)
    inner = lambda im, b: px(im, 12 + 6, (b[0] + b[1]) // 2)
    assert near(inner(img, btns[0]), PRIMARY), [hexc(inner(img, b)) for b in btns]    # 首页 is the current page
    assert near(inner(img, btns[4]), BUTTON, 6), hexc(inner(img, btns[4]))
    click(75, (btns[4][0] + btns[4][1]) // 2, w, h)                                       # 任务中心
    end = time.time() + 30
    while True:
        img2 = shot("shell-after-click")
        b2 = nav_buttons(img2)
        if (len(b2) == 12 and near(inner(img2, b2[4]), PRIMARY) and not near(inner(img2, b2[0]), PRIMARY)) or time.time() > end:
            break
        time.sleep(2)
    print("after click", [hexc(inner(img2, b)) for b in b2])
    assert len(b2) == 12 and near(inner(img2, b2[4]), PRIMARY) and not near(inner(img2, b2[0]), PRIMARY), "the click did not reach the Shell"
    nw0 = nav_width(img2)
    machine.send_key("ctrl-equal")
    time.sleep(3)
    nw1 = nav_width(shot("shell-zoomed"))
    machine.send_key("ctrl-0")
    time.sleep(3)
    nw2 = nav_width(shot("shell-zoom-reset"))
    print("navigation width", nw0, nw1, nw2)
    assert nw1 > nw0 + 10 and abs(nw2 - nw0) <= 2, (nw0, nw1, nw2)
    click(75, (b2[0][0] + b2[0][1]) // 2, w, h)                                           # back to 首页

with subtest("Shell SIGKILL: the session agent brings it back within 5 s (O06 part, D11 part)"):
    old = machine.succeed("pgrep -u alice -f bin/agentos-shell | head -1").strip()
    t0 = time.time()
    machine.succeed(f"kill -KILL {old}")
    machine.wait_until_succeeds(f"pgrep -u alice -f bin/agentos-shell | grep -vx {old}", timeout=10)
    new = machine.succeed("pgrep -u alice -f bin/agentos-shell | head -1").strip()
    # visible again: sway's tree has a mapped view owned by a new Shell process
    tree = "su - alice -c 'SWAYSOCK=$(ls /run/user/$(id -u)/sway-ipc.*.sock | head -1) swaymsg -t get_tree'"
    shells = "pgrep -u alice -f bin/agentos-shell | grep -vx " + old
    try:
        machine.wait_until_succeeds(f"for p in $({shells}); do {tree} | grep -q \"\\\"pid\\\": $p,\" && exit 0; done; exit 1", timeout=10)
    except BaseException:
        print(machine.execute(f"{shells}; {tree} | grep -E '\"(pid|app_id|name|visible)\"' | head -40")[1])
        raise
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
    machine.send_key("alt-f1")
    machine.succeed("chvt 1")

M = "sqlite3 /var/lib/agentos-machine/machine.sqlite"
B = "sqlite3 /var/lib/agentos-broker/broker.sqlite"
alice_uid = machine.succeed("id -u alice").strip()

def scope(tag):
    """What maintenance may do for workspace A and as whom (review F08): the owner setting, the broker's maintenance
    policies, state, grants, workspace binding and member rows, and the UIDs any workspace process runs as."""
    store, exec_uid, login = machine.succeed(f"{M} \"SELECT store_uuid, execution_uid, exec_login FROM workspaces WHERE workspace_id='{ws}'\"").strip().split("|")
    q = lambda sql: machine.succeed(f"{B} \"{sql}\"").strip()
    hpid = machine.succeed(f"systemctl --user -M {login}@ show -p MainPID --value agentos-host@{ws}.service 2>/dev/null || echo 0").strip() or "0"
    huid = machine.succeed(f"stat -c %u /proc/{hpid} 2>/dev/null || echo none").strip() if hpid != "0" else "none"
    v = {
        "runWhenLoggedOut": machine.succeed(f"{M} \"SELECT run_when_logged_out FROM workspaces WHERE workspace_id='{ws}'\"").strip(),
        "policies": q(f"SELECT policy_id, policy_version, policy_hash, resource_id, action_family, bounds_json, expires_at FROM maintenance_policies WHERE store_uuid='{store}' ORDER BY 1, 2"),
        "maintenanceState": q(f"SELECT state FROM workspace_maintenance_state WHERE store_uuid='{store}'"),
        "grants": q(f"SELECT grant_id, grant_version, principal_json, capability_id, resource_id, limits_json, expires_at FROM broker_grants WHERE store_uuid='{store}' ORDER BY 1, 2"),
        "bindingUid": q(f"SELECT allowed_uid FROM workspace_bindings WHERE store_uuid='{store}'"),
        "members": q(f"SELECT user_id, role, member_version, state FROM machine_members WHERE store_uuid='{store}' ORDER BY 1"),
        "hostUid": huid,
        # every process of this workspace, by UID: none may run as the person who is (or was) logged in
        "workspaceUids": sorted(set(machine.succeed(f"ps -o uid= -u {exec_uid} | sort -u; true").split())),
        "loginUidProcsInWorkspace": machine.succeed(f"for p in $(pgrep -u {alice_uid}); do grep -l 'agentos-host@{ws}' /proc/$p/cgroup 2>/dev/null; done | wc -l").strip(),
    }
    print("scope", tag, json.dumps(v, ensure_ascii=False))
    assert v["runWhenLoggedOut"] == "0", v
    assert v["hostUid"] in ("none", exec_uid), (v["hostUid"], exec_uid)              # the executor is the workspace UID
    assert v["bindingUid"] != alice_uid and exec_uid != alice_uid, v                  # broker binds the workspace UID, not the login
    assert v["loginUidProcsInWorkspace"] == "0", v
    assert alice_uid not in v["grants"], v["grants"]
    return v

def not_wider(a, b, what):
    """b grants nothing a did not: every policy/grant row in b was already in a, members unchanged."""
    for k in ("policies", "grants"):
        extra = set(b[k].splitlines()) - set(a[k].splitlines())
        assert not extra, (what, k, extra)
    assert b["members"] == a["members"], (what, a["members"], b["members"])
    assert b["bindingUid"] in (a["bindingUid"], ""), (what, a["bindingUid"], b["bindingUid"])

with subtest("lock from the Shell (Ctrl+Alt+L): swaylock confirms, logind LockedHint=yes, maintenance scope unchanged (I10/H03, review F08/F12)"):
    sid = greetd_session()
    assert sid
    s_unlocked = scope("unlocked")
    machine.succeed("grep -qx tty1 /sys/class/tty/tty0/active")
    machine.send_key("ctrl-alt-l")                                   # the Shell's shortcut → session agent → swaylock
    machine.wait_until_succeeds("pgrep -u alice swaylock", timeout=60)
    machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    lk = shot("locked")
    assert not near(px(lk, lk[0] - 4, 3), TOPBAR), "the Shell frame is still visible while locked"
    s_locked = scope("locked")
    assert s_locked == s_unlocked, (s_unlocked, s_locked)            # locking neither widens nor changes anything
    time.sleep(2)                                                    # swaylock has its surfaces mapped
    machine.send_chars("alice-pw-1\n", delay=0.05)
    try:
        machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q no", timeout=30)
    except BaseException:
        print(machine.execute(f"cat /sys/class/tty/tty0/active; loginctl show-session {sid}; ps -o pid,stat,comm,args -u alice; "
                              "journalctl -b --no-pager | grep -iE 'swaylock|pam_unix|agentos-session-agent|sway\\[' | tail -40")[1])
        machine.screenshot("unlock-failed")
        type_secret("alice-pw-1", keywise=True)
        machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q no", timeout=30)
    machine.wait_until_fails("pgrep -u alice swaylock", timeout=60)
    shell_frame("unlocked")

with subtest("logout, then log in again through ReGreet: the greeter returns, nothing of the session stays, maintenance scope never widens (D01, W08, review F02/F08)"):
    # the Shell's 注销 goes to the session agent (same path as the lock above); ask the agent as alice, in her session
    rt = f"/run/user/{alice_uid}"
    machine.succeed(f"runuser -u alice -- env XDG_RUNTIME_DIR={rt} python3 -c \"import socket,json,struct;s=socket.socket(socket.AF_UNIX);s.connect('{rt}/agentos-session.sock');b=json.dumps({{'op':'logout'}}).encode();s.sendall(struct.pack('>I',len(b))+b);n=struct.unpack('>I',s.recv(4))[0];print(s.recv(n))\"")
    machine.wait_until_fails("pgrep -u alice -x sway", timeout=60)
    machine.wait_until_fails("pgrep -u alice -f bin/agentos-shell", timeout=60)
    machine.wait_until_succeeds(f"! loginctl show-session {sid} -p State --value 2>/dev/null | grep -qE 'active|online'", timeout=60)
    assert greetd_session() is None
    greeter_ready()
    shot("greeter-after-logout")
    s_out = scope("logged-out")
    not_wider(s_unlocked, s_out, "logout")
    # log in again: ReGreet preselects alice and AgentOS from the state the first login left
    regreet_login("alice-pw-1")
    machine.wait_until_succeeds("pgrep -u alice -f bin/agentos-shell", timeout=120)
    sid2 = greetd_session()
    assert sid2 and sid2 != sid, (sid, sid2)
    shell_frame("relogin")
    time.sleep(5)
    s_again = scope("logged-in-again")
    not_wider(s_unlocked, s_again, "relogin")
    sid = sid2

with subtest("a killed locker never returns to an unlocked desktop (H03)"):
    machine.succeed(f"loginctl lock-session {sid}")
    machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.succeed("pkill -KILL -u alice swaylock")
    # the session agent ends the session (back to the greeter) instead of clearing LockedHint
    machine.wait_until_succeeds(f"! loginctl show-session {sid} -p State 2>/dev/null | grep -q active || loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.wait_until_fails("pgrep -u alice -f bin/agentos-shell", timeout=90)
    machine.fail(f"loginctl show-session {sid} -p LockedHint 2>/dev/null | grep -q '=no'")

with subtest("health gate: false ready, SSH only, no Qt frame and an incompatible workspace each fail; a healthy system passes (U09)"):
    machine.wait_for_unit("greetd.service")
    HG = "agentos-update-worker health --state-dir /var/lib/agentos-machine"
    def gate(prefix="", extra="", bg=None):
        cmd = f"{prefix} {HG} {extra}"
        if bg:
            machine.succeed(f"({cmd} > {bg} 2>&1; echo done >> {bg}) >/dev/null 2>&1 &")
            return None
        out = machine.succeed(cmd + " 2>&1")
        return json.loads(out.strip().splitlines()[-1])["result"]
    def bg_result(f):
        machine.wait_until_succeeds(f"grep -q '^done$' {f}", timeout=400)
        return json.loads(machine.succeed(f"grep '^{{' {f} | tail -1"))["result"]
    st = json.loads(machine.succeed("agentosctl status"))
    print("workspaceList", st.get("workspaceList"))
    assert any(w["workspaceId"] == ws and w["schemaVersion"] is not None for w in st["workspaceList"]), st
    # positive control first: every probe green for 60 s
    ok = gate()
    print("healthy run", ok)
    assert ok["healthy"] is True, ok
    # Qt renders no frame (the probe's canvas process fails) and a workspace outside the release's schema range:
    # independent, run side by side
    machine.succeed("mkdir -p /tmp/noqt && printf '#!/bin/sh\\nexit 1\\n' > /tmp/noqt/agentos-shell && chmod +x /tmp/noqt/agentos-shell")
    gate(prefix="PATH=/tmp/noqt:$PATH", bg="/tmp/hg-noqt")
    gate(extra="--schema-min 6 --schema-max 6", bg="/tmp/hg-schema")
    r1, r2 = bg_result("/tmp/hg-noqt"), bg_result("/tmp/hg-schema")
    print(r1, r2)
    assert r1["healthy"] is False and "shell_canvas" in json.dumps(r1["failing"]), r1
    assert r2["healthy"] is False and "workspaces_compatible" in json.dumps(r2["failing"]), r2
    # false ready: the broker unit stays active (systemd says ready) but its identity socket is gone
    machine.succeed("mv /run/agentos-broker/broker.sock /run/agentos-broker/broker.sock.hidden")
    machine.succeed("systemctl is-active agentos-broker.service")
    r3 = gate()
    machine.succeed("mv /run/agentos-broker/broker.sock.hidden /run/agentos-broker/broker.sock")
    print(r3)
    assert r3["healthy"] is False and "broker_identity" in json.dumps(r3["failing"]), r3
    # review R2-2: the broker in diagnostics-only mode (its log lost) keeps its socket and its unit active, and must
    # still fail the gate: readiness is read through the broker protocol (broker-health), not from the socket
    machine.succeed("systemctl stop agentos-broker.path agentos-broker.service; mkdir -p /root/broker-keep; mv /var/lib/agentos-broker/broker.sqlite* /root/broker-keep/")
    machine.succeed("systemctl start agentos-broker.service")
    machine.wait_until_succeeds("journalctl -u agentos-broker -b --no-pager | grep -q 'diagnostics-only mode'", timeout=60)
    machine.succeed("systemctl is-active agentos-broker.service && test -S /run/agentos-broker/broker.sock")
    r5 = gate()
    print("diagnostics-only broker", r5)
    assert r5["healthy"] is False and "broker_identity" in json.dumps(r5["failing"]) and "diagnostics-only" in json.dumps(r5["failing"]), r5
    machine.succeed("systemctl stop agentos-broker.service; mv /root/broker-keep/broker.sqlite* /var/lib/agentos-broker/; systemctl start agentos-broker.service agentos-broker.path")
    machine.wait_for_unit("agentos-broker.service")
    # review R2-2: greetd active is not a frame: the greeter session on seat0 must have a compositor answering. Hide the
    # greeter's Wayland socket (greetd and the session stay up) and the gate fails on greeter_frame.
    gs = machine.succeed("{ for s in $(loginctl list-sessions --no-legend | awk '{print $1}'); do [ \"$(loginctl show-session $s -p Class --value)\" = greeter ] && loginctl show-session $s -p User --value; done; true; } | head -1").strip()
    print("greeter uid", gs)
    assert gs, machine.succeed("loginctl list-sessions")
    socks = machine.succeed(f"ls /run/user/{gs} | grep '^wayland-[0-9]*$'").split()
    for w in socks:
        machine.succeed(f"mv /run/user/{gs}/{w} /run/user/{gs}/hidden-{w}")
    machine.succeed("systemctl is-active greetd.service")
    r6 = gate()
    for w in socks:
        machine.succeed(f"mv /run/user/{gs}/hidden-{w} /run/user/{gs}/{w}")
    print("greeter without a compositor socket", r6)
    assert r6["healthy"] is False and "greeter_frame" in json.dumps(r6["failing"]) and "Wayland" in json.dumps(r6["failing"]), r6
    # SSH only: the system answers a remote shell but no greeter and no machined
    machine.succeed("systemctl stop greetd.service agentos-machine.service")
    r4 = gate()
    print(r4)
    assert r4["healthy"] is False and "greeter_frame" in json.dumps(r4["failing"]) and "machine_identity" in json.dumps(r4["failing"]), r4
