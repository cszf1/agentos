# m20-sway (see m20-sway.nix). The driver answers the e2e's E2E-ASK requests with real QMP input and reads back what
# Sway scanned out and what the Host stored. Everything the e2e asserts is also printed as "E2E <step> <json>".
import base64, os, re, subprocess, time, uuid
machine.start()
machine.wait_for_unit("agentos-session-gateway.service")

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

TOPBAR, NAVBG = (0x1f, 0x29, 0x37), (0xf3, 0xf4, 0xf6)
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
        machine.wait_until_succeeds("pgrep -x regreet || pgrep -f bin/regreet", timeout=120)
    except BaseException:
        greeter_diag()
        raise
    machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active", timeout=60)
    time.sleep(8)

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

def shell_frame(name, timeout=120):
    end = time.time() + timeout
    while True:
        img = shot(name)
        w, h, _ = img
        ok = near(px(img, w - 4, 3), TOPBAR) and near(px(img, 3, h - 6), NAVBG)
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
    machine.wait_until_succeeds("test -e /var/lib/agentos-machine/machine.secret", timeout=180)
    machine.wait_for_unit("greetd.service")
    ws = json.loads(machine.succeed("agentosctl status"))["workspaceList"][0]["workspaceId"]
    machine.wait_for_unit("agentos-broker.service")
    tty_login(3, "alice", "alice-pw-1")
    # (members_lib.make_user works on tty1, which is the greeter here)
    p = call(3, [{"methodId": "machine.users.create", "idempotencyKey": str(uuid.uuid4()), "body": {"loginName": "bob", "role": "user", "password": "bob-pw-1"}}], "ubp")[0]
    assert p["status"] == 201, p
    c = call(3, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], "ubc")[0]
    assert '"succeeded"' in json.dumps(c), c
    bob = sql("SELECT user_id FROM users WHERE login_name='bob'")
    r = call(3, [{"methodId": "members.setRole", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "editor"}}], "mb")[0]
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
    if k == "shot":
        img = shot(f"e2e-{n:03d}-{a.get('name', 'shot')}")
        return {"w": img[0], "h": img[1], "px": [list(px(img, x, y)) for x, y in a["points"]]}
    if k == "do":
        w = a["what"]
        if w == "count":
            return {"count": int(hsql(f"SELECT COUNT(*) FROM records WHERE app_id='{a['appId']}' AND instr(data_json, '{a['text']}') > 0"))}
        if w == "record":
            return {"rows": hsql(f"SELECT data_json FROM records WHERE app_id='{a['appId']}' AND instr(data_json, '{a['text']}') > 0").splitlines()}
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
            machine.succeed(f"echo {base64.b64encode(body.encode()).decode()} | base64 -d > {D}/burst.json && chmod 0644 {D}/burst.json")
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
            machine.succeed("systemctl stop agentos-broker.service"); return {}
        if w == "broker-start":
            machine.succeed("systemctl start agentos-broker.service")
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
           f"QTEST_FUNCTION_TIMEOUT=5400000 sh -c 'agentos-shell-e2e -maxwarnings 0 sway; echo rc=$?; echo done' >> {D}/out.log 2>&1\n")
    machine.succeed(f"echo {base64.b64encode(run.encode()).decode()} | base64 -d > {D}/run.sh && chmod 0755 {D}/run.sh")
    sock = machine.succeed(f"ls {RT}/sway-ipc.*.sock | head -1").strip()
    machine.succeed(f"runuser -u alice -- env XDG_RUNTIME_DIR={RT} SWAYSOCK={sock} swaymsg exec {D}/run.sh")
    machine.wait_until_succeeds(f"pgrep -u alice -x agentos-shell-e2e || pgrep -u alice -f bin/agentos-shell-e2e", timeout=60)
    pid = machine.succeed("pgrep -u alice -f bin/agentos-shell-e2e | head -1").strip()
    machine.succeed(f"grep -q 'session-{sid}.scope' /proc/{pid}/cgroup")      # in the greetd login session
    seen, t0, text = 0, time.time(), ""
    try:
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
    assert steps["trusted"]["op"]["rows"] and all(r.split("|")[1] != "planned" for r in steps["trusted"]["op"]["rows"]), steps["trusted"]
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
    rc = machine.execute(f"grep -rqaF -D skip '{marker}' /home/alice /var/lib/agentos /run/user/{alice_uid} 2>/dev/null")[0]
    assert rc == 1, f"the draft marker is on disk (grep rc={rc})"
