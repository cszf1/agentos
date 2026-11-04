# m20-sway (see m20-sway.nix). The driver answers the e2e's E2E-ASK requests with real QMP input and reads back what
# Sway scanned out and what the Host stored. Everything the e2e asserts is also printed as "E2E <step> <json>".
import os, re, shlex, subprocess, tempfile
machine.start()
machine.wait_for_unit("agentos-session-gateway.service")

def copy_text_to_guest(path, text):
    # copy_from_host uses the shared directory, not one bash -c argument containing all the base64 data.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as src:
        src.write(text)
        src.flush()
        machine.copy_from_host(src.name, path)
    machine.succeed(f"chmod 0644 {shlex.quote(path)}")

def shot(name):
    machine.screenshot(name)
    raw = subprocess.run([PNGTOPNM, os.path.join(machine.out_dir, name + ".png")], check=True, capture_output=True).stdout
    return pnm_rgb(raw)

def px(img, x, y):
    w, _, d = img
    k = (y * w + x) * 3
    return tuple(d[k:k + 3])

def near(c, ref, tol=8):
    return all(abs(a - b) <= tol for a, b in zip(c, ref))

TOPBAR, NAVBG = (0xff, 0xff, 0xff), (0xff, 0xff, 0xff)
SCREEN = [0, 0]

def qsend(cmd, args):
    return getattr(machine.qmp_client, "send")(cmd, args)

def pointer(x, y):
    w, h = SCREEN
    qsend("input-send-event", {"events": [{"type": "abs", "data": {"axis": "x", "value": round(x * 32767 / (w - 1))}}, {"type": "abs", "data": {"axis": "y", "value": round(y * 32767 / (h - 1))}}]})

def button(b, down):
    qsend("input-send-event", {"events": [{"type": "btn", "data": {"down": down, "button": b}}]})

def real_click(x, y, times=1):
    pointer(x, y)
    time.sleep(0.3)
    for k in range(times):
        button("left", True); time.sleep(0.06); button("left", False)
        if k + 1 < times:
            time.sleep(0.08)

def type_secret(pw, keywise=False):
    if keywise:
        for ch in pw:
            machine.send_key("minus" if ch == "-" else ch, delay=0.08)
        machine.send_key("ret")
    else:
        machine.send_chars(pw + "\n", delay=0.08)

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

def regreet_login(pw):
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
            if auth_failures() > f0 and attempt < 2:
                time.sleep(6)
                continue
            raise

def nav_buttons(img):
    """Find the 12 sidebar tabs by their full-height navigation rails, excluding toolbar controls."""
    w, h, _ = img
    # ATab's 3 px rail is muted (#94a3b8), accent (#2563eb) for the current page.
    # x=17 crosses the rail but lies outside label/icon text and the workspace selector's border.
    rows = [y for y in range(h) if near(px(img, 3, y), NAVBG) and (
        near(px(img, 17, y), (0x94, 0xa3, 0xb8), 3)
        or near(px(img, 17, y), (0x25, 0x63, 0xeb), 3))]
    lines = []
    for r in rows:
        if lines and r - lines[-1][1] <= 1: lines[-1][1] = r
        else: lines.append([r, r])
    return [(top, bot) for top, bot in lines if 18 <= bot - top <= 80]


def shell_frame(name, timeout=120):
    end = time.time() + timeout
    while True:
        img = shot(name)
        w, h, _ = img
        ok = near(px(img, w - 4, 3), TOPBAR) and near(px(img, 3, h - 6), NAVBG) and len(nav_buttons(img)) == 12
        if ok or time.time() > end:
            assert ok, f"{name}: the Shell frame is not on the output"
            return img
        time.sleep(1)

