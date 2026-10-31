# M2/M3 machine scheduling across two REAL Hosts (spec §13, §9.3; V1-S01 S02 S08 I07 W08). Prepended with lib.py
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

with subtest("runWhenLoggedOut: off by default, owner only (W08)"):
    # §16.1 has no settings route: the owner changes it through a fixed machine action (plan → confirm).
    def rwlo(n, enabled, tag):
        pl = call(n, [{"methodId": "machine.actions.plan", "idempotencyKey": str(uuid.uuid4()), "body": {"kind": "workspaces.runWhenLoggedOut", "params": {"workspaceId": ws_a, "enabled": enabled}}}], tag)[0]
        if pl["status"] != 201:
            return pl
        return call(n, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": pl["body"]["operationId"], "planHash": pl["body"]["planHash"]}}], tag + "c")[0]
    assert sql(f"SELECT run_when_logged_out FROM workspaces WHERE workspace_id='{ws_a}'") == "0"
    r = rwlo(2, True, "w1")
    assert r["status"] != 200 and r["status"] != 201, r            # an editor cannot let the workspace run logged out
    assert sql(f"SELECT run_when_logged_out FROM workspaces WHERE workspace_id='{ws_a}'") == "0"
    r = rwlo(1, True, "w2")
    assert r["status"] == 200 and r["body"]["state"] == "succeeded", r
    assert sql(f"SELECT run_when_logged_out FROM workspaces WHERE workspace_id='{ws_a}'") == "1"
    r = rwlo(1, False, "w3")
    assert r["status"] == 200 and r["body"]["state"] == "succeeded", r
    assert sql(f"SELECT run_when_logged_out FROM workspaces WHERE workspace_id='{ws_a}'") == "0"

with subtest("support bundle: root only, 0600, no passwords, no full machine identity (O08)"):
    machine.fail("su - bob -c 'agentosctl support-bundle --out /tmp/sb.json'")
    out = json.loads(must("agentosctl support-bundle --out /root/sb.json"))
    assert out["ok"], out
    assert machine.succeed("stat -c %a /root/sb.json").strip() == "600"
    body = machine.succeed("cat /root/sb.json")
    mid = sql("SELECT machine_install_id FROM machine_meta")
    for secret in ("alice-pw-1", "bob-pw-1"):
        assert secret not in body, secret
    assert mid and mid not in body, "full machine identity in the bundle"
    b = json.loads(body)
    assert b["kind"] == "agentos.support-bundle.v1" and b["machineIdentityDigest"].startswith("sha256:")
    assert {w["workspaceId"] for w in b["workspaces"]} == {ws_a, ws_b}, b["workspaces"]
    # the audit log is append-only: the bundle does not rotate or trim it
    first = sql("SELECT MIN(seq) FROM root_audit")
    n1 = int(sql("SELECT COUNT(*) FROM root_audit"))
    must("agentosctl support-bundle --out /root/sb2.json")
    assert sql("SELECT MIN(seq) FROM root_audit") == first and int(sql("SELECT COUNT(*) FROM root_audit")) >= n1

with subtest("two real Hosts: at most two model requests in flight on the machine, one per workspace while both wait (S01, S02)"):
    machine.succeed(f"echo 25 > {FM}/hold")
    # §13.2: with no other waiter a workspace may use the second permit, so interleave the posts: once both
    # workspaces wait, each holds at most one model permit and freed slots alternate between them.
    ids = [run(1, ws_a, "做一个待办应用", "ra1"), run(1, ws_b, "做一个读书清单", "rb1"), run(1, ws_a, "做一个记账应用", "ra2"), run(1, ws_b, "做一个习惯打卡", "rb2")]
    assert all(ids), ids
    machine.wait_until_succeeds(f"test \"$(python3 -c \"import json;print(sum(json.load(open('{FM}/state.json'))['inflight'].values()))\")\" = 2", timeout=180)
    first = fm_state()["inflight"]
    assert first.get(ws_a, 0) == 1 and first.get(ws_b, 0) == 1, first    # both workspaces wait: one slot each (§13.2)
    time.sleep(60)                                                   # several hold periods: the machine total never exceeds 2
    st = fm_state()
    print("fake model peak", st["peak"]["total"], "samples", len(st["peak"]["pairs"]))
    assert st["peak"]["total"] <= 2, st
    starts = [e for e in fm_log() if e["ev"] == "start"]
    assert {e["ws"] for e in starts} == {ws_a, ws_b}, starts
    # while both workspaces had queued work, no start gave one workspace a second concurrent slot
    both = [e for e in starts if sum(e["inflight"].values()) == 2]
    assert all(e["inflight"].get(ws_a, 0) == 1 and e["inflight"].get(ws_b, 0) == 1 for e in both[:4]), both[:4]
    # the machine log agrees: the permits that were reserved/in use at once came from both workspaces
    print(sql("SELECT workspace_id, state, usage_status, COUNT(*) FROM machine_permits GROUP BY 1,2,3"))
    assert int(sql("SELECT COUNT(*) FROM machine_permits WHERE state IN ('reserved','in_use')")) <= 2
    for rid in ids:
        r = call(1, [fwd(ws_a if rid in (ids[0], ids[2]) else ws_b, "runs.cancel.post", params={"runId": rid}, idem="c-" + rid)], "c" + rid[:6])[0]
    machine.wait_until_succeeds(f"python3 -c \"import json,sys;sys.exit(sum(json.load(open('{FM}/state.json'))['inflight'].values()))\"", timeout=120)

with subtest("revocation while a run waits for a machine permit: no model request is sent for it (I07, S04)"):
    machine.succeed(f"echo 40 > {FM}/hold")
    a1 = run(1, ws_a, "做一个便签应用", "rv1")
    b1 = run(1, ws_b, "做一个日记应用", "rv2")
    machine.wait_until_succeeds(f"test \"$(python3 -c \"import json;print(sum(json.load(open('{FM}/state.json'))['inflight'].values()))\")\" = 2", timeout=180)
    n_before = len([e for e in fm_log() if e["ev"] == "start" and e["ws"] == ws_a])
    rb = run(2, ws_a, "做一个联系人应用", "rv3")                  # bob's run: queued behind the two busy slots
    machine.wait_until_succeeds(f"test $(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT COUNT(*) FROM machine_permits WHERE user_id='{bob}' AND state='queued'\") -ge 1", timeout=120)
    r = call(1, [{"methodId": "members.revoke", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob}}], "rvk")[0]
    assert r["status"] in (200, 201, 202), r
    machine.wait_until_succeeds(f"test $(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT COUNT(*) FROM machine_permits WHERE user_id='{bob}' AND state IN ('queued','reserved')\") = 0", timeout=120)
    time.sleep(50)                                                   # the busy slots free up; bob's run must not take one
    print(sql(f"SELECT state, usage_status FROM machine_permits WHERE user_id='{bob}'"))
    assert sql(f"SELECT COUNT(*) FROM machine_permits WHERE user_id='{bob}' AND (state='in_use' OR usage_status IN ('used','unknown'))") == "0"
    att = machine.succeed(f"sqlite3 /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite \"SELECT state FROM model_attempts WHERE run_id='{rb}'\"").split()
    print("bob run attempts", att)
    assert all(s in ("denied", "failed", "interrupted") for s in att), att  # nothing reached the provider for it
    starts_a = [e for e in fm_log() if e["ev"] == "start" and e["ws"] == ws_a]
    print("A requests before/after", n_before, len(starts_a))
    for rid, ws in ((a1, ws_a), (b1, ws_b)):
        call(1, [fwd(ws, "runs.cancel.post", params={"runId": rid}, idem="c2-" + rid)], "d" + rid[:6])

