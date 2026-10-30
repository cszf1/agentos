# M3 members, revocation, lock/logout and two parallel workspaces on real UIDs (spec §7, §12, §17; V1-I04 I05(part)
# I06 I08 I09 I10 W04 W07). Prepended with lib.py. Every request goes through the real gateway from a real PAM
# login on a VT; the Host runs under its execution UID. Results are "KVM VM" evidence.
import base64, time, uuid

def call(n, reqs, tag):
    """Run [session.bind, *reqs] inside the tty n login and return the responses after the bind."""
    body = json.dumps([{"methodId": "session.bind"}] + reqs, ensure_ascii=False)
    machine.succeed(f"echo {base64.b64encode(body.encode()).decode()} | base64 -d > /tmp/{tag}.json && chmod 0644 /tmp/{tag}.json")
    out = tty_run(n, f"{RPC} @/tmp/{tag}.json", f"/tmp/{tag}")
    lines = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert len(lines) == len(reqs) + 1, out
    assert lines[0]["status"] == 200, lines[0]
    return lines[1:]

def code(r):
    e = r.get("error")
    if isinstance(e, dict):
        return e.get("code")
    b = r.get("body")
    if isinstance(b, dict):
        if isinstance(b.get("error"), dict):
            return b["error"].get("code")
        return b.get("code")
    return None

def fwd(ws, route, body=None, params=None, idem=None):
    b = {"routeId": route}
    if body is not None:
        b["body"] = body
    if params is not None:
        b["params"] = params
    r = {"methodId": "workspace.forward", "workspaceId": ws, "body": b}
    if idem:
        # the Host takes only lowercase UUID keys: a readable test tag maps to a stable UUID (same tag = same key)
        r["idempotencyKey"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "agentos-test:" + idem))
    return r

def sql(q):
    return machine.succeed(f"sqlite3 /var/lib/agentos-machine/machine.sqlite \"{q}\"").strip()

def make_user(name, pw, tag):
    p = call(1, [{"methodId": "machine.users.create", "idempotencyKey": str(uuid.uuid4()), "body": {"loginName": name, "role": "user", "password": pw}}], tag + "p")[0]
    assert p["status"] == 201, p
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], tag + "c")[0]
    assert '"succeeded"' in json.dumps(ok), ok
    return sql(f"SELECT user_id FROM users WHERE login_name='{name}'")

machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
machine.succeed("systemctl show -p ActiveState --value agentos-broker.service | grep -qx inactive")  # no identity yet: skipped
out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
machine.wait_for_unit("agentos-broker.service")  # started by agentos-broker.path once the identity exists
ws_a = out["workspaceId"]
tty_login(1, "alice", "alice-pw-1")
alice = sql("SELECT user_id FROM users WHERE login_name='alice'")
bob = make_user("bob", "bob-pw-1", "ub")
carol = make_user("carol", "carol-pw-1", "uc")
tty_login(2, "bob", "bob-pw-1")
tty_login(3, "carol", "carol-pw-1")
r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": "att-a", "body": {}}], "a0")[0]
assert r["status"] == 200, r
ua = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_a}/data").strip()

def until_synced(n, req, tag, tries=20):
    for i in range(tries):
        r = call(n, [req], f"{tag}{i}")[0]
        if code(r) not in ("REGISTRY_NOT_SYNCED",):
            return r
        time.sleep(1)
    return r

with subtest("viewer: reads, cannot write, cannot manage members (I04)"):
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "viewer"}}], "v1")[0]
    assert r["status"] == 200, r
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "editor"}}], "v1b")[0]
    assert code(r) == "PLAN_STALE", r   # a stale view (no expectedMemberVersion) cannot change an existing member
    lst = call(2, [{"methodId": "workspaces.list"}], "v2")[0]
    assert [w["workspaceId"] for w in lst["body"]["workspaces"]] == [ws_a] and lst["body"]["workspaces"][0]["role"] == "viewer", lst
    r = until_synced(2, fwd(ws_a, "state.list"), "v3")
    assert r["status"] == 200, r
    r = call(2, [fwd(ws_a, "maintenance.control.post", body={"action": "pause"}, idem="vw-1")], "v4")[0]
    assert r["status"] == 404 and code(r) == "NOT_FOUND_OR_FORBIDDEN", r
    r = call(2, [{"methodId": "members.list", "workspaceId": ws_a}], "v5")[0]
    assert code(r) == "NOT_FOUND_OR_FORBIDDEN", r
    r = call(2, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": carol, "role": "viewer"}}], "v6")[0]
    assert code(r) == "NOT_FOUND_OR_FORBIDDEN", r

with subtest("editor writes data but cannot take owner actions; owner can (I04)"):
    mv = int(sql(f"SELECT member_version FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{bob}'"))
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "editor", "expectedMemberVersion": mv}}], "e1")[0]
    assert r["status"] == 200, r
    r = until_synced(2, fwd(ws_a, "maintenance.control.post", body={"action": "pause"}, idem="ed-1"), "e2")
    assert r["status"] == 404 and code(r) == "NOT_FOUND_OR_FORBIDDEN", r   # Host matrix: approve_policy is owner only
    r = call(1, [fwd(ws_a, "maintenance.control.post", body={"action": "pause"}, idem="ow-1")], "e3")[0]
    assert r["status"] == 200, r
    r = call(1, [fwd(ws_a, "maintenance.control.post", body={"action": "resume"}, idem="ow-2")], "e4")[0]
    assert r["status"] == 200, r
    r = call(2, [fwd(ws_a, "runs.list")], "e5")[0]
    assert r["status"] == 200, r