with subtest("first boot on the console, a second workspace and a member to revoke later, then ReGreet login into Sway"):
    machine.wait_until_tty_matches("1", "administrator login", timeout=240)
    machine.send_chars("alice\n", delay=0.08)
    machine.wait_until_tty_matches("1", "password: ", timeout=60)
    type_secret("alice-pw-1")
    machine.wait_until_tty_matches("1", "password again", timeout=60)
    type_secret("alice-pw-1")
    machine.wait_until_tty_matches("1", "default workspace name", timeout=60)
    machine.send_chars("A\n", delay=0.08)
    machine.wait_until_succeeds("test -e /var/lib/agentos-machine/first-boot-closed", timeout=180)
    machine.wait_for_unit("greetd.service")
    ws = json.loads(machine.succeed("agentosctl status"))["workspaceList"][0]["workspaceId"]
    machine.wait_for_unit("agentos-broker.service")
    # Cage takes VT1 when its backend starts. Let it finish before typing into VT3, otherwise the password
    # can land in the greeter instead of login (the getty waited out its 60 s password timeout in 41218403903).
    greeter_ready()
    tty_login(3, "alice", "alice-pw-1")
    # (members_lib.make_user works on tty1, which is the greeter here)
    p = call(3, [{"methodId": "machine.users.create", "idempotencyKey": str(uuid.uuid4()), "body": {"loginName": "bob", "role": "user", "password": "bob-pw-1"}}], "ubp")[0]
    assert p["status"] == 201, p
    c = call(3, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], "ubc")[0]
    assert '"succeeded"' in json.dumps(c), c
    bob = sql("SELECT user_id FROM users WHERE login_name='bob'")
    # A new member MUST first be a viewer; promotion is a separate authorized change, not an invitation bypass.
    r = call(3, [{"methodId": "members.setRole", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "viewer"}}], "mbv")[0]
    assert r["status"] == 200, r
    mv = int(sql(f"SELECT member_version FROM workspace_members WHERE workspace_id='{ws}' AND user_id='{bob}'"))
    r = call(3, [{"methodId": "members.setRole", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "editor", "expectedMemberVersion": mv}}], "mb")[0]
    assert r["status"] == 200, r
    r = call(3, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "B"}}], "cb")[0]
    assert r["status"] == 201, r
    ws_b = r["body"]["workspaceId"]
    r = call(3, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "att")[0]
    assert r["status"] == 200, r
    OS = f"/var/lib/agentos/workspaces/{ws}/data/os.sqlite"
    machine.wait_until_succeeds(f"test -s {OS}", timeout=120)
    machine.succeed("pkill -KILL -t tty3 || true; chvt 1")
    machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active", timeout=30)
    greeter_ready()
    regreet_login("alice-pw-1")
    machine.wait_until_succeeds("pgrep -u alice -f bin/agentos-shell", timeout=120)
    sid = greetd_session()
    assert sid, machine.succeed("loginctl list-sessions")
    img = shell_frame("shell")
    SCREEN[0], SCREEN[1] = img[0], img[1]
    alice_uid = machine.succeed("id -u alice").strip()

def hsql(q):
    return machine.succeed(f"sqlite3 {OS} \"{q}\"").strip()

def msql(q):
    return machine.succeed(f"sqlite3 /var/lib/agentos-machine/machine.sqlite \"{q}\"").strip()

D = "/tmp/agentos-e2e-sway"
RT = f"/run/user/{alice_uid}"

def as_alice(cmd):
    way = machine.succeed(f"ls {RT} | grep -E '^wayland-[0-9]+$' | head -1").strip()
    return f"runuser -u alice -- env XDG_RUNTIME_DIR={RT} WAYLAND_DISPLAY={way} {cmd}"

# D12's disk scan. grep -r as root fails on FUSE mounts it may not stat (the document portal at $RT/doc after a login
# gives EACCES, and find -xdev or -prune stats the mountpoint first), and alice cannot read all of $RT (systemd's
# mode-0000 inaccessible nodes). So root walks every path except the FUSE mounts, naming entries without stat()ing
# them, and alice walks those mounts. The report says what was found, what failed and what was skipped.
DISK_SCAN = r"""
import json, os, sys
spec = json.loads(sys.argv[1])
marker, skip = spec["marker"].encode(), set(spec["skip"])
rep = {"found": [], "errors": [], "skipped": [], "dirs": 0, "files": 0}
def has_marker(path):
    keep, tail = len(marker) - 1, b""
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            if marker in tail + chunk:
                return True
            tail = (tail + chunk)[-keep:] if keep else b""
    return False
todo = list(reversed(spec["roots"]))
while todo:
    d = todo.pop()
    if d in skip:
        rep["skipped"].append(d); continue
    try:
        entries = sorted(os.scandir(d), key=lambda e: e.name)
    except OSError as x:
        rep["errors"].append(f"{d}: {x.strerror or x}"); continue
    rep["dirs"] += 1
    for e in entries:
        try:
            if e.path in skip:
                rep["skipped"].append(e.path)
            elif e.is_dir(follow_symlinks=False):
                todo.append(e.path)
            elif e.is_file(follow_symlinks=False):
                rep["files"] += 1
                if has_marker(e.path):
                    rep["found"].append(e.path)
        except OSError as x:
            rep["errors"].append(f"{e.path}: {x.strerror or x}")
print(json.dumps(rep))
sys.exit(0 if rep["found"] else 2 if rep["errors"] else 1)
"""
SCAN = "/tmp/agentos-d12-scan"