with subtest("machined unreachable: bound sessions degrade (reads, brief writes), new model work waits with a visible reason, all resumes after (S08)"):
    machine.succeed(f"echo 1 > {FM}/hold")
    machine.succeed("rm -f /tmp/s8-go /tmp/s8-go2")
    OSB = f"/var/lib/agentos/workspaces/{ws_b}/data/os.sqlite"
    s8 = [{"methodId": "session.status"}, fwd(ws_b, "runs.list"),
          {"methodId": "$wait", "path": "/tmp/s8-go"},
          {"methodId": "session.status"}, fwd(ws_b, "runs.list"),
          fwd(ws_b, "runs.post", body={"intent": "做一个读书记录应用", "targetAppId": None}, idem="s8-in-grace"),
          {"methodId": "$wait", "path": "/tmp/s8-go2"},
          fwd(ws_b, "runs.post", body={"intent": "做一个喝水记录应用", "targetAppId": None}, idem="s8-after-grace"),
          fwd(ws_b, "runs.list"), {"methodId": "session.status"}]
    body = json.dumps([{"methodId": "session.bind"}] + s8, ensure_ascii=False)
    machine.succeed(f"echo {base64.b64encode(body.encode()).decode()} | base64 -d > /tmp/s8.json && chmod 0644 /tmp/s8.json && rm -f /tmp/s8.out")
    # one connection held open in alice's real tty session for the whole outage (started without waiting)
    machine.succeed(f"echo {base64.b64encode((RPC + ' @/tmp/s8.json > /tmp/s8.out 2>&1; echo done >> /tmp/s8.out' + chr(10)).encode()).decode()} | base64 -d > /tmp/s8.sh && chmod 0644 /tmp/s8.sh")
    machine.send_key("alt-f1")
    machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active")
    machine.send_chars("sh /tmp/s8.sh\n")
    def s8_lines(n):
        machine.wait_until_succeeds(f"test $(grep -c '^{{' /tmp/s8.out) -ge {n}", timeout=240)
        return [json.loads(l) for l in machine.succeed("cat /tmp/s8.out").splitlines() if l.startswith("{")]
    L = s8_lines(3)
    assert L[0]["status"] == 200 and L[1]["body"]["machine"]["reachable"] is True and L[2]["status"] == 200, L
    machine.succeed("systemctl stop agentos-machine.service")
    n0 = len([e for e in fm_log() if e["ev"] == "start"])
    t_stop = time.time()
    machine.succeed("touch /tmp/s8-go")
    L = s8_lines(7)
    st, rd, wr = L[4], L[5], L[6]
    print("S08 status during outage:", st)
    m = st["body"]["machine"]
    assert m["reachable"] is False and "unreachable" in m["reason"] and m["writesOpen"] is True, st   # the reason is visible
    assert rd["status"] == 200, rd                                       # reads continue on the confirmed membership
    assert wr["status"] in (200, 202), wr                                # a write within the 30 s grace is accepted
    rid8 = (wr.get("body") or {}).get("data", wr.get("body") or {}).get("runId")
    assert rid8, wr
    # the accepted run sends nothing while machined is away; the Host records why
    machine.wait_until_succeeds(f"sqlite3 {OSB} \"SELECT COUNT(*) FROM events WHERE kind='machine.unreachable'\" | grep -qv '^0$'", timeout=60)
    print(machine.succeed(f"sqlite3 {OSB} \"SELECT payload_json FROM events WHERE kind='machine.unreachable' ORDER BY rowid DESC LIMIT 1\""))
    st_run = machine.succeed(f"sqlite3 {OSB} \"SELECT status FROM runs WHERE id='{rid8}'\"").strip()
    assert st_run in ("queued", "running"), st_run                       # waiting, not failed/stopped as 'budget'
    time.sleep(max(0, 33 - (time.time() - t_stop)))
    assert len([e for e in fm_log() if e["ev"] == "start"]) == n0, "a model request went out while machined was unreachable"
    machine.succeed("touch /tmp/s8-go2")
    L = s8_lines(11)
    wr2, rd2, st2 = L[8], L[9], L[10]
    assert wr2["status"] == 503 and wr2["error"]["code"] == "STORE_UNAVAILABLE" and "writes are closed" in wr2["error"]["message"], wr2
    assert rd2["status"] == 200, rd2                                     # reads still served within the read grace
    assert st2["body"]["machine"]["writesOpen"] is False, st2
    assert machine.succeed(f"sqlite3 {OSB} \"SELECT COUNT(*) FROM runs WHERE intent='做一个喝水记录应用'\"").strip() == "0"   # refused write left nothing
    # a new session cannot be bound (identity needs machined): visible reason. Done after the held connection ended:
    # switching the VT takes the foreground from alice's session and retires its epoch.
    machine.wait_until_succeeds("grep -q '^done$' /tmp/s8.out", timeout=60)
    out = tty_run(2, f"{RPC} '[{{\"methodId\":\"session.bind\"}}]'", "/tmp/s8b")
    assert "STORE_UNAVAILABLE" in out and "unreachable" in out, out
    ua = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_a}/data").strip()
    ub = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_b}/data").strip()
    for u in (ua, ub):
        machine.succeed(f"pgrep -u {u} -f packages/host/dist/main.js")   # the Hosts keep their data and processes
    assert len([e for e in fm_log() if e["ev"] == "start"]) == n0
    machine.succeed("systemctl start agentos-machine.service")
    machine.wait_for_unit("agentos-machine.service")
    # the run accepted during the outage now gets its permit and reaches the model; the Host records the recovery
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"start\"' {FM}/log.jsonl) -gt {n0}", timeout=180)
    machine.wait_until_succeeds(f"sqlite3 {OSB} \"SELECT COUNT(*) FROM events WHERE kind='machine.reachable'\" | grep -qv '^0$'", timeout=60)
    r = call(1, [{"methodId": "workspaces.list"}, {"methodId": "session.status"}], "s8c")
    assert r[0]["status"] == 200 and r[1]["body"]["machine"]["reachable"] is True, r

