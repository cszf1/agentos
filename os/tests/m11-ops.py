# Operations across two REAL Hosts (V1-I05 W06 O07 O06 part). Prepended with lib.py
# and members_lib.py. Both Hosts talk to a local OpenAI-compatible test endpoint (fake-model.py) that holds every
# request, so the test can count the HTTP model requests really in flight per workspace. It is not a real model:
# these are "KVM VM" scheduling results, never model-quality results.
FM = "/run/fake-model"

def fm_state():
    return json.loads(machine.succeed(f"cat {FM}/state.json 2>/dev/null || echo '{{\"inflight\":{{}},\"peak\":{{\"total\":0,\"pairs\":[]}}}}'"))

def fm_log():
    return [json.loads(l) for l in machine.succeed(f"cat {FM}/log.jsonl 2>/dev/null || true").splitlines() if l.strip()]

def run(n, ws, intent, tag):
    r = call(n, [fwd(ws, "runs.post", body={"intent": intent, "targetAppId": None}, idem=tag)], tag)[0]
    assert r["status"] in (200, 202), r
    b = r.get("body") or {}
    return (b.get("data") or b).get("runId")

machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
machine.wait_for_unit("agentos-fake-model.service")
out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws_a = out["workspaceId"]
machine.wait_for_unit("agentos-broker.service")
tty_login(1, "alice", "alice-pw-1")
alice = sql("SELECT user_id FROM users WHERE login_name='alice'")
bob = make_user("bob", "bob-pw-1", "ub")
tty_login(2, "bob", "bob-pw-1")
r = call(1, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "B"}}], "cb")[0]
assert r["status"] == 201, r
ws_b = r["body"]["workspaceId"]
for ws, tag in ((ws_a, "aa"), (ws_b, "ab")):
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": "att-" + tag, "body": {}}], tag)[0]
    assert r["status"] == 200, r
for ws in (ws_a, ws_b):
    machine.wait_until_succeeds(f"test -s /var/lib/agentos/workspaces/{ws}/data/agent.sqlite", timeout=120)
# bob: editor in A (viewer first, then promoted with the member version)
r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "viewer"}}], "bv")[0]
assert r["status"] == 200, r
mv = int(sql(f"SELECT member_version FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{bob}'"))
r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "editor", "expectedMemberVersion": mv}}], "be")[0]
assert r["status"] == 200, r


def runs_of(n, ws, tag):
    r = call(n, [fwd(ws, "runs.list")], tag)[0]
    b = r.get("body") or {}
    d = b.get("data") if isinstance(b, dict) else None
    items = d if isinstance(d, list) else (d or b).get("runs") or (d or b).get("items") or []
    return r, [x.get("runId") or x.get("id") for x in items]

with subtest("own and shared runs: an editor cancels only their own run; the owner manages all (I05)"):
    machine.succeed(f"echo 60 > {FM}/hold")
    ra = run(1, ws_a, "做一个待办应用", "i5a")
    rb = run(2, ws_a, "做一个记账应用", "i5b")
    assert ra and rb, (ra, rb)
    r = call(2, [fwd(ws_a, "runs.transcript.list", params={"runId": ra})], "i5t")[0]
    print("bob reads alice transcript", r["status"], code(r))
    assert r["status"] != 200, r                                   # no read of another member's transcript
    r = call(2, [fwd(ws_a, "runs.cancel.post", params={"runId": ra}, idem="i5x")], "i5x")[0]
    print("bob cancels alice run", r["status"], code(r))
    assert r["status"] not in (200, 202), r
    r = call(1, [fwd(ws_a, "runs.get", params={"runId": ra})], "i5g")[0]
    assert r["status"] == 200 and '"cancelled"' not in json.dumps(r.get("body")), r
    r = call(2, [fwd(ws_a, "runs.transcript.list", params={"runId": rb})], "i5o")[0]
    assert r["status"] == 200, r                                   # own transcript readable
    r = call(2, [fwd(ws_a, "runs.cancel.post", params={"runId": rb}, idem="i5y")], "i5y")[0]
    assert r["status"] in (200, 202), r                            # own run cancellable
    rb2 = run(2, ws_a, "做一个读书清单", "i5c")
    r = call(1, [fwd(ws_a, "runs.cancel.post", params={"runId": rb2}, idem="i5z")], "i5z")[0]
    assert r["status"] in (200, 202), r                            # the owner manages every run in the workspace
    r = call(1, [fwd(ws_a, "runs.cancel.post", params={"runId": ra}, idem="i5w")], "i5w")[0]
    assert r["status"] in (200, 202), r

with subtest("switching after an accepted run: it stays in its workspace; a retry with the same key is not copied (W06)"):
    rid = run(1, ws_a, "做一个习惯打卡", "w6")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_b, "idempotencyKey": "att-w6", "body": {}}], "w6b")[0]
    assert r["status"] == 200, r
    again = run(1, ws_a, "做一个习惯打卡", "w6")                   # network retry after the switch: same key, same workspace
    assert again == rid, (again, rid)
    _, in_b = runs_of(1, ws_b, "w6lb")
    assert rid not in in_b, in_b
    _, in_a = runs_of(1, ws_a, "w6la")
    assert in_a.count(rid) == 1, in_a
    r = call(1, [fwd(ws_b, "runs.get", params={"runId": rid})], "w6g")[0]
    assert r["status"] != 200, r                                   # the other workspace does not know the run
    call(1, [fwd(ws_a, "runs.cancel.post", params={"runId": rid}, idem="w6c")], "w6c")