def fuse_mounts(mountinfo, roots):
    found = set()
    for line in mountinfo.splitlines():
        f = line.split()
        fstype = f[f.index("-") + 1]
        target = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), f[4])
        if (fstype == "fuse" or fstype.startswith("fuse.")) and any(target == r or target.startswith(r + "/") for r in roots):
            found.add(target)
    return sorted(found)

def disk_scan(user, roots, skip, marker):
    """('found' | 'clean' | 'error', report or reason). Only a well-formed report with nothing found, no error and an
    empty stderr is clean."""
    cmd = f"python3 {SCAN}.py {shlex.quote(json.dumps({'marker': marker, 'roots': roots, 'skip': skip}))}"
    if user != "root":
        cmd = f"runuser -u {user} -- {cmd}"
    rc, out = machine.execute(f"{cmd} 2>{SCAN}.{user}.err")
    err = machine.succeed(f"cat {SCAN}.{user}.err")
    print(f"D12 {user} scan of {roots} (skip {skip}): rc={rc} report={out.strip()} stderr={err.strip()!r}")
    try:
        rep = json.loads(out)
    except ValueError:
        return "error", f"{user}: no report (rc={rc}, stderr={err.strip()!r})"
    if rep["found"]:
        return "found", rep
    if rc != 1 or rep["errors"] or err.strip():
        return "error", f"{user}: rc={rc} errors={rep['errors']} stderr={err.strip()!r}"
    return "clean", rep

def lock():
    machine.succeed(f"loginctl lock-session {sid}")
    machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.wait_until_succeeds("pgrep -u alice swaylock", timeout=60)
    time.sleep(2)

def unlock():
    machine.send_chars("alice-pw-1\n", delay=0.06)
    try:
        machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q no", timeout=30)
    except BaseException:
        type_secret("alice-pw-1", keywise=True)
        machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q no", timeout=30)
    machine.wait_until_fails("pgrep -u alice swaylock", timeout=60)
    time.sleep(2)

burst = {}