with subtest("the machine's 24-hour model budget stops a real Host's run before any request is sent (S01 day budget)"):
    machine.succeed(f"echo 1 > {FM}/hold")
    for w in (ws_a, ws_b):   # nothing of ours in flight first
        machine.wait_until_succeeds(f"test \"$(python3 -c \"import json;print(json.load(open('{FM}/state.json'))['inflight'].get('{w}',0))\")\" = 0", timeout=180)
    # charge the machine's day: the budget counts permits created in the last 24 h that were used (or unknown).
    # These rows stand for earlier requests of today; they belong to no live instance.
    charged = int(sql("SELECT COUNT(*) FROM machine_permits WHERE resource_class='model' AND created_at >= (CAST(strftime('%s','now') AS INTEGER)-86400)*1000 AND (state IN ('queued','reserved','in_use','reconciling') OR usage_status IN ('used','unknown'))"))
    k = 256 - charged
    assert k > 0, charged
    sql(f"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < {k}) INSERT INTO machine_permits (permit_id, workspace_id, execution_epoch, owner_kind, owner_id, attempt_id, resource_class, priority, body_hash, member_version, user_id, instance_id, boot_id, seq, state, deadline_at, usage_status, created_at) SELECT 'day-' || i, '{ws_a}', 0, 'run', 'day-seed', 'day-' || i, 'model', 'foreground', 'h', 1, NULL, 'seed', 'seed', (SELECT MAX(seq) FROM machine_permits) + i, 'released', 0, 'used', CAST(strftime('%s','now') AS INTEGER)*1000 FROM n")
    n0 = len([e for e in fm_log() if e["ev"] == "start"])
    rid = run(1, ws_a, "做一个预算之外的应用", "day1")
    OSA = f"/var/lib/agentos/workspaces/{ws_a}/data/os.sqlite"
    # the Host is refused at admission (before any attempt row may be written) and ends the run
    machine.wait_until_succeeds(f"sqlite3 {OSA} \"SELECT status FROM runs WHERE id='{rid}'\" | grep -qE '^(failed|cancelled)$'", timeout=120)
    time.sleep(5)
    att = machine.succeed(f"sqlite3 {OSA} \"SELECT state FROM model_attempts WHERE run_id='{rid}'\"").split()
    print("day-budget run attempts", att, machine.succeed(f"sqlite3 {OSA} \"SELECT status, IFNULL(error_json,'') FROM runs WHERE id='{rid}'\" 2>&1 || true"))
    print(machine.succeed("journalctl -o cat --no-pager | grep -F '" + rid + "' | grep -i budget | tail -2 || true"))
    assert all(s in ("denied", "failed", "interrupted") for s in att), att      # nothing reached the provider
    assert len([e for e in fm_log() if e["ev"] == "start"]) == n0                     # no request reached the endpoint
    assert sql(f"SELECT COUNT(*) FROM machine_permits WHERE workspace_id='{ws_a}' AND owner_id='{rid}' AND state IN ('reserved','in_use')") == "0"
    # the day rolls over (the seeded charges age out): the next run is admitted and its request goes out
    sql("DELETE FROM machine_permits WHERE owner_id='day-seed'")
    call(1, [fwd(ws_a, "runs.cancel.post", params={"runId": rid}, idem="day-c1")], "dayc")
    run(1, ws_a, "做一个预算恢复后的应用", "day2")
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"start\"' {FM}/log.jsonl) -gt {n0}", timeout=180)

