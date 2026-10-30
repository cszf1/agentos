# V1-W03 on a real machine: machined is SIGKILLed right after a creation step's effect (account created, stores
# initialised, workspace registered) and before its receipt is written. systemd restarts it, it resumes the
# creation from its own log, and the client's retry with the same idempotency key gets the same single workspace:
# one execution account, one UID, one store, nothing taken over. Prepended with lib.py and members_lib.py.
machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
machine.wait_for_unit("agentos-broker.service")
tty_login(1, "alice", "alice-pw-1")
alice = sql("SELECT user_id FROM users WHERE login_name='alice'")
machine.succeed("mkdir -p /run/agentos-test")

def pid():
    return machine.succeed("systemctl show -p MainPID --value agentos-machine.service").strip()

for step in ["account", "databases", "registry"]:
    with subtest(f"SIGKILL machined after the '{step}' step, before its receipt: one workspace, resumed (W03)"):
        key = str(uuid.uuid4())
        before = pid()
        accounts0 = int(machine.succeed("getent passwd | grep -c 'agentos-ws ' || true").strip() or 0)
        machine.succeed(f"echo create.{step} > /run/agentos-test/machine-fault")
        req = {"methodId": "workspaces.create", "idempotencyKey": key, "body": {"displayName": f"W03 {step}"}}
        r = call(1, [req], f"c-{step}")[0]
        assert r["status"] != 201, r                                       # the creating process died mid-call
        machine.succeed("test ! -e /run/agentos-test/machine-fault")      # the point fired (consumed by machined)
        machine.wait_until_succeeds(f"test \"$(systemctl show -p MainPID --value agentos-machine.service)\" != {before} && test \"$(systemctl show -p MainPID --value agentos-machine.service)\" != 0", timeout=60)
        machine.wait_for_unit("agentos-machine.service")
        print(machine.succeed("journalctl -u agentos-machine -b --no-pager | grep -iE 'resum|creat' | tail -5 || true"))
        # restart reconciliation resumed it; the client's retry (same key) returns that same workspace, stopped
        for i in range(30):
            r = call(1, [req], f"r-{step}-{i}")[0]
            if r["status"] == 201:
                break
            time.sleep(1)
        assert r["status"] == 201, r
        ws = r["body"]["workspaceId"]
        assert sql(f"SELECT COUNT(*) FROM workspaces WHERE display_name='W03 {step}'") == "1"
        assert sql(f"SELECT state FROM workspaces WHERE workspace_id='{ws}'") == "stopped"
        assert sql(f"SELECT COUNT(*) FROM provisioning_steps WHERE provisioning_id='{key}' AND state != 'done'") == "0"
        login = sql(f"SELECT exec_login FROM workspaces WHERE workspace_id='{ws}'")
        uid = sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws}'")
        ent = machine.succeed(f"getent passwd {login}").strip().split(":")
        assert ent[2] == uid and ent[4] == f"agentos-ws {key}", ent      # our marker, our UID
        assert int(machine.succeed("getent passwd | grep -c 'agentos-ws ' || true").strip()) == accounts0 + 1
        machine.succeed(f"test -s /var/lib/agentos/workspaces/{ws}/data/os.sqlite")
        assert sql(f"SELECT state FROM workspace_members WHERE workspace_id='{ws}' AND user_id='{alice}'") == "active"
        lst = call(1, [{"methodId": "workspaces.list"}], f"l-{step}")[0]
        assert json.dumps(lst).count(ws) == 1, lst
        # and it starts as a normal workspace
        r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], f"a-{step}")[0]
        assert r["status"] == 200, r
        machine.wait_until_succeeds(f"pgrep -u {uid} -f packages/host/dist/main.js", timeout=90)
        r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], f"s-{step}")[0]
        assert r["status"] == 200, r

with subtest("UIDs and sub-ID ranges of the resumed workspaces never collide (W03)"):
    assert sql("SELECT COUNT(*) FROM workspaces") == "4"
    assert sql("SELECT COUNT(DISTINCT execution_uid) FROM workspaces") == "4"
    assert sql("SELECT COUNT(DISTINCT subuid_start) FROM workspaces") == "4"
    machine.succeed("test $(cut -d: -f2 /etc/subuid | sort | uniq -d | wc -l) = 0")