def handle(n, a):
    k = a["kind"]
    if k in ("click", "dblclick"):
        real_click(a["x"], a["y"], 2 if k == "dblclick" else 1)
        return {}
    if k == "type":
        machine.send_chars(a["text"], delay=0.06)
        return {}
    if k == "keys":
        for key in a["keys"]:
            machine.send_key(key, delay=0.15)
        return {}
    if k == "wheel":
        pointer(a["x"], a["y"])
        time.sleep(0.2)
        b = "wheel-down" if a.get("down", True) else "wheel-up"
        for _ in range(int(a.get("n", 1))):
            button(b, True); button(b, False); time.sleep(0.03)
        return {}
    if k == "failed-click":
        print("E2E-DIAG failed-click", json.dumps(a, ensure_ascii=False))
        log_failure_screen(machine, "sway-live-failed-click")
        return {}
    if k == "shot":
        img = shot(f"e2e-{n:03d}-{a.get('name', 'shot')}")
        return {"w": img[0], "h": img[1], "px": [list(px(img, x, y)) for x, y in a["points"]]}
    if k == "do":
        w = a["what"]
        if w == "count":
            return {"count": int(hsql(f"SELECT COUNT(*) FROM records WHERE app_id='{a['appId']}' AND instr(data_json, '{a['text']}') > 0"))}
        if w == "record":
            return {"rows": hsql(f"SELECT data_json FROM records WHERE app_id='{a['appId']}' AND instr(data_json, '{a['text']}') > 0").splitlines()}
        if w == "background-policy":
            return {"enabled": int(msql(f"SELECT run_when_logged_out FROM workspaces WHERE workspace_id='{ws}'"))}
        if w == "plan":
            ph = a["planHash"]
            return {"rows": msql(f"SELECT kind || '|' || state || '|' || effect_certainty || '|' || ticket_used FROM machine_operations WHERE plan_hash='{ph}'").splitlines()}
        if w == "lock":
            lock(); return {}
        if w == "unlock":
            unlock(); return {}
        if w == "restart-gateway":
            machine.succeed("systemctl restart agentos-session-gateway.service")
            machine.wait_for_unit("agentos-session-gateway.service")
            return {}
        if w == "burst-prepare":
            app = a["appId"]
            ep = int(hsql(f"SELECT epoch FROM apps WHERE id='{app}'"))
            reqs: list[dict[str, object]] = [{"methodId": "session.bind"}]
            for i in range(300):
                reqs.append(fwd(ws, "apps.records.post", {"expectedAppEpoch": ep, "data": {"title": f"burst-{i}", "done": False}}, params={"appId": app}, idem=f"burst-{i}"))
            rid = str(uuid.uuid4())
            reqs.append({"methodId": "members.revoke", "workspaceId": ws, "idempotencyKey": rid, "body": {"userId": bob}})
            body = json.dumps(reqs, ensure_ascii=False)
            copy_text_to_guest(f"{D}/burst.json", body)
            burst.update(rid=rid, n=len(reqs), recs0=int(hsql(f"SELECT COUNT(*) FROM records WHERE app_id='{app}'")), app=app)
            return {"file": f"{D}/burst.json"}
        if w == "burst-wait":
            machine.wait_until_succeeds(f"test $(grep -c '^{{' {D}/burst.out 2>/dev/null || echo 0) -ge {burst['n']}", timeout=300)
            wait_revoked(burst["rid"], timeout=120)
            lines = [json.loads(l) for l in machine.succeed(f"cat {D}/burst.out").splitlines() if l.startswith("{")]
            return {"responses": len(lines), "ok": sum(1 for l in lines if l.get("status") in (200, 201)), "revoke": lines[-1].get("status"),
                    "records": int(hsql(f"SELECT COUNT(*) FROM records WHERE app_id='{burst['app']}'")) - burst["recs0"],
                    "revocation": msql(f"SELECT state FROM revocations WHERE revocation_id='{burst['rid']}'")}
        if w == "model-off":
            machine.succeed("echo AGENTOS_MODEL_MODE=real > /run/agentos-test/model.env"); return {}
        if w == "model-on":
            machine.succeed("echo AGENTOS_MODEL_MODE=faux > /run/agentos-test/model.env"); return {}
        if w == "broker-stop":
            # agentos-broker.path re-starts the service the moment it stops (m20 41314773240@6a3b16f: back within 0.43s), so the
            # outage the Shell must show only exists while the path unit is held too.
            machine.succeed("systemctl stop agentos-broker.path agentos-broker.service")
            machine.succeed("sleep 2; ! systemctl is-active --quiet agentos-broker.service && test ! -S /run/agentos-broker/broker.sock")
            return {}
        if w == "broker-start":
            machine.succeed("systemctl start agentos-broker.service agentos-broker.path")
            machine.wait_for_unit("agentos-broker.service")
            return {}
        if w == "clipboard":
            rc, out = machine.execute(as_alice("wl-paste -n") + " 2>/dev/null")
            return {"rc": rc, "text": out if rc == 0 else ""}
        raise Exception(f"unknown do {w}")
    raise Exception(f"unknown ask {k}")

def ack(n, v):
    machine.succeed(f"echo {base64.b64encode(json.dumps(v).encode()).decode()} | base64 -d > {D}/ack-{n}.tmp && chmod 0644 {D}/ack-{n}.tmp && mv {D}/ack-{n}.tmp {D}/ack-{n}")