with subtest("machined SIGKILL while permits are reserved/in use: nothing is freed or reserved twice; held slots end with their holder (S05)"):
    machine.succeed(f"echo 45 > {FM}/hold")
    machine.wait_until_succeeds(f"python3 -c \"import json,sys;sys.exit(sum(json.load(open('{FM}/state.json'))['inflight'].values()))\"", timeout=180)
    n_start0 = len([e for e in fm_log() if e["ev"] == "start"])
    s1 = run(1, ws_a, "做一个借书记录应用", "s5a")
    s2 = run(1, ws_b, "做一个植物浇水应用", "s5b")
    machine.wait_until_succeeds(f"test \"$(python3 -c \"import json;print(sum(json.load(open('{FM}/state.json'))['inflight'].values()))\")\" = 2", timeout=180)
    held = sql("SELECT permit_id || ':' || state FROM machine_permits WHERE resource_class='model' AND state IN ('reserved','in_use','reconciling') ORDER BY permit_id").split()
    print("held before kill", held)
    assert len(held) == 2 and all(h.endswith(":in_use") for h in held), held
    s3 = run(1, ws_a, "做一个第三个应用", "s5c")                       # waits behind the two busy slots
    machine.wait_until_succeeds("test $(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT COUNT(*) FROM machine_permits WHERE resource_class='model' AND state='queued'\") -ge 1", timeout=120)
    rows_before = int(sql("SELECT COUNT(*) FROM machine_permits"))
    pid = machine.succeed("systemctl show -p MainPID --value agentos-machine.service").strip()
    machine.succeed(f"kill -KILL {pid}")
    machine.wait_until_succeeds(f"test \"$(systemctl show -p MainPID --value agentos-machine.service)\" != {pid} && systemctl is-active agentos-machine.service", timeout=60)
    print(machine.succeed("journalctl -u agentos-machine.service -o cat --no-pager | grep 'permits reconciled' | tail -1"))
    # the holders (both Hosts' execution UIDs) are alive: the two permits are kept (reconciling or back in use), never freed
    after = sql("SELECT permit_id || ':' || state FROM machine_permits WHERE permit_id IN (" + ",".join("'" + h.split(':')[0] + "'" for h in held) + ") ORDER BY permit_id").split()
    print("held after restart", after)
    assert all(a.split(":")[1] in ("reconciling", "in_use") for a in after) and len(after) == 2, after
    time.sleep(10)
    assert int(sql("SELECT COUNT(*) FROM machine_permits WHERE resource_class='model' AND state IN ('reserved','in_use','reconciling')")) <= 2
    assert int(sql("SELECT COUNT(*) FROM machine_permits WHERE resource_class='model' AND state='queued'")) >= 1   # the waiter did not get a freed slot
    st = fm_state()
    assert sum(st["inflight"].values()) <= 2, st
    # no duplicate reservation: one permit row per model attempt (attempt_id unique among the rows written since)
    dup = sql("SELECT COUNT(*) FROM (SELECT attempt_id FROM machine_permits WHERE resource_class='model' GROUP BY attempt_id HAVING COUNT(*) > 1)")
    assert dup == "0", dup
    # the held requests finish: their Hosts release them with the real usage, and only then the waiter starts
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"start\"' {FM}/log.jsonl) -gt {n_start0 + 2}", timeout=240)
    fin = sql("SELECT permit_id || ':' || state || ':' || IFNULL(usage_status,'') FROM machine_permits WHERE permit_id IN (" + ",".join("'" + h.split(':')[0] + "'" for h in held) + ")").split()
    print("held permits at the end", fin)
    assert all(f.split(":")[1] in ("released", "reconciling", "in_use") and f.split(":")[2] != "unused" for f in fin), fin   # never handed back as unused
    assert fm_state()["peak"]["total"] <= 2, fm_state()
    for rid, ws in ((s1, ws_a), (s2, ws_b), (s3, ws_a)):
        call(1, [fwd(ws, "runs.cancel.post", params={"runId": rid}, idem="s5c-" + rid)], "s5x" + rid[:6])

