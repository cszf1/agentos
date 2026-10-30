# M8/M9 machine backup and restore on real UIDs in a NixOS VM (spec §24; V1-R02 R06 R07 R08 R11). Prepended with
# lib.py and members_lib.py. Two workspaces with running Hosts; all requests go through the real gateway from PAM
# logins on VTs. Results are "KVM VM" evidence. "Power cut" here is a killed orchestrator (exit at a fault point)
# and a restarted machined, not a cut VM.
SNAP = "/var/lib/agentos-snapshots"

def ctl(args, ok=True, env=""):
    rc, out = machine.execute(f"{env} agentosctl {args}")
    if ok:
        assert rc == 0, (args, out)
        return json.loads(out[out.index("{"):])
    return rc, out

def host_running(uid):
    return machine.execute(f"pgrep -u {uid} -f packages/host/dist/main.js")[0] == 0

machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws_a, mid0 = out["workspaceId"], out["machineInstallId"]
machine.wait_for_unit("agentos-broker.service")
tty_login(1, "alice", "alice-pw-1")
alice = sql("SELECT user_id FROM users WHERE login_name='alice'")
bob = make_user("bob", "bob-pw-1", "ub")
carol = make_user("carol", "carol-pw-1", "uc")
tty_login(2, "bob", "bob-pw-1")
r = call(1, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "B"}}], "cb")[0]
assert r["status"] == 201, r
ws_b = r["body"]["workspaceId"]
for ws, tag in ((ws_a, "aa"), (ws_b, "ab")):
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": "att-" + tag, "body": {}}], tag)[0]
    assert r["status"] == 200, r
ua = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_a}/data").strip()
ub = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_b}/data").strip()
assert ua != ub
for ws in (ws_a, ws_b):
    machine.wait_until_succeeds(f"test -s /var/lib/agentos/workspaces/{ws}/data/agent.sqlite", timeout=120)
for u in (bob, carol):
    # a new member starts as viewer; promotion names the member version it was decided on (§7.1)
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": u, "role": "viewer"}}], "sv" + u[:4])[0]
    assert r["status"] == 200, r
    mv = int(sql(f"SELECT member_version FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{u}'"))
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": u, "role": "editor", "expectedMemberVersion": mv}}], "sr" + u[:4])[0]
    assert r["status"] == 200, r

with subtest("a backup that dies under its barrier freezes every workspace; abandon releases it (R02)"):
    rc, o = ctl(f"backup --out {SNAP}/dead", ok=False, env="AGENTOS_FAULT_POINT=backup.after_first_workspace")
    assert rc == 9, o
    assert sql("SELECT COUNT(*) FROM barriers WHERE state='held'") == "1"
    assert not host_running(ua) and not host_running(ub)       # both pairs stopped before any snapshot
    for ws, tag in ((ws_a, "f1"), (ws_b, "f2")):
        r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], tag)[0]
        assert r["status"] != 200, r                           # no participant can start under the barrier
    machine.succeed(f"systemctl --user -M {ua}@ start agentos-host@{ws_a}.service || true")
    time.sleep(5)
    assert not host_running(ua)                                # nor can its user manager slip a Host in
    v = ctl("backup abandon")
    assert v["abandoned"], v
    assert sql("SELECT COUNT(*) FROM barriers WHERE state='held'") == "0"
    assert "abandoned" in sql("SELECT state FROM checkpoint_sets ORDER BY created_at DESC LIMIT 1")

