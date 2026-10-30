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