with subtest("Host SIGKILL with a model permit in use: held until the successor Host says hello, then charged unknown, never handed back unused (S05 Host, S06)"):
    machine.succeed(f"echo 60 > {FM}/hold")
    machine.wait_until_succeeds(f"python3 -c \"import json,sys;sys.exit(sum(json.load(open('{FM}/state.json'))['inflight'].values()))\"", timeout=240)
    k1 = run(1, ws_a, "做一个记账应用", "s6a")
    machine.wait_until_succeeds(f"test \"$(python3 -c \"import json;print(json.load(open('{FM}/state.json'))['inflight'].get('{ws_a}',0))\")\" = 1", timeout=180)
    machine.wait_until_succeeds(f"test -n \"$(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT permit_id FROM machine_permits WHERE owner_id='{k1}' AND state='in_use'\")\"", timeout=60)
    P = sql(f"SELECT permit_id FROM machine_permits WHERE workspace_id='{ws_a}' AND owner_id='{k1}' AND resource_class='model' AND state='in_use'").split()
    assert len(P) == 1, P
    P = P[0]
    ua = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_a}/data").strip()
    old = machine.succeed(f"pgrep -u {ua} -f packages/host/dist/main.js").split()[0]
    inst_old = sql(f"SELECT instance_id FROM machine_permits WHERE permit_id='{P}'")
    machine.succeed(f"kill -KILL {old}")
    machine.wait_until_fails(f"kill -0 {old}", timeout=30)
    # the successor Host (systemd restart) says hello with a new instance; only then is the slot given up, as unknown
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js | grep -vqx {old}", timeout=120)
    machine.wait_until_succeeds(f"test \"$(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT state || ':' || usage_status FROM machine_permits WHERE permit_id='{P}'\")\" = released:unknown", timeout=120)
    new_inst = sql(f"SELECT instance_id FROM workspace_instances WHERE workspace_id='{ws_a}' AND state='running'")
    assert new_inst and new_inst != inst_old, (new_inst, inst_old)
    assert sql(f"SELECT state FROM workspace_instances WHERE instance_id='{inst_old}'") == "lost"
    # charged: the machine's day budget counts it (used or unknown); it was never returned as unused
    assert sql(f"SELECT COUNT(*) FROM machine_permits WHERE permit_id='{P}' AND usage_status IN ('used','unknown')") == "1"
    att = machine.succeed(f"sqlite3 /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite \"SELECT state FROM model_attempts WHERE run_id='{k1}'\"").split()
    print("attempts of the killed Host's run", att)
    assert "completed" not in att, att                                 # the cut request is never reported completed
    assert fm_state()["peak"]["total"] <= 2, fm_state()
    call(1, [fwd(ws_a, "runs.cancel.post", params={"runId": k1}, idem="s6x")], "s6x")
    machine.succeed(f"echo 0 > {FM}/hold")

with subtest("background model work: at most one background request on the machine, compaction counts as background, it yields to user tasks and blocks none (S01 background, S07, S03)"):
    machine.succeed(f"echo 1 > {FM}/hold")
    machine.wait_until_succeeds(f"python3 -c \"import json,sys;sys.exit(sum(json.load(open('{FM}/state.json'))['inflight'].values()))\"", timeout=240)
    OSDB = lambda w: f"/var/lib/agentos/workspaces/{w}/data/os.sqlite"
    def wsql(w, q):
        return machine.succeed(f"sqlite3 {OSDB(w)} \"{q}\"").strip()
    # ended task conversations to compact (idle compaction needs an ended task): two in A, two in B
    convs = {}
    for w, tag, intent in ((ws_a, "bg-a1", "做一个书签应用"), (ws_a, "bg-a2", "做一个菜谱应用"), (ws_b, "bg-b1", "做一个旅行清单"), (ws_b, "bg-b2", "做一个药品提醒")):
        rid = run(1, w, intent, tag)
        machine.wait_until_succeeds(f"sqlite3 {OSDB(w)} \"SELECT status FROM runs WHERE id='{rid}'\" | grep -qE '^(succeeded|failed|cancelled)$'", timeout=240)
        convs[tag] = wsql(w, f"SELECT conversation_id FROM runs WHERE id='{rid}'")
        assert convs[tag], (tag, rid)
    def compact(w, tag):
        r = call(1, [fwd(w, "conversations.compactions.post", params={"id": convs[tag]}, body={}, idem="cmp-" + tag)], "k" + tag[-2:])[0]
        assert r["status"] == 202, r
    def bg_held():
        return int(sql("SELECT COUNT(*) FROM machine_permits WHERE resource_class='model' AND priority='background' AND state IN ('reserved','in_use','reconciling')"))
    def sample(sec, check):
        end = time.time() + sec
        while time.time() < end:
            check()
            time.sleep(0.5)
    n_log = len(fm_log())
    # (1) S01: two workspaces each ask for a compaction while nothing else runs: one background request at a time
    machine.succeed(f"echo 20 > {FM}/hold")
    def bg_diag():
        for w in (ws_a, ws_b):
            print("diag", w, machine.execute(f"sqlite3 {OSDB(w)} \"SELECT 'run', id, status, scheduling_state, background FROM runs WHERE status NOT IN ('succeeded','failed','cancelled'); SELECT 'cmp', id, state, IFNULL(result_json,'') FROM compaction_jobs; SELECT 'meta', maintenance_state FROM meta\" 2>&1")[1])
        print("diag permits", sql("SELECT permit_id, workspace_id, priority, state FROM machine_permits WHERE resource_class='model' AND state IN ('queued','reserved','in_use','reconciling')"))
        print("diag fm", fm_state())
        print(machine.execute("journalctl -b -o cat --no-pager | grep -iE 'compaction|background|maintenance services' | grep -v '\"msg\":\"request\"' | tail -30")[1])
    compact(ws_a, "bg-a1")
    compact(ws_b, "bg-b1")
    try:
        machine.wait_until_succeeds(f"test \"$(python3 -c \"import json;print(json.load(open('{FM}/state.json'))['kinds']['compaction'])\")\" = 1", timeout=180)
    except Exception:
        bg_diag()
        raise
    def one_bg():
        st = fm_state()
        assert st["kinds"]["compaction"] <= 1, st
        assert bg_held() <= 1, sql("SELECT permit_id, workspace_id, state FROM machine_permits WHERE priority='background' AND state IN ('reserved','in_use','reconciling')")
    sample(30, one_bg)
    machine.wait_until_succeeds(f"test $(grep -c '\"kind\": \"compaction\"' {FM}/log.jsonl) -ge 4", timeout=240)   # both ran (start+end each)
    cs = [e for e in fm_log()[n_log:] if e.get("kind") == "compaction"]
    starts = [e for e in cs if e["ev"] == "start"]
    print("compaction requests", [(e["ev"], e["ws"], round(e["t"], 1)) for e in cs])
    assert {e["ws"] for e in starts} >= {ws_a, ws_b}, starts
    assert all(e["kinds"]["compaction"] <= 1 for e in cs), cs                     # never two background requests at once
    print("compaction jobs A", wsql(ws_a, "SELECT state FROM compaction_jobs"), "B", wsql(ws_b, "SELECT state FROM compaction_jobs"))
    # (2) S07/S03: a background request is in flight in A and another compaction waits in B; a user task in the SAME
    # workspace A starts at once (the background job holds no app/conversation lock or slot that the user task waits
    # for), and B's compaction does not start while any user task holds or waits for a model slot on the machine
    machine.wait_until_succeeds(f"python3 -c \"import json,sys;sys.exit(sum(json.load(open('{FM}/state.json'))['inflight'].values()))\"", timeout=240)
    n_log = len(fm_log())
    machine.succeed(f"echo 30 > {FM}/hold")
    compact(ws_a, "bg-a2")
    machine.wait_until_succeeds(f"test \"$(python3 -c \"import json;print(json.load(open('{FM}/state.json'))['inflight'].get('{ws_a}',0))\")\" = 1", timeout=180)
    compact(ws_b, "bg-b2")
    t_fg = time.time()
    fg = run(1, ws_a, "做一个前台任务", "bg-fg")
    machine.wait_until_succeeds(f"test \"$(python3 -c \"import json;print(json.load(open('{FM}/state.json'))['kinds']['run'])\")\" = 1", timeout=60)
    print("user task started after", round(time.time() - t_fg, 1), "s while A's compaction was in flight")
    def no_bg_with_fg():
        st = fm_state()
        assert st["kinds"]["compaction"] <= 1, st
        fg_q = int(sql("SELECT COUNT(*) FROM machine_permits WHERE resource_class='model' AND priority='foreground' AND state IN ('queued','reserved','in_use','reconciling')"))
        bg_new = int(sql("SELECT COUNT(*) FROM machine_permits WHERE resource_class='model' AND priority='background' AND state='reserved'"))
        assert not (fg_q and bg_new), (fg_q, bg_new)                                 # no background reservation while a user task holds/waits
    sample(40, no_bg_with_fg)
    machine.wait_until_succeeds(f"sqlite3 {OSDB(ws_a)} \"SELECT status FROM runs WHERE id='{fg}'\" | grep -qE '^(succeeded|failed|cancelled)$'", timeout=240)
    machine.wait_until_succeeds(f"test $(python3 -c \"import json;print(sum(1 for l in open('{FM}/log.jsonl').readlines()[{n_log}:] if json.loads(l).get('kind')=='compaction' and json.loads(l)['ev']=='start'))\") -ge 2", timeout=300)
    ev = fm_log()[n_log:]
    print("S07 requests", [(e["ev"], e.get("kind"), e["ws"], round(e["t"], 1)) for e in ev])
    for e in ev:
        if e["ev"] == "start" and e.get("kind") == "compaction":
            assert e["kinds"]["run"] == 0, e                                            # a background request never starts beside a user turn
    b_start = [e for e in ev if e["ev"] == "start" and e.get("kind") == "compaction" and e["ws"] == ws_b]
    fg_ends = [e["t"] for e in ev if e["ev"] == "end" and e.get("kind") == "run" and e["ws"] == ws_a]
    assert b_start and fg_ends and b_start[0]["t"] >= max(fg_ends) - 0.5, (b_start, fg_ends)   # B's compaction waited for the user task
    assert fm_state()["peak"]["total"] <= 2, fm_state()
    machine.succeed(f"echo 0 > {FM}/hold")