with subtest("one machine set over both workspaces, taken under one barrier, both restarted afterwards (R02, R01)"):
    for ws, tag in ((ws_a, "g1"), (ws_b, "g2")):
        r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], tag)[0]
        assert r["status"] == 200, r
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js && pgrep -u {ub} -f packages/host/dist/main.js", timeout=120)
    v = ctl(f"backup --out {SNAP}/m1")
    assert v["ok"] and v["workspaces"] == 2 and sorted(v["restarted"]) == sorted([ws_a, ws_b]), v
    setj = json.loads(machine.succeed(f"cat {SNAP}/m1/machine-set.json"))
    assert {w["workspaceId"] for w in setj["workspaces"]} == {ws_a, ws_b}
    assert len({w["checkpoint"]["barrierId"] if isinstance(w["checkpoint"], dict) and "barrierId" in w["checkpoint"] else setj["barrierId"] for w in setj["workspaces"]}) == 1
    assert sql(f"SELECT state FROM checkpoint_sets WHERE set_id='{v['setId']}'") == "complete"
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js && pgrep -u {ub} -f packages/host/dist/main.js", timeout=120)
    set_id = v["setId"]

with subtest("after the backup: revoke bob, disable carol, leave a machine plan open"):
    r = call(1, [{"methodId": "members.revoke", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob}}], "rv")[0]
    assert r["status"] == 202, r
    machine.wait_until_succeeds(f"sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT state FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{bob}'\" | grep -qx revoked", timeout=90)
    p = call(1, [{"methodId": "machine.users.disable", "idempotencyKey": str(uuid.uuid4()), "body": {"userId": carol}}], "dc")[0]
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], "dcc")[0]
    assert '"succeeded"' in json.dumps(ok), ok
    stale = call(1, [{"methodId": "machine.users.create", "idempotencyKey": str(uuid.uuid4()), "body": {"loginName": "dave", "role": "user", "password": "dave-pw-1"}}], "sp")[0]
    assert stale["status"] == 201, stale
    epoch0 = int(sql("SELECT machine_control_epoch FROM machine_meta"))
    inc0 = {w: int(sql(f"SELECT workspace_incarnation FROM workspaces WHERE workspace_id='{w}'")) for w in (ws_a, ws_b)}

with subtest("a restore cut after the first workspace stays restore-in-progress; nothing starts (R08)"):
    rc, o = ctl(f"restore --set {SNAP}/m1", ok=False, env="AGENTOS_FAULT_POINT=restore.after_first_workspace")
    assert rc == 9, o
    rid = sql("SELECT restore_id FROM restore_jobs WHERE state NOT IN ('complete','abandoned')")
    assert sql("SELECT restore_state FROM machine_meta") == "in_progress"
    machine.succeed("test -f /var/lib/agentos-machine/restore-in-progress")
    assert not host_running(ua) and not host_running(ub)
    machine.succeed("systemctl restart agentos-machine.service agentos-session-gateway.service")   # machined restarts mid-restore
    machine.wait_for_unit("agentos-session-gateway.service")
    assert sql("SELECT restore_state FROM machine_meta") == "in_progress"
    rc, o = machine.execute(f"{RPC} '[{{\"methodId\":\"session.bind\"}}]' 2>&1")
    out = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.attach\",\"workspaceId\":\"{ws_b}\",\"idempotencyKey\":\"x1\",\"body\":{{}}}}]'", "/tmp/h1")
    lines = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert all(x["status"] != 200 for x in lines[1:]), lines       # no mixed business start
    time.sleep(3)
    assert not host_running(ub)
    v = ctl(f"restore --set {SNAP}/m1 --restore-id {rid}")
    assert v["ok"] and v["state"] == "complete", v
    assert sql("SELECT restore_state FROM machine_meta") == "idle"
    machine.fail("test -f /var/lib/agentos-machine/restore-in-progress")

with subtest("restore raises the control epoch and both incarnations; the old plan is dead (R07)"):
    assert int(sql("SELECT machine_control_epoch FROM machine_meta")) > epoch0
    for w in (ws_a, ws_b):
        assert int(sql(f"SELECT workspace_incarnation FROM workspaces WHERE workspace_id='{w}'")) == inc0[w] + 1
    r = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": stale["body"]["operationId"], "planHash": stale["body"]["planHash"], "password": "alice-pw-1"}}], "sc")[0]
    assert '"succeeded"' not in json.dumps(r), r
    machine.fail("id dave")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "ra")[0]
    assert r["status"] == 200, r                                  # a fresh bind after the restore works