steps = {}
with subtest("agentos-shell-e2e as a real Wayland client in alice's Sway session, driven by real input (D02-D07, D09, D11, D12)"):
    machine.succeed(f"rm -rf {D} && mkdir -m 1777 {D} && touch {D}/out.log && chown alice {D}/out.log")
    run = (f"#!/bin/sh\ncd {D} && exec env QT_QPA_PLATFORM=wayland AGENTOS_E2E_PHASE=sway AGENTOS_E2E_ASK_DIR={D} AGENTOS_E2E_WS_B={ws_b} "
           f"QTEST_FUNCTION_TIMEOUT=5400000 sh -c '{E2E} -maxwarnings 0 sway; echo rc=$?; echo done' >> {D}/out.log 2>&1\n")
    machine.succeed(f"echo {base64.b64encode(run.encode()).decode()} | base64 -d > {D}/run.sh && chmod 0755 {D}/run.sh")
    sock = machine.succeed(f"ls {RT}/sway-ipc.*.sock | head -1").strip()
    machine.succeed(f"runuser -u alice -- env XDG_RUNTIME_DIR={RT} SWAYSOCK={sock} swaymsg exec {D}/run.sh")
    seen, t0, text = 0, time.time(), ""
    try:
        machine.wait_until_succeeds("pgrep -u alice -f bin/agentos-shell-e2e", timeout=60)
        pid = machine.succeed("pgrep -u alice -f bin/agentos-shell-e2e | head -1").strip()
        machine.succeed(f"grep -q 'session-{sid}.scope' /proc/{pid}/cgroup")  # still the real greetd login
        while time.time() - t0 < 5400:
            text = machine.succeed(f"cat {D}/out.log")
            for m in re.finditer(r"^E2E-ASK (\d+) (.*)$", text, re.M):
                n = int(m.group(1))
                if n <= seen:
                    continue
                a = json.loads(m.group(2))
                print(f"ASK {n} {a.get('kind')} {a.get('what', '')} {a.get('name', '')}".strip())
                ack(n, handle(n, a))
                seen = n
            if re.search(r"^done$", text, re.M):
                break
            time.sleep(0.4)
    finally:
        text = machine.succeed(f"cat {D}/out.log")
        print("\n".join(l for l in text.splitlines() if not l.startswith("E2E-ASK"))[-20000:])
        if not re.search(r"^rc=0$", text, re.M):
            try:
                log_failure_screen(machine, "sway-e2e-failure")
            except Exception as e:
                print("failure screenshot unavailable:", e)
        machine.copy_from_vm(D, "")
    for l in text.splitlines():
        if l.startswith("E2E "):
            k, _, v = l[4:].partition(" ")
            steps[k] = json.loads(v)
    print("steps", sorted(steps))
    assert "rc=0" in text, "agentos-shell-e2e sway failed"
    for k in ["bound", "frame", "generated", "doubleClick", "crud", "version", "injection", "paging", "components", "invalidTree", "lists", "trusted", "slowReader", "degrade", "privacy", "done"]:
        assert k in steps, (k, sorted(steps))
    assert steps["bound"]["platform"] == "wayland"

