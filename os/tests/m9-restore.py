# M8/M9 machine backup and restore on real UIDs in a NixOS VM (spec §24; V1-R02 R06 R07 R08 R11). Prepended with
# lib.py and members_lib.py. Two workspaces with running Hosts; all requests go through the real gateway from PAM
# logins on VTs. Results are "KVM VM" evidence. "Power cut" here is a killed orchestrator (exit at a fault point)
# and a restarted machined, not a cut VM.
SNAP = "/var/lib/agentos-snapshots"

def ctl(args, ok=True, env=""):
    rc, out = machine.execute(f"{env} agentosctl {args}" + ("" if ok else " 2>&1"))
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
    # R09 seed, while A's Host is down after the abandoned backup: an old delete intent left in 'unknown' and a cache
    # row that claims a built artifact whose files are not on disk
    assert not host_running(ua)
    osa = f"/var/lib/agentos/workspaces/{ws_a}/data/os.sqlite"
    machine.succeed(f"setpriv --reuid {ua} --regid {ua} --clear-groups sqlite3 {osa} \"INSERT INTO gc_delete_intents (id, object_kind, object_id, gc_generation, source_path, phase, created_at, updated_at) VALUES ('r09-intent','staging','.staging-r09',1,'.staging-r09','unknown','2026-10-31T00:00:00Z','2026-10-31T00:00:00Z'); INSERT INTO artifacts (id, build_key, runtime_lock_id, platform, manifest_json, relative_path, size_bytes, created_at) VALUES ('{'0' * 64}','bk-r09','lock-r09','linux/amd64','{{}}','{'0' * 64}',1,'2026-10-31T00:00:00Z')\"")
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

with subtest("a local set is not an off-machine copy until exported and read back; a full/read-only disk stops new sets and workspaces (R12)"):
    c0 = sql(f"SELECT export_state FROM checkpoint_sets WHERE set_id='{set_id}'")
    assert c0 == "none", c0
    machine.succeed("age-keygen -o /root/off.key 2>/root/off.pub")
    rec = machine.succeed("grep -o 'age1[a-z0-9]*' /root/off.pub").strip()
    machine.succeed("mkdir -p /media/offsite")
    e = ctl(f"backup export --set {SNAP}/m1 --recipient {rec} --out /media/offsite/m1")
    assert e["exportState"] == "verified" and e["offMachineCopy"] is True and len(e["files"]) == 3, e
    assert sql(f"SELECT export_state FROM checkpoint_sets WHERE set_id='{set_id}'") == "verified"
    # the copy really is a recoverable set: decrypt one workspace part to an empty staging dir and verify it
    machine.succeed(f"agentos-recovery-worker import --in /media/offsite/m1/ws-{ws_a}.age --identity /root/off.key --staging /root/offcheck | grep -q '\"ok\":true'")
    machine.succeed("age -d -i /root/off.key /media/offsite/m1/machine-set.json.age | grep -q agentos-machine-set")
    # exporting a set that does not match machined's record is refused and changes nothing
    machine.succeed(f"cp -a {SNAP}/m1 /root/m1-bad && sed -i 's/agentos-machine-set/agentos-machine-sex/' /root/m1-bad/machine-set.json")
    rc, o = ctl(f"backup export --set /root/m1-bad --recipient {rec} --out /media/offsite/bad", ok=False)
    assert rc != 0 and "manifest hash" in o, o
    machine.fail("test -e /media/offsite/bad")
    # read-only snapshot store: no new set (refused before any workspace is stopped), no new workspace; existing set kept
    audit0 = int(sql("SELECT COUNT(*) FROM root_audit"))
    machine.succeed(f"mount --bind {SNAP} {SNAP} && mount -o remount,bind,ro {SNAP}")
    rc, o = ctl(f"backup --out {SNAP}/full", ok=False)
    assert rc != 0 and "MACHINE_CAPACITY" in o, o
    assert sql("SELECT COUNT(*) FROM barriers WHERE state='held'") == "0"
    assert host_running(ua) and host_running(ub), "a refused backup leaves running workspaces running"
    r = call(1, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "Full"}}], "rf")[0]
    assert r["status"] != 201 and code(r) == "MACHINE_CAPACITY", r
    assert sql(f"SELECT state || ' ' || export_state FROM checkpoint_sets WHERE set_id='{set_id}'") == "complete verified"
    assert int(sql("SELECT COUNT(*) FROM root_audit")) >= audit0
    machine.succeed(f"umount {SNAP}")
    machine.succeed(f"touch {SNAP}/.writable && rm {SNAP}/.writable")

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

with subtest("after a machine restore the Host reconciles before opening: old delete intents never act, missing cache is not 'live' (R09)"):
    osa = f"/var/lib/agentos/workspaces/{ws_a}/data/os.sqlite"
    rq = lambda q: machine.succeed(f"setpriv --reuid {ua} --regid {ua} --clear-groups sqlite3 {osa} \"{q}\"").strip()
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "r9a")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"test ! -e /var/lib/agentos/workspaces/{ws_a}/data/restore-reconcile-pending", timeout=120)
    assert rq("SELECT phase FROM gc_delete_intents WHERE id='r09-intent'") == "aborted"
    assert rq(f"SELECT gc_state || ' ' || gc_generation FROM artifacts WHERE id='{'0' * 64}'") == "unavailable 2"
    assert int(rq("SELECT COUNT(*) FROM events WHERE kind='workspace.v04_restored'")) >= 1
    assert int(rq("SELECT COUNT(*) FROM maintenance_policies WHERE state IN ('enabled','syncing')")) == 0

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
    # the new identity is an uninstalled machine, exactly like a fresh one before first boot
    rc, o = machine.execute("agentosctl status 2>&1")
    assert rc != 0 and "not installed" in o, o
    machine.succeed("ls -d /var/lib/agentos-machine/lost-*/ && test -f /var/lib/agentos-machine/lost-*/machine.secret && test -f /var/lib/agentos-machine/lost-*/broker/broker.sqlite")
    machine.succeed(f"test -d /var/lib/agentos/workspaces/{ws_a}/data")       # old workspace data kept, not registered
    # the broker belongs to the new identity: skipped until it exists, then a fresh log for the new install
    machine.succeed("systemctl restart agentos-broker.service || true")
    machine.succeed("test \"$(systemctl show -p ActiveState --value agentos-broker.service)\" != active")
    t_fb = machine.succeed("date +%s").strip()                                 # only broker lines after this count
    machine.execute("printf 'eve-pw-1' | agentosctl firstboot --admin eve --workspace E")
    st = ctl("status")
    assert st["meta"]["machineInstallId"] != mid0 and st["meta"]["firstBootState"] == "closed", st   # a new installation identity
    machine.wait_for_unit("agentos-broker.service")
    machine.succeed("test -f /var/lib/agentos-broker/broker.sqlite")
    machine.fail(f"journalctl -u agentos-broker --since @{t_fb} --no-pager | grep -q 'BROKER_IDENTITY_MISMATCH\\|BROKER_HISTORY_MISSING'")