with subtest("rollback only to a release whose compatibility covers the live data; records and revocations stay (U11)"):
    machine.succeed("cat > /root/mcall.py <<'PY'\nimport json, socket, struct, sys\ns = socket.socket(socket.AF_UNIX); s.connect('/run/agentos/machine/machine.sock')\nb = json.dumps({'op': sys.argv[1], 'args': json.loads(sys.argv[2])}).encode()\ns.sendall(struct.pack('>I', len(b)) + b)\nn = struct.unpack('>I', s.recv(4, socket.MSG_WAITALL))[0]\nprint(s.recv(n, socket.MSG_WAITALL).decode())\nPY")
    def mcall(op, args):
        return json.loads(machine.succeed(f"python3 /root/mcall.py {op} '{json.dumps(args)}'"))
    # the machine runs the new generation (machine schema 2). Two older generations are registered: one declares only
    # schema 1, one declares 1..2. Other data versions are inside both ranges.
    base = {"workspaceSchema": [5, 5], "brokerSchema": [4, 4], "brokerProtocol": [3, 3], "nativeRpc": [1, 1]}
    seq0 = int(sql("SELECT IFNULL(MAX(release_sequence), 0) FROM releases"))
    for rid, ms, k in (("u11-old", [1, 1], 1), ("u11-compat", [1, 2], 2)):
        comp = json.dumps({**base, "machineSchema": ms}).replace('"', '\\"')
        sql(f"INSERT INTO releases (release_id, manifest_hash, release_sequence, closure_path, compatibility_json, migration_class, verification_state, support_until, created_at) VALUES ('{rid}', 'sha256:{rid}', {seq0 + k}, '/nix/store/{rid}', '{comp}', 'none', 'verified', 4102444800000, 1)")
    cur0 = sql("SELECT IFNULL(current_release_id,'') || '|' || IFNULL(known_good_release_id,'') || '|' || accepted_release_sequence FROM machine_meta")
    revs0 = sql("SELECT revocation_id || ':' || state FROM revocations ORDER BY revocation_id")
    users0 = sql("SELECT COUNT(*) FROM users")
    r = mcall("releases.setCurrent", {"releaseId": "u11-old", "knownGood": True})
    print(r)
    assert not r["ok"] and r["error"]["code"] == "ROLLBACK_INCOMPATIBLE", r                     # refused before anything boots it
    assert sql("SELECT IFNULL(current_release_id,'') || '|' || IFNULL(known_good_release_id,'') || '|' || accepted_release_sequence FROM machine_meta") == cur0
    r = mcall("releases.setCurrent", {"releaseId": "u11-compat", "knownGood": True})
    assert r["ok"], r
    meta = sql("SELECT current_release_id || '|' || known_good_release_id || '|' || accepted_release_sequence FROM machine_meta")
    assert meta.startswith("u11-compat|u11-compat|") and meta.split("|")[2] == cur0.split("|")[2], (meta, cur0)   # high water unchanged
    assert sql("SELECT revocation_id || ':' || state FROM revocations ORDER BY revocation_id") == revs0              # the latest revocations stay
    assert sql("SELECT COUNT(*) FROM users") == users0
    assert "revoked" in revs0, revs0                                                                               # bob's revocation (I07) is among them
    r = call(1, [{"methodId": "workspaces.list"}], "u11l")[0]
    assert r["status"] == 200, r