with subtest("root-side facts newer than the set still hold: bob revoked, carol disabled (R06)"):
    rep = {w["workspaceId"]: w for w in v["workspaces"]}
    assert bob in rep[ws_a]["members"]["rejected"] and carol in rep[ws_a]["members"]["rejected"], rep
    assert sql(f"SELECT state FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{bob}'") == "revoked"
    assert sql(f"SELECT state FROM users WHERE user_id='{carol}'") == "disabled"
    lst = call(2, [{"methodId": "workspaces.list"}], "bl")[0]
    assert ws_a not in json.dumps(lst), lst

with subtest("broker log lost: diagnostics only, never an empty log (R11)"):
    # agentos-broker.path would start the broker again the moment it stops (before the log is removed): hold it
    machine.succeed("systemctl stop agentos-broker.path agentos-broker.service; cp -a /var/lib/agentos-broker /tmp/broker-keep; rm -f /var/lib/agentos-broker/broker.sqlite*")
    machine.succeed("systemctl start agentos-broker.service")
    machine.wait_until_succeeds("journalctl -u agentos-broker -b --no-pager | grep -q BROKER_HISTORY_MISSING", timeout=60)
    machine.fail("test -f /var/lib/agentos-broker/broker.sqlite")
    machine.succeed("systemctl stop agentos-broker.service; cp -a /tmp/broker-keep/. /var/lib/agentos-broker/; systemctl start agentos-broker.service agentos-broker.path")
    machine.wait_for_unit("agentos-broker.service")

with subtest("machine directory lost: recovery mode, then an explicit new identity; old state kept as evidence (R11)"):
    machine.succeed("systemctl stop agentos-session-gateway.service agentos-broker.service agentos-machine.service")
    machine.succeed("rm -f /var/lib/agentos-machine/machine.sqlite /var/lib/agentos-machine/machine.sqlite-wal /var/lib/agentos-machine/machine.sqlite-shm")
    machine.succeed("systemctl start agentos-machine.service")
    machine.wait_for_unit("agentos-machine.service")
    machine.succeed("test -f /var/lib/agentos-machine/recovery-required")
    machine.fail("test -e /var/lib/agentos-machine/machine.sqlite")            # no empty directory was created
    machine.fail("test -S /run/agentos/machine/machine.sock")
    rc, o = machine.execute("agentosctl status 2>&1")
    assert rc != 0 and "recovery mode" in o, o
    rc, o = machine.execute("printf 'x' | agentosctl firstboot --admin eve 2>&1")
    assert rc != 0, o                                                          # first boot cannot silently reopen
    v = ctl("recover --new-identity")
    assert v["ok"], v
    machine.wait_until_succeeds("test -S /run/agentos/machine/machine.sock", timeout=60)
    st = ctl("status")
    assert st["meta"]["machineInstallId"] != mid0 and st["meta"]["firstBootState"] == "open", st
    machine.succeed("ls -d /var/lib/agentos-machine/lost-*/ && test -f /var/lib/agentos-machine/lost-*/machine.secret && test -f /var/lib/agentos-machine/lost-*/broker/broker.sqlite")
    machine.succeed(f"test -d /var/lib/agentos/workspaces/{ws_a}/data")       # old workspace data kept, not registered
    # the broker belongs to the new identity: skipped until it exists, then a fresh log for the new install
    machine.succeed("systemctl restart agentos-broker.service || true")
    machine.succeed("test \"$(systemctl show -p ActiveState --value agentos-broker.service)\" != active")
    machine.execute("printf 'eve-pw-1' | agentosctl firstboot --admin eve --workspace E")
    machine.wait_for_unit("agentos-broker.service")
    machine.succeed("test -f /var/lib/agentos-broker/broker.sqlite")
    machine.fail("journalctl -u agentos-broker --since -2min --no-pager | grep -q 'BROKER_IDENTITY_MISMATCH\\|BROKER_HISTORY_MISSING'")