with subtest("native entry abuse: bad frames close only their connection; slow clients do not starve others (O07)"):
    out = machine.succeed("python3 /etc/agentos-test/ops-fuzz.py /run/agentos/gateway.sock")
    print(out)
    res = {json.loads(l)["case"]: json.loads(l) for l in out.splitlines() if l.startswith("{")}
    for c in ("oversize-length", "not-json", "duplicate-key", "unknown-field", "url-forward", "deep-nesting", "truncated-frame"):
        assert res[c]["result"] not in (200, "timeout"), res[c]
    assert res["served-while-20-slow"]["result"] in ("SESSION_REQUIRED", 401) and res["served-while-20-slow"]["seconds"] < 5, res
    assert res["stalled-frames-closed"]["result"] == 20, res       # a started frame must complete within 30 s
    assert res["per-uid-bound"]["result"] <= 32 and res["per-uid-bound"]["refused"] >= 8, res
    assert res["served-after-release"]["result"] in ("SESSION_REQUIRED", 401), res
    machine.succeed("systemctl is-active agentos-session-gateway.service")
    r = call(1, [{"methodId": "workspaces.list"}], "o7l")[0]
    assert r["status"] == 200, r
    rss = int(machine.succeed("ps -o rss= -C agentos-session-gateway | head -1").strip() or 0)
    print("gateway rss kB", rss)
    assert rss < 200_000, rss

with subtest("SIGKILL of broker, machined and gateway: each restarts, identity and Hosts survive (O06 part)"):
    mid = sql("SELECT machine_install_id FROM machine_meta")
    hosts = machine.succeed("pgrep -f packages/host/dist/main.js | sort").split()
    for unit in ("agentos-broker", "agentos-machine", "agentos-session-gateway"):
        pid = machine.succeed(f"systemctl show -p MainPID --value {unit}.service").strip()
        machine.succeed(f"kill -KILL {pid}")
        machine.wait_until_succeeds(f"test \"$(systemctl show -p MainPID --value {unit}.service)\" != {pid} && systemctl is-active {unit}.service", timeout=60)
    assert sql("SELECT machine_install_id FROM machine_meta") == mid
    machine.wait_until_succeeds("test $(pgrep -fc packages/host/dist/main.js) -ge 2", timeout=120)
    r = call(1, [{"methodId": "workspaces.list"}], "o6l")[0]
    assert r["status"] == 200, r
    for ws, tag in ((ws_a, "o6a"), (ws_b, "o6b")):
        ok = False
        for _ in range(30):
            r = call(1, [fwd(ws, "runs.list")], tag)[0]
            if r["status"] == 200:
                ok = True
                break
            time.sleep(3)
        assert ok, r                                               # the Host reconnected to the restarted gateway
    print("hosts before", hosts, "after", machine.succeed("pgrep -f packages/host/dist/main.js | sort").split())

def starts(ws, ev="start"):
    return len([e for e in fm_log() if e["ev"] == ev and e["ws"] == ws])

def attempts(ws, rid):
    return machine.succeed(f"sqlite3 /var/lib/agentos/workspaces/{ws}/data/os.sqlite \"SELECT state FROM model_attempts WHERE run_id='{rid}'\"").split()

with subtest("lock: the accepted run's request completes inside its scope; the locked session gets nothing new (I10)"):
    machine.succeed(f"echo 20 > {FM}/hold")
    s0, e0 = starts(ws_b), starts(ws_b, "end")
    rid = run(1, ws_b, "做一个锁屏期间继续的应用", "i10a")
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"start\", \"ws\": \"{ws_b}\"' {FM}/log.jsonl) -gt {s0}", timeout=120)
    sess = user_session("alice", "tty1")
    tty_run(1, "busctl call org.freedesktop.login1 /org/freedesktop/login1/session/auto org.freedesktop.login1.Session SetLockedHint b true", "/tmp/i10l")
    machine.wait_until_succeeds(f"loginctl show-session {sess} -p LockedHint | grep -q yes")
    out = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}}]'", "/tmp/i10b")
    assert '"status": 200' not in out, out                          # no new request from the locked session
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"end\", \"ws\": \"{ws_b}\"' {FM}/log.jsonl) -gt {e0}", timeout=120)
    att = attempts(ws_b, rid)
    print("run attempts during lock", att)
    assert "completed" in att, att                                  # the in-flight request finished normally
    assert "denied" not in att, att
    st = machine.succeed(f"sqlite3 /var/lib/agentos/workspaces/{ws_b}/data/os.sqlite \"SELECT status FROM runs WHERE id='{rid}'\"").strip()
    assert st != "cancelled", st
    machine.succeed(f"test $(sqlite3 /var/lib/agentos/workspaces/{ws_b}/data/os.sqlite \"SELECT COUNT(*) FROM events WHERE kind='membership.revoking'\") = 0")
    tty_run(1, "busctl call org.freedesktop.login1 /org/freedesktop/login1/session/auto org.freedesktop.login1.Session SetLockedHint b false", "/tmp/i10u")
    out = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}}]'", "/tmp/i10c")
    assert '"status": 200' in out, out
    call(1, [fwd(ws_b, "runs.cancel.post", params={"runId": rid}, idem="i10ac")], "i10ac")