with subtest("no PAM password reached a model request body (I11 model content)"):
    bodies = machine.succeed(f"wc -c < {FM}/bodies.log").strip()
    print("model request bytes seen by the endpoint", bodies)
    assert int(bodies) > 0
    for secret in ("alice-pw-1", "bob-pw-1"):
        machine.fail(f"grep -qF '{secret}' {FM}/bodies.log")

# ---- review F03: the exact race windows of a revocation against a write commit (V1-I06) ----
PAUSE = "/run/agentos-test-pause"

def pause_count(name):
    return int(machine.succeed(f"journalctl --no-pager -o cat | grep -cxF '[pause] {name}' || true").strip() or 0)

def wait_pause(name, before, timeout=120):
    machine.wait_until_succeeds(f"test $(journalctl --no-pager -o cat | grep -cxF '[pause] {name}') -gt {before}", timeout=timeout)

def call_bg(n, reqs, tag):
    """Like call(), but returns at once: the request runs in the tty n login while the test does other things."""
    body = json.dumps([{"methodId": "session.bind"}] + reqs, ensure_ascii=False)
    machine.succeed(f"echo {base64.b64encode(body.encode()).decode()} | base64 -d > /tmp/{tag}.json && chmod 0644 /tmp/{tag}.json")
    out = f"/tmp/{tag}"
    machine.send_key(f"alt-f{n}")
    machine.wait_until_succeeds(f"grep -qx tty{n} /sys/class/tty/tty0/active")
    script = f"{RPC} @/tmp/{tag}.json > {out} 2>&1; echo done >> {out}\n"
    machine.succeed(f"echo {base64.b64encode(script.encode()).decode()} | base64 -d > {out}.sh && chmod 0644 {out}.sh && rm -f {out}")
    machine.send_chars(f"sh {out}.sh &\n")
    return out

def bg_lines(out, timeout=240):
    machine.wait_until_succeeds(f"grep -q '^done$' {out}", timeout=timeout)
    return [json.loads(l) for l in machine.succeed(f"cat {out}").splitlines() if l.startswith("{")][1:]

def ws_sql(ws, q):
    return machine.succeed(f"sqlite3 /var/lib/agentos/workspaces/{ws}/data/os.sqlite \"{q}\"").strip()

def host_pid(ws):
    u = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws}/data").strip()
    return machine.succeed(f"pgrep -u {u} -f packages/host/dist/main.js | head -1").strip()

def editor(name, pw, tty):
    uid = make_user(name, pw, "u" + name)
    tty_login(tty, name, pw)
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": uid, "role": "viewer"}}], name + "v")[0]
    assert r["status"] == 200, r
    mv = int(sql(f"SELECT member_version FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{uid}'"))
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": uid, "role": "editor", "expectedMemberVersion": mv}}], name + "e")[0]
    assert r["status"] == 200, r
    for i in range(30):
        if ws_sql(ws_a, f"SELECT role || state FROM membership_mirror WHERE user_id='{uid}'") == "editoractive":
            break
        time.sleep(1)
    return uid

def revoke(uid, tag):
    rid = str(uuid.uuid4())
    r = call(1, [{"methodId": "members.revoke", "workspaceId": ws_a, "idempotencyKey": rid, "body": {"userId": uid}}], tag)[0]
    assert r["status"] in (200, 201, 202), r
    return rid

def member_view(uid, tag):
    """What the owner's UI shows for that member (members.list through the gateway)."""
    r = call(1, [{"methodId": "members.list", "workspaceId": ws_a}], tag)[0]
    assert r["status"] == 200, r
    ms = (r.get("body") or {}).get("members") or []
    m = [x for x in ms if x.get("userId") == uid]
    return m[0].get("state") if m else "absent"

def ok_status(r):
    return r["status"] in (200, 201, 202)

r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": "att-f03", "body": {}}], "f03att")[0]
assert r["status"] == 200, r
machine.succeed(f"echo 1 > {FM}/hold")