with subtest("Pi marker mismatch blocks new tasks; a missing agent.sqlite is never replaced by an empty one (B05)"):
    rows = sql("SELECT workspace_id || '|' || execution_uid || '|' || exec_login FROM workspaces ORDER BY created_at").splitlines()
    (w1, u1, l1), (w2, u2, l2) = [r.split("|") for r in rows[-2:]]
    d1, d2 = f"/var/lib/agentos/workspaces/{w1}/data", f"/var/lib/agentos/workspaces/{w2}/data"
    for w in (w1, w2):
        if sql(f"SELECT state FROM workspaces WHERE workspace_id='{w}'") != "stopped":
            r = call(1, [{"methodId": "workspaces.stop", "workspaceId": w, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "b5s")[0]
            assert r["status"] == 200, r
    machine.wait_until_fails(f"pgrep -u {u1} -f packages/host/dist/main.js", timeout=60)
    machine.succeed(f"test -s {d1}/agent.sqlite && test -s {d2}/agent.sqlite")
    machine.succeed(f"cp -a {d1}/agent.sqlite /root/b05-own.sqlite && rm -f /root/b05-own.sqlite-wal /root/b05-own.sqlite-shm")
    def b05_state(tag):
        r = call(1, [{"methodId": "workspaces.attach", "workspaceId": w1, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "b5a" + tag)[0]
        assert r["status"] == 200, r
        for _ in range(60):
            st = call(1, [fwd(w1, "state.list")], "b5st" + tag)[0]
            if st["status"] == 200:
                return st["body"].get("data") or st["body"]
            time.sleep(2)
        raise AssertionError(st)
    def b05_stop():
        r = call(1, [{"methodId": "workspaces.stop", "workspaceId": w1, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "b5x")[0]
        assert r["status"] == 200, r
        machine.wait_until_fails(f"pgrep -u {u1} -f packages/host/dist/main.js", timeout=60)
    runs0 = machine.succeed(f"sqlite3 {d1}/os.sqlite 'SELECT COUNT(*) FROM runs'").strip()
    # (1) the other workspace's agent store (a valid Pi store with a different storeUUID marker) in w1's place
    machine.succeed(f"rm -f {d1}/agent.sqlite-wal {d1}/agent.sqlite-shm && cp {d2}/agent.sqlite {d1}/agent.sqlite && chown {u1} {d1}/agent.sqlite && chmod 0600 {d1}/agent.sqlite")
    h_other = machine.succeed(f"sqlite3 {d1}/agent.sqlite 'SELECT COUNT(*) FROM sqlite_master'").strip()
    st = b05_state("1")
    print("B05 mismatch", st.get("agentState"), st.get("agentDiagnostic"), st.get("ready"))
    assert st["agentState"] == "blocked" and "storeUUID mismatch" in (st.get("agentDiagnostic") or ""), st
    assert not st["ready"] and not st["modelAvailable"], st
    r = call(1, [fwd(w1, "runs.post", body={"intent": "做一个待办应用", "targetAppId": None}, idem="b05-run")], "b5r")[0]
    print("B05 runs.post", r)
    assert r["status"] not in (200, 201, 202), r
    assert machine.succeed(f"sqlite3 {d1}/os.sqlite 'SELECT COUNT(*) FROM runs'").strip() == runs0          # no new task
    machine.succeed(f"journalctl -b -o cat --no-pager _UID={u1} | grep -q 'workspace pairing failed'")
    b05_stop()
    # (2) agent.sqlite missing for a bound workspace: refused, and no empty replacement store is created
    machine.succeed(f"rm -f {d1}/agent.sqlite {d1}/agent.sqlite-wal {d1}/agent.sqlite-shm")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": w1, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "b5m")[0]
    print("B05 missing attach", r)
    time.sleep(10)
    rc, st2 = machine.execute(f"ls -l {d1}/")
    print(st2)
    machine.succeed(f"journalctl -b -o cat --no-pager _UID={u1} | grep -qE 'agent.sqlite was missing|refusing to create a replacement|agent.sqlite could not be opened'")
    # whatever opened, a new empty Pi store never stands in for the lost one: either no file, or no workspace marker
    # and the Host stays blocked
    if machine.execute(f"test -e {d1}/agent.sqlite")[0] == 0:
        st = b05_state("2")
        assert st["agentState"] == "blocked", st
    assert machine.succeed(f"sqlite3 {d1}/os.sqlite 'SELECT COUNT(*) FROM runs'").strip() == runs0
    b05_stop()
    # (3) the right store back: pairing passes again
    machine.succeed(f"rm -f {d1}/agent.sqlite*; cp /root/b05-own.sqlite {d1}/agent.sqlite && chown {u1} {d1}/agent.sqlite && chmod 0600 {d1}/agent.sqlite")
    st = b05_state("3")
    assert st["agentState"] != "blocked", st
    b05_stop()