with subtest("Host database agrees with what the e2e saw (D02, D04, D05, D07, D09)"):
    todo = steps["generated"]["appId"]
    assert hsql(f"SELECT COUNT(*) FROM records WHERE app_id='{todo}' AND instr(data_json, 'dup-2') > 0") == "0"   # double-click made one, delete removed it
    milk = json.loads(hsql(f"SELECT data_json FROM records WHERE app_id='{todo}' AND instr(data_json, 'milk-1') > 0"))
    assert milk["done"] is True, milk
    prio = json.loads(hsql(f"SELECT data_json FROM records WHERE app_id='{todo}' AND instr(data_json, 'prio-3') > 0"))
    assert prio.get("priority") == "high", prio                                             # kept while v1 hid the field
    assert "优先级" not in steps["version"]["headersV1"], steps["version"]
    evil = "<b>bold</b><img src=http://x.example/a.png> Qt.quit() file:///etc/passwd javascript:alert(1) {{x}} ${y}"
    titles = [json.loads(x)["title"] for x in hsql(f"SELECT data_json FROM records WHERE app_id='{todo}' AND instr(data_json, 'x.example') > 0").splitlines()]
    assert titles == [evil], titles
    print("D07 plan", steps["trusted"]["op"])
    assert steps["trusted"]["op"]["rows"] == ["workspaces.runWhenLoggedOut|succeeded|applied|1"], steps["trusted"]
    restored = steps["trusted"]["restoredPlan"]
    assert msql(f"SELECT kind || '|' || state || '|' || effect_certainty || '|' || ticket_used FROM machine_operations WHERE plan_hash='{restored}'") == "workspaces.runWhenLoggedOut|succeeded|applied|1"
    assert msql(f"SELECT run_when_logged_out FROM workspaces WHERE workspace_id='{ws}'") == "0"
    # the withdrawn (locked) plan was never confirmed: it stays planned or expires, never runs
    stale = steps["trusted"]["stalePlan"]
    st = msql(f"SELECT state || '|' || ticket_used FROM machine_operations WHERE plan_hash='{stale}'")
    print("D07 stale plan", st)
    assert all(x.split("|")[0] in ("planned", "expired_no_effect", "cancelled_no_effect") and x.split("|")[1] == "0" for x in st.splitlines()), st
    sr = steps["slowReader"]
    print("D09", sr)
    assert sr["driver"]["records"] == 300 and sr["driver"]["revocation"] == "revoked", sr

with subtest("the real Shell after the e2e: SIGKILL → visible again within 5 s (D11), logout + login leaves no draft or clipboard (D12)"):
    machine.wait_until_fails("pgrep -u alice -f bin/agentos-shell-e2e", timeout=60)
    old = machine.succeed("pgrep -u alice -f bin/agentos-shell | head -1").strip()
    machine.succeed(f"kill -KILL {old}")
    t0 = time.time()
    machine.wait_until_succeeds(f"pgrep -u alice -f bin/agentos-shell | grep -vx {old}", timeout=10)
    shell_frame("shell-restarted", timeout=15)
    dt = time.time() - t0
    print(f"D11 Shell visible again after {dt:.1f} s")
    assert dt <= 5.0 + 1.5, dt     # screenshot and pixel scan included
    marker = steps["privacy"]["marker"]
    rt = RT
    machine.succeed(f"runuser -u alice -- env XDG_RUNTIME_DIR={rt} python3 -c \"import socket,json,struct;s=socket.socket(socket.AF_UNIX);s.connect('{rt}/agentos-session.sock');b=json.dumps({{'op':'logout'}}).encode();s.sendall(struct.pack('>I',len(b))+b);n=struct.unpack('>I',s.recv(4))[0];print(s.recv(n))\"")
    machine.wait_until_fails("pgrep -u alice -x sway", timeout=60)
    greeter_ready()
    regreet_login("alice-pw-1")
    machine.wait_until_succeeds("pgrep -u alice -f bin/agentos-shell", timeout=120)
    sid = greetd_session()
    shell_frame("relogin")
    rc, clip = machine.execute(as_alice("wl-paste -n") + " 2>/dev/null")
    assert marker not in clip, clip
    copy_text_to_guest(f"{SCAN}.py", DISK_SCAN)
    roots = ["/home/alice", "/var/lib/agentos", f"/run/user/{alice_uid}"]
    fuse = fuse_mounts(machine.succeed("cat /proc/self/mountinfo"), roots)
    print("D12 FUSE mounts scanned as alice, not root:", fuse)
    scans = {"root": disk_scan("root", roots, fuse, marker)}
    if fuse:
        scans["alice"] = disk_scan("alice", fuse, [], marker)
    found = {u: r["found"] for u, (v, r) in scans.items() if v == "found"}
    assert not found, f"the draft marker is on disk: {found}"
    errors = {u: r for u, (v, r) in scans.items() if v == "error"}
    assert not errors, f"D12 disk scan failed, so it proves nothing: {errors}"
    assert all(scans["root"][1]["skipped"].count(m) == 1 for m in fuse), scans["root"]
    if fuse:
        assert scans["alice"][1]["dirs"] >= len(fuse), scans["alice"]