with subtest("F03a: revocation lands while an admitted write waits before its commit: the write commits once, the client is told so, the revocation completes after; a second client of the same user is refused at once (I06)"):
    dave = editor("dave", "dave-pw-1", 3)
    tty_login(4, "dave", "dave-pw-1")                       # dave's second, simultaneous client
    machine.succeed(f"printf %s {dave} > {PAUSE}/gateway.write.before_commit")
    n0 = pause_count("gateway.write.before_commit")
    out = call_bg(3, [fwd(ws_a, "runs.post", body={"intent": "做一个书签应用", "targetAppId": None}, idem="f03a")], "f03a")
    wait_pause("gateway.write.before_commit", n0)
    rid = revoke(dave, "f03ar")
    # the second client is refused at the gateway while the Host is still inside the first write
    r2 = call(4, [fwd(ws_a, "runs.post", body={"intent": "再做一个", "targetAppId": None}, idem="f03a2"), fwd(ws_a, "runs.list")], "f03a2")
    assert all(not ok_status(x) for x in r2), r2
    assert sql(f"SELECT state FROM revocations WHERE revocation_id='{rid}'") == "revoking"
    assert member_view(dave, "f03av1") in ("revoking", "absent"), "the owner's view must not show the revocation as complete before every ack"
    machine.succeed(f"rm -f {PAUSE}/gateway.write.before_commit")
    res = bg_lines(out)[0]
    print("F03a write result", res)
    n_runs = int(ws_sql(ws_a, f"SELECT COUNT(*) FROM runs WHERE initiator_user_id='{dave}'"))
    assert ok_status(res) == (n_runs == 1) and n_runs in (0, 1), (res, n_runs)   # told success iff the fact exists
    assert ok_status(res), res        # admitted and committed before this Host applied the revocation: kept (spec I06)
    wait_revoked(rid)
    assert sql(f"SELECT state FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{dave}'") == "revoked"
    assert ws_sql(ws_a, f"SELECT state FROM membership_mirror WHERE user_id='{dave}'") != "active"
    assert ws_sql(ws_a, f"SELECT COUNT(*) FROM revocation_receipts WHERE revocation_id='{rid}'") == "1"
    assert member_view(dave, "f03av2") in ("revoked", "absent")
    # the committed run does not keep running for a revoked member; the replayed key returns the same fact or is refused
    machine.wait_until_succeeds(f"sqlite3 /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite \"SELECT status FROM runs WHERE initiator_user_id='{dave}'\" | grep -qvE 'queued|running|blocked'", timeout=120)
    r3 = call(4, [fwd(ws_a, "runs.post", body={"intent": "做一个书签应用", "targetAppId": None}, idem="f03a")], "f03a3")[0]
    assert not ok_status(r3), r3
    assert int(ws_sql(ws_a, f"SELECT COUNT(*) FROM runs WHERE initiator_user_id='{dave}'")) == 1

with subtest("F03b: the Host dies inside the write before its commit while a revocation is pending: no fact, the client is not told success, the revocation completes once on the restarted Host (I06)"):
    erin = editor("erin", "erin-pw-1", 5)
    machine.succeed(f"printf %s {erin} > {PAUSE}/gateway.write.before_commit")
    n0 = pause_count("gateway.write.before_commit")
    out = call_bg(5, [fwd(ws_a, "runs.post", body={"intent": "做一个相册应用", "targetAppId": None}, idem="f03b")], "f03b")
    wait_pause("gateway.write.before_commit", n0)
    rid = revoke(erin, "f03br")
    pid = host_pid(ws_a)
    machine.succeed(f"kill -KILL {pid}; rm -f {PAUSE}/gateway.write.before_commit")
    res = bg_lines(out)[0]
    print("F03b write result", res)
    assert not ok_status(res), res
    wait_revoked(rid, timeout=180)
    assert int(ws_sql(ws_a, f"SELECT COUNT(*) FROM runs WHERE initiator_user_id='{erin}'")) == 0
    assert ws_sql(ws_a, f"SELECT COUNT(*) FROM operations WHERE principal LIKE '%{erin}%'") == "0"
    assert ws_sql(ws_a, f"SELECT COUNT(*) FROM revocation_receipts WHERE revocation_id='{rid}'") == "1"
    assert member_view(erin, "f03bv") in ("revoked", "absent")
    assert host_pid(ws_a) != pid

with subtest("F03c: after the Host applied the new member version but before its ack: requests refused, root side still revoking, the owner's view not complete; a Host crash there re-applies once and acks (I06)"):
    frank = editor("frank", "frank-pw-1", 6)
    machine.succeed(f"touch {PAUSE}/registry.before_ack")
    n0 = pause_count("registry.before_ack")
    rid = revoke(frank, "f03cr")
    wait_pause("registry.before_ack", n0)
    assert ws_sql(ws_a, f"SELECT state FROM membership_mirror WHERE user_id='{frank}'") != "active"
    assert ws_sql(ws_a, f"SELECT COUNT(*) FROM revocation_receipts WHERE revocation_id='{rid}'") == "1"
    assert sql(f"SELECT state FROM revocations WHERE revocation_id='{rid}'") == "revoking"
    assert member_view(frank, "f03cv1") in ("revoking", "absent")
    r = call(6, [fwd(ws_a, "runs.post", body={"intent": "做一个日程应用", "targetAppId": None}, idem="f03c"), fwd(ws_a, "runs.list")], "f03c")
    assert all(not ok_status(x) for x in r), r
    time.sleep(5)
    assert sql(f"SELECT state FROM revocations WHERE revocation_id='{rid}'") == "revoking"   # no ack, no completion
    pid = host_pid(ws_a)
    machine.succeed(f"kill -KILL {pid}; rm -f {PAUSE}/registry.before_ack")
    wait_revoked(rid, timeout=180)
    assert ws_sql(ws_a, f"SELECT COUNT(*) FROM revocation_receipts WHERE revocation_id='{rid}'") == "1"
    assert int(ws_sql(ws_a, f"SELECT COUNT(*) FROM runs WHERE initiator_user_id='{frank}'")) == 0
    assert member_view(frank, "f03cv2") in ("revoked", "absent")