with subtest("logout with run-when-logged-out on: the accepted run continues in its workspace; the ended session is refused (I10)"):
    pl = call(1, [{"methodId": "machine.actions.plan", "idempotencyKey": str(uuid.uuid4()), "body": {"kind": "workspaces.runWhenLoggedOut", "params": {"workspaceId": ws_b, "enabled": True}}}], "i10p")[0]
    assert pl["status"] == 201, pl
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": pl["body"]["operationId"], "planHash": pl["body"]["planHash"]}}], "i10pc")[0]
    assert ok["status"] == 200 and ok["body"]["state"] == "succeeded", ok
    s0, e0 = starts(ws_b), starts(ws_b, "end")
    rid = run(1, ws_b, "做一个注销后继续的应用", "i10b")
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"start\", \"ws\": \"{ws_b}\"' {FM}/log.jsonl) -gt {s0}", timeout=120)
    ub = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_b}/data").strip()
    # alice logs out: every session of hers ends
    machine.succeed("loginctl terminate-user alice")
    machine.wait_until_fails("loginctl list-sessions --no-legend | grep -w alice", timeout=60)
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"end\", \"ws\": \"{ws_b}\"' {FM}/log.jsonl) -gt {e0}", timeout=120)
    att = attempts(ws_b, rid)
    print("run attempts after logout", att)
    assert "completed" in att and "denied" not in att, att
    machine.succeed(f"pgrep -u {ub} -f packages/host/dist/main.js")   # the workspace keeps running for the accepted run
    assert sql(f"SELECT state FROM workspaces WHERE workspace_id='{ws_b}'") == "running"
    # a process of the logged-out user has no session: binding is refused
    rc, o = machine.execute(f"su -s /bin/sh alice -c '{RPC} \"[{{\\\"methodId\\\":\\\"session.bind\\\"}}]\"' 2>&1")
    print(o)
    assert '"status": 200' not in o, o

with subtest("VM power cut with a model request in flight: identity kept, the held permit is charged unknown, workspaces start again (O06 power cut)"):
    machine.succeed(f"echo 90 > {FM}/hold")
    s0 = starts(ws_a)
    rid = run(2, ws_a, "做一个断电前的应用", "pc1")                    # bob (editor in A), still logged in on tty2
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"start\", \"ws\": \"{ws_a}\"' {FM}/log.jsonl) -gt {s0}", timeout=120)
    mid = sql("SELECT machine_install_id FROM machine_meta")
    held = sql(f"SELECT permit_id FROM machine_permits WHERE workspace_id='{ws_a}' AND state='in_use'").split()
    assert held, sql("SELECT permit_id, workspace_id, state FROM machine_permits WHERE state IN ('reserved','in_use')")
    machine.crash()                                                    # QEMU stops at once: no shutdown, no flush by us
    machine.start()
    machine.wait_for_unit("agentos-machine.service")
    machine.wait_for_unit("agentos-session-gateway.service")
    machine.wait_for_unit("agentos-broker.service")
    assert sql("SELECT machine_install_id FROM machine_meta") == mid
    print(machine.succeed("journalctl -b -u agentos-machine.service -o cat --no-pager | grep 'permits reconciled' || true"))
    for p in held:
        st = sql(f"SELECT state || ':' || IFNULL(usage_status,'') FROM machine_permits WHERE permit_id='{p}'")
        print("permit after power cut", p, st)
        assert st == "released:unknown", st                           # another boot: the holder is gone; maybe-sent is charged
    assert sql("SELECT COUNT(*) FROM machine_permits WHERE state IN ('reserved','in_use','reconciling')") == "0"
    machine.succeed("sqlite3 /var/lib/agentos-machine/machine.sqlite 'PRAGMA integrity_check' | grep -qx ok")
    tty_login(1, "alice", "alice-pw-1")
    r = call(1, [{"methodId": "workspaces.list"}], "pcl")[0]
    assert r["status"] == 200, r
    for ws, tag in ((ws_a, "pca"), (ws_b, "pcb")):
        r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], tag)[0]
        assert r["status"] == 200, r
    ua = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_a}/data").strip()
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js", timeout=120)
    machine.succeed(f"runuser -u $(id -nu {ua}) -- sqlite3 /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite 'PRAGMA integrity_check' | grep -qx ok")
    ok = False
    for _ in range(30):
        r = call(1, [fwd(ws_a, "runs.list")], "pcr")[0]
        if r["status"] == 200:
            ok = True
            break
        time.sleep(3)
    assert ok, r
    att = attempts(ws_a, rid)
    print("attempts of the cut run", att)
    assert "completed" not in att, att                                # the cut request is never reported as completed