with subtest("a machine administrator gets no data entry into a workspace they are not a member of (I04, I03)"):
    r = call(2, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "Bob"}}], "m1")[0]
    assert r["status"] == 201, r
    ws_b = r["body"]["workspaceId"]
    rs = call(1, [{"methodId": "workspaces.get", "workspaceId": ws_b}, fwd(ws_b, "state.list"), {"methodId": "members.list", "workspaceId": ws_b}], "m2")
    assert all(x["status"] == 404 and code(x) == "NOT_FOUND_OR_FORBIDDEN" for x in rs), rs
    lst = call(1, [{"methodId": "workspaces.list"}], "m3")[0]
    assert ws_b not in json.dumps(lst), lst

with subtest("two Hosts run in parallel; killing one does not stop the other (W04)"):
    r = call(2, [{"methodId": "workspaces.attach", "workspaceId": ws_b, "idempotencyKey": "att-b", "body": {}}], "w1")[0]
    assert r["status"] == 200, r
    ub = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_b}/data").strip()
    assert ub != ua
    machine.succeed(f"pgrep -u {ua} -f packages/host/dist/main.js && pgrep -u {ub} -f packages/host/dist/main.js")
    machine.succeed(f"pkill -9 -u {ua} -f packages/host/dist/main.js")
    r = call(2, [fwd(ws_b, "state.list")], "w2")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js", timeout=60)   # Restart=on-failure
    for i in range(30):
        r = call(1, [fwd(ws_a, "state.list")], f"w3{i}")[0]
        if r["status"] == 200:
            break
        time.sleep(2)
    assert r["status"] == 200, r

with subtest("revocation while the Host runs: writes stop at once, completes only after every ack (I06)"):
    rid = str(uuid.uuid4())
    r = call(1, [{"methodId": "members.revoke", "workspaceId": ws_a, "idempotencyKey": rid, "body": {"userId": bob}}], "r1")[0]
    assert r["status"] == 202, r
    r = call(2, [fwd(ws_a, "state.list"), fwd(ws_a, "runs.list")], "r2")
    assert all(x["status"] != 200 for x in r), r
    machine.wait_until_succeeds(f"test \"$(sqlite3 /var/lib/agentos-machine/machine.sqlite \\\"SELECT state FROM revocations WHERE revocation_id='{rid}'\\\")\" = revoked", timeout=90)
    assert sql(f"SELECT state FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{bob}'") == "revoked"
    lst = call(2, [{"methodId": "workspaces.list"}], "r3")[0]
    assert ws_a not in json.dumps(lst), lst

with subtest("revocation while the Host is stopped stays 'revoking' until that Host acks (I08)"):
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": carol, "role": "viewer"}}], "f1")[0]
    assert r["status"] == 200, r
    r = until_synced(3, fwd(ws_a, "state.list"), "f2")
    assert r["status"] == 200, r
    r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws_a, "idempotencyKey": "stop-a", "body": {}}], "f3")[0]
    assert r["status"] == 200, r
    machine.wait_until_fails(f"pgrep -u {ua} -f packages/host/dist/main.js")
    rid2 = str(uuid.uuid4())
    r = call(1, [{"methodId": "members.revoke", "workspaceId": ws_a, "idempotencyKey": rid2, "body": {"userId": carol}}], "f4")[0]
    assert r["status"] == 202, r
    r = call(3, [{"methodId": "workspaces.get", "workspaceId": ws_a}, fwd(ws_a, "state.list")], "f5")
    assert all(x["status"] != 200 for x in r), r     # gateway refuses at once, before the Host knows
    time.sleep(8)
    assert sql(f"SELECT state FROM revocations WHERE revocation_id='{rid2}'") == "revoking"
    assert sql(f"SELECT state FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{carol}'") == "revoking"
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": "att-a2", "body": {}}], "f6")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"test \"$(sqlite3 /var/lib/agentos-machine/machine.sqlite \\\"SELECT state FROM revocations WHERE revocation_id='{rid2}'\\\")\" = revoked", timeout=90)

with subtest("the last owner cannot be removed; a disabled account gets nothing new (I09)"):
    r = call(1, [{"methodId": "members.revoke", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": alice}}], "o1")[0]
    assert code(r) == "CONFLICT", r
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": alice, "role": "viewer"}}], "o2")[0]
    assert r["status"] != 200, r
    p = call(1, [{"methodId": "machine.users.disable", "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob}}], "o3")[0]
    assert p["status"] == 201, p
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], "o4")[0]
    assert '"succeeded"' in json.dumps(ok), ok
    out = tty_run(2, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.list\"}}]'", "/tmp/o5")
    lines = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert lines[0]["status"] != 200, lines

with subtest("lock and logout end old session epochs (I10)"):
    # a stale sessionEpoch in an otherwise valid connection is refused
    out = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.list\",\"sessionEpoch\":999}}]'", "/tmp/l1")
    lines = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert lines[0]["status"] == 200 and lines[1]["status"] != 200, lines
    # session.end: the same connection cannot continue
    out = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"session.end\"}},{{\"methodId\":\"workspaces.list\"}}]'", "/tmp/l2")
    lines = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert lines[2]["status"] != 200, lines
    # a locked logind session (LockedHint) cannot bind
    tty_run(3, "busctl call org.freedesktop.login1 /org/freedesktop/login1/session/auto org.freedesktop.login1.Session SetLockedHint b true", "/tmp/l3")
    machine.wait_until_succeeds(f"loginctl show-session {user_session('carol', 'tty3')} -p LockedHint | grep -q yes")
    out = tty_run(3, f"{RPC} '[{{\"methodId\":\"session.bind\"}}]'", "/tmp/l4")
    lines = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert lines[0]["status"] != 200, lines
    tty_run(3, "busctl call org.freedesktop.login1 /org/freedesktop/login1/session/auto org.freedesktop.login1.Session SetLockedHint b false", "/tmp/l5")
    out = tty_run(3, f"{RPC} '[{{\"methodId\":\"session.bind\"}}]'", "/tmp/l6")
    assert '"status": 200' in out, out

with subtest("stop and archive keep the data; an archived workspace does not start (W07)"):
    # bob is disabled: the machine stops his workspace through its owner path only after re-enable; use alice's A
    r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws_a, "idempotencyKey": "stop-a2", "body": {}}], "s1")[0]
    assert r["status"] == 200 and r["body"]["state"] == "stopped", r
    machine.succeed(f"test -s /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite && test -s /var/lib/agentos/workspaces/{ws_a}/data/agent.sqlite")
    machine.fail(f"pgrep -u {ua} -f 'packages/host/dist/main.js|podman|conmon'")
    r = call(1, [{"methodId": "workspaces.archive", "workspaceId": ws_a, "idempotencyKey": "arc-a", "body": {}}], "s2")[0]
    assert r["status"] == 200 and r["body"]["state"] == "archived", r
    machine.succeed(f"test -s /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": "att-a3", "body": {}}], "s3")[0]
    assert r["status"] != 200, r

with subtest("PAM passwords given to the gateway are not in argv, logs or machine state (I11)"):
    machine.succeed("(for i in $(seq 1 400); do cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' ' >> /root/argv.log; echo >> /root/argv.log; sleep 0.05; done) >/dev/null 2>&1 &")
    make_user("dave", "dave-secret-pw-9", "ud")
    machine.succeed("sleep 21")
    for pw in ["alice-pw-1", "bob-pw-1", "carol-pw-1", "dave-secret-pw-9"]:
        machine.fail(f"grep -F -- {pw} /root/argv.log")
        machine.fail(f"journalctl -o cat --no-pager | grep -F -- {pw}")
        machine.fail(f"grep -rF -- {pw} /var/lib/agentos-machine /var/lib/agentos-broker /var/lib/agentos /var/log /run/agentos 2>/dev/null")
    machine.succeed("test $(wc -l < /root/argv.log) -gt 100")
