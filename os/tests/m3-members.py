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

with subtest("broker protocol 3 end to end: an owner pause reaches the broker as a checked v3 write (M3, I12)"):
    store_a = sql(f"SELECT store_uuid FROM workspaces WHERE workspace_id='{ws_a}'")
    hostdb = f"/var/lib/agentos/workspaces/{ws_a}/data/os.sqlite"
    BDB = "/var/lib/agentos-broker/broker.sqlite"
    def last_control():
        return machine.succeed(f"sqlite3 {hostdb} \"SELECT dispatch_state || ' ' || IFNULL(broker_result,'') FROM root_sync_outbox WHERE kind='control' ORDER BY created_at DESC, rowid DESC LIMIT 1\"").strip()
    def wait_control():
        machine.wait_until_succeeds(f"sqlite3 {hostdb} \"SELECT dispatch_state FROM root_sync_outbox WHERE kind='control' ORDER BY created_at DESC, rowid DESC LIMIT 1\" | grep -qE '^(confirmed|failed)$'", timeout=120)
        return last_control()
    # the owner's pause travels Host → broker (machine mode wraps it in the protocol-3 workspace envelope)
    r = call(1, [fwd(ws_a, "maintenance.control.post", body={"action": "pause"}, idem="p3-1")], "p31")[0]
    assert r["status"] == 200, r
    st = wait_control()
    assert st.startswith("confirmed"), st
    assert machine.succeed(f"sqlite3 {BDB} \"SELECT state FROM workspace_maintenance_state WHERE store_uuid='{store_a}' ORDER BY incarnation DESC LIMIT 1\"").strip() == "paused"
    # the broker checked the principal against its synced directory: a member version it does not know is refused
    # (protocol 1/2 carry no principal at all, so this refusal can only come from the v3 check)
    machine.succeed("systemctl stop agentos-broker.path agentos-broker.service")  # the path unit would restart it at once
    machine.succeed(f"sqlite3 {BDB} \"UPDATE machine_members SET member_version = member_version + 100 WHERE store_uuid='{store_a}' AND user_id='{alice}'\"")
    machine.succeed("systemctl start agentos-broker.service agentos-broker.path")
    machine.wait_for_unit("agentos-broker.service")
    r = call(1, [fwd(ws_a, "maintenance.control.post", body={"action": "resume"}, idem="p3-2")], "p32")[0]
    assert r["status"] == 200, r
    st = wait_control()
    assert st.startswith("failed") and "MEMBERSHIP_REVOKED" in st, st
    assert machine.succeed(f"sqlite3 {BDB} \"SELECT state FROM workspace_maintenance_state WHERE store_uuid='{store_a}' ORDER BY incarnation DESC LIMIT 1\"").strip() == "paused"
    # directory consistent again: the next owner control is accepted
    machine.succeed("systemctl stop agentos-broker.path agentos-broker.service")  # the path unit would restart it at once
    machine.succeed(f"sqlite3 {BDB} \"UPDATE machine_members SET member_version = member_version - 100 WHERE store_uuid='{store_a}' AND user_id='{alice}'\"")
    machine.succeed("systemctl start agentos-broker.service agentos-broker.path")
    machine.wait_for_unit("agentos-broker.service")
    r = call(1, [fwd(ws_a, "maintenance.control.post", body={"action": "resume"}, idem="p3-3")], "p33")[0]
    assert r["status"] == 200, r
    st = wait_control()
    assert st.startswith("confirmed"), st
    assert machine.succeed(f"sqlite3 {BDB} \"SELECT state FROM workspace_maintenance_state WHERE store_uuid='{store_a}' ORDER BY incarnation DESC LIMIT 1\"").strip() == "running"

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
    wait_revoked(rid)
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
    wait_revoked(rid2)

with subtest("the last owner cannot be removed; a disabled account gets nothing new (I09)"):
    r = call(1, [{"methodId": "members.revoke", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": alice}}], "o1")[0]
    assert code(r) == "CONFLICT", r
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": alice, "role": "viewer"}}], "o2")[0]
    assert r["status"] != 200, r
    # bob owns workspace "Bob": disabling him would leave it without an owner → refused with no effect
    p = call(1, [{"methodId": "machine.users.disable", "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob}}], "o3")[0]
    assert p["status"] == 201, p
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], "o4")[0]
    assert ok["body"]["state"] == "failed_no_effect" and ok["body"]["result"]["code"] == "CONFLICT", ok
    # an account that owns nothing is disabled; it can no longer bind a session
    erin = make_user("erin", "erin-pw-1", "ue")
    tty_login(4, "erin", "erin-pw-1")
    p = call(1, [{"methodId": "machine.users.disable", "idempotencyKey": str(uuid.uuid4()), "body": {"userId": erin}}], "o6")[0]
    assert p["status"] == 201, p
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], "o7")[0]
    assert '"succeeded"' in json.dumps(ok), ok
    assert sql(f"SELECT state FROM users WHERE user_id='{erin}'") == "disabled"
    # disabling ends the account's sessions and the account can open no new one (expired + locked)
    machine.wait_until_fails("loginctl list-sessions --no-legend | grep -w erin", timeout=60)
    # root's su skips the password (pam_rootok), so prove it on the account itself and on a real VT login instead
    print(machine.succeed("passwd -S erin; chage -l erin"))
    machine.succeed("passwd -S erin | awk '{print $2}' | grep -qx L")                 # password locked
    machine.succeed("chage -l erin | grep 'Account expires' | grep -q 1970")          # account expired
    machine.send_key("alt-f5")
    machine.succeed("chvt 5; systemctl start getty@tty5.service")
    machine.wait_until_tty_matches("5", "login: ")
    machine.send_chars("erin\n")
    machine.wait_until_tty_matches("5", "Password: ")
    machine.send_chars("erin-pw-1\n")
    machine.wait_until_tty_matches("5", "(Login incorrect|expired)")
    time.sleep(3)
    machine.fail("loginctl list-sessions --no-legend | grep -w erin")               # PAM opened no new session

with subtest("lock and logout end old session epochs (I10)"):
    # a stale sessionEpoch in an otherwise valid connection is refused
    out = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.list\",\"sessionEpoch\":999}}]'", "/tmp/l1")
    lines = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert lines[0]["status"] == 200 and lines[1]["status"] != 200, lines
    # session.end: the same connection cannot continue
    out = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"session.end\",\"idempotencyKey\":\"6f1c1b7e-1c55-4a1e-9a39-0d3f6b8e2a10\"}},{{\"methodId\":\"workspaces.list\"}}]'", "/tmp/l2")
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
    # restore: the owner starts the archived workspace again; the same data comes back under the same execution UID
    r = call(1, [{"methodId": "workspaces.start", "workspaceId": ws_a, "idempotencyKey": "start-a3", "body": {}}], "s4")[0]
    assert r["status"] in (200, 202), r
    assert sql(f"SELECT state FROM workspaces WHERE workspace_id='{ws_a}'") in ("starting", "running"), r
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js", timeout=90)    # a real instance again
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": "att-a4", "body": {}}], "s5")[0]
    assert r["status"] == 200, r
    machine.succeed(f"test $(stat -c %u /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite) = {ua}")
    assert sql(f"SELECT COUNT(*) FROM root_audit WHERE kind='workspace.unarchive' AND scope_id='{ws_a}'") == "1"

with subtest("PAM passwords given to the gateway are not in argv, logs or machine state (I11)"):
    # sampler in its own session (the driver's shell must not reap it); it marks when its 400 samples are done
    machine.succeed("rm -f /root/argv.log /root/argv.done; setsid bash -c 'for i in $(seq 1 400); do cat /proc/[0-9]*/cmdline 2>/dev/null | tr \"\\\\0\" \" \" >> /root/argv.log; echo >> /root/argv.log; sleep 0.05; done; touch /root/argv.done' >/dev/null 2>&1 < /dev/null &")
    machine.wait_until_succeeds("test -s /root/argv.log", timeout=30)
    make_user("dave", "dave-secret-pw-9", "ud")
    machine.wait_until_succeeds("test -e /root/argv.done", timeout=600)
    for pw in ["alice-pw-1", "bob-pw-1", "carol-pw-1", "dave-secret-pw-9"]:
        machine.fail(f"grep -F -- {pw} /root/argv.log")
        machine.fail(f"journalctl -o cat --no-pager | grep -F -- {pw}")
        machine.fail(f"grep -rF -- {pw} /var/lib/agentos-machine /var/lib/agentos-broker /var/lib/agentos /var/log /run/agentos 2>/dev/null")
    machine.succeed("test $(wc -l < /root/argv.log) -gt 100")
    # wider scope: a support bundle, the cold backup sets on this machine, and the running system's whole Nix closure
    machine.succeed("agentosctl support-bundle --out /root/i11-bundle.json && test -s /root/i11-bundle.json")
    machine.succeed("nix-store -qR /run/current-system > /root/i11-closure && test $(wc -l < /root/i11-closure) -gt 100")
    for pw in ["alice-pw-1", "bob-pw-1", "carol-pw-1", "dave-secret-pw-9"]:
        machine.fail(f"grep -aF -- {pw} /root/i11-bundle.json")
        machine.fail(f"grep -raF -- {pw} /var/lib/agentos-snapshots /etc /home 2>/dev/null")
        machine.fail(f"xargs -a /root/i11-closure grep -rlaF -- {pw} 2>/dev/null")

with subtest("delete: owner+admin, broker effect verdict, executors; UID and storeUUID stay as a tombstone (W10)"):
    r = call(1, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "Doomed"}}], "d0")[0]
    assert r["status"] == 201, r
    ws_d = r["body"]["workspaceId"]
    ud = int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws_d}'"))
    login_d = sql(f"SELECT exec_login FROM workspaces WHERE workspace_id='{ws_d}'")
    store_d = sql(f"SELECT store_uuid FROM workspaces WHERE workspace_id='{ws_d}'")
    machine.succeed(f"test -d /var/lib/agentos/workspaces/{ws_d}/data")
    def plan_delete(tag):
        return call(1, [{"methodId": "machine.actions.plan", "idempotencyKey": str(uuid.uuid4()), "body": {"kind": "workspaces.delete", "params": {"workspaceId": ws_d, "dataDisposition": "discard"}}}], tag)[0]
    def confirm(p, tag):
        return call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], tag)[0]
    # not archived yet: the plan is refused with the reason
    r = plan_delete("d1")
    assert r["status"] != 201 and code(r) == "CONFLICT", r
    r = call(1, [{"methodId": "workspaces.archive", "workspaceId": ws_d, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "d2")[0]
    assert r["status"] == 200 and r["body"]["state"] == "archived", r
    # an unreconciled broker effect of this store blocks the deletion (back to archived, data kept)
    machine.succeed("systemctl stop agentos-broker.path agentos-broker.service")  # the path unit would restart it at once
    machine.succeed(f"sqlite3 /var/lib/agentos-broker/broker.sqlite \"INSERT INTO effect_operations(machine_install_id,store_uuid,incarnation,operation_id,action_id,plan_hash,request_hash,envelope_json,capability_id,resource_id,resource_generation,replay_class,state,deadline_ms,accepted_seq,updated_seq,created_at,updated_at) VALUES ('t','{store_d}',1,'w10-op','a','p','r','{{}}','cap','res',1,'effect','indeterminate',1,1,1,1,1)\"")
    machine.succeed("systemctl start agentos-broker.service agentos-broker.path")
    machine.wait_for_unit("agentos-broker.service")
    machine.wait_until_succeeds("test $(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT COUNT(*) FROM registry_outbox WHERE target_kind='broker' AND state='pending'\") = 0", timeout=60)
    p = plan_delete("d4")
    assert p["status"] == 201, p
    ok = confirm(p, "d5")
    assert '"succeeded"' in json.dumps(ok), ok
    machine.wait_until_succeeds(f"sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT delete_json FROM workspaces WHERE workspace_id='{ws_d}'\" | grep -q unresolvedEffects", timeout=60)
    assert sql(f"SELECT state FROM workspaces WHERE workspace_id='{ws_d}'") == "archived"
    machine.succeed(f"test -d /var/lib/agentos/workspaces/{ws_d}/data")
    # reconciled: the second deletion goes through
    machine.succeed("systemctl stop agentos-broker.path agentos-broker.service")  # the path unit would restart it at once
    machine.succeed("sqlite3 /var/lib/agentos-broker/broker.sqlite \"UPDATE effect_operations SET resolution_json='{}' WHERE operation_id='w10-op'\"")
    machine.succeed("systemctl start agentos-broker.service agentos-broker.path")
    machine.wait_for_unit("agentos-broker.service")
    machine.wait_until_succeeds("test $(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT COUNT(*) FROM registry_outbox WHERE target_kind='broker' AND state='pending'\") = 0", timeout=60)
    p = plan_delete("d6")
    assert p["status"] == 201, p
    ok = confirm(p, "d7")
    assert '"succeeded"' in json.dumps(ok), ok
    machine.wait_until_succeeds(f"test $(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT state FROM workspaces WHERE workspace_id='{ws_d}'\") = deleted", timeout=60)
    machine.fail(f"test -e /var/lib/agentos/workspaces/{ws_d}")
    machine.fail(f"test -e /var/lib/agentos-runtime/{ws_d}")
    machine.succeed(f"passwd -S {login_d} | awk '{{print $2}}' | grep -q '^L'")        # account kept, locked: the UID is not reused
    machine.succeed(f"getent passwd {ud}")
    assert sql(f"SELECT store_uuid || ' ' || execution_uid FROM workspaces WHERE workspace_id='{ws_d}'") == f"{store_d} {ud}"
    r = call(1, [{"methodId": "workspaces.list"}], "d8")[0]
    assert ws_d not in json.dumps(r), r
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_d, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "d9")[0]
    assert r["status"] == 404, r
    # a new workspace never reuses the tombstoned execution UID
    r = call(1, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "After"}}], "d10")[0]
    assert r["status"] == 201, r
    r_after = r["body"]["workspaceId"]
    assert int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{r['body']['workspaceId']}'")) != ud
    assert sql("SELECT schema_version FROM machine_meta") == "2"

with subtest("delete with exported data only after an age copy of a set holding it was read back (W10, R12)"):
    r = call(1, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "Exported"}}], "x0")[0]
    assert r["status"] == 201, r
    ws_x = r["body"]["workspaceId"]
    # the workspace holds data before it is exported: its Host ran once (both stores exist), then it was stopped.
    # The machine runs at most two workspaces; earlier subtests leave two running, so alice stops hers first.
    for w in sql("SELECT workspace_id FROM workspaces WHERE state IN ('starting','running')").split():
        if int(sql("SELECT COUNT(*) FROM workspaces WHERE state IN ('starting','running','quiescing')")) < 2:
            break
        call(1, [{"methodId": "workspaces.stop", "workspaceId": w, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "xpre")
    machine.wait_until_succeeds("test $(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT COUNT(*) FROM workspaces WHERE state IN ('starting','running','quiescing')\") -lt 2", timeout=60)
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_x, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "xa")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"test -s /var/lib/agentos/workspaces/{ws_x}/data/agent.sqlite && test -s /var/lib/agentos/workspaces/{ws_x}/data/os.sqlite", timeout=120)
    r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws_x, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "xs")[0]
    assert r["status"] == 200, r
    r = call(1, [{"methodId": "workspaces.archive", "workspaceId": ws_x, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "x1")[0]
    assert r["status"] == 200 and r["body"]["state"] == "archived", r
    rc, o = machine.execute("agentosctl backup --out /var/lib/agentos-snapshots/x1 --include-archived 2>&1")
    assert rc == 0, o
    bk = json.loads(o[o.index("{"):])
    set_x = bk["setId"]
    assert ws_x in machine.succeed("cat /var/lib/agentos-snapshots/x1/machine-set.json")
    # "After" was created (workspace-init wrote os.sqlite) but its Host never ran: listed as neverStarted, not a failure
    ms = json.loads(machine.succeed("cat /var/lib/agentos-snapshots/x1/machine-set.json"))
    assert any(n["workspaceId"] == r_after for n in ms.get("neverStarted", [])), ms
    def plan_x(tag):
        return call(1, [{"methodId": "machine.actions.plan", "idempotencyKey": str(uuid.uuid4()), "body": {"kind": "workspaces.delete", "params": {"workspaceId": ws_x, "dataDisposition": "exported", "exportSetId": set_x}}}], tag)[0]
    def confirm_x(p, tag):
        return call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], tag)[0]
    # a local set only: the exported deletion is refused at dispatch and the workspace stays archived with its data
    p = plan_x("x2")
    if p["status"] == 201:
        ok = confirm_x(p, "x3")
        assert '"succeeded"' not in json.dumps(ok), ok
    assert sql(f"SELECT state FROM workspaces WHERE workspace_id='{ws_x}'") == "archived"
    machine.succeed(f"test -d /var/lib/agentos/workspaces/{ws_x}/data")
    machine.succeed("age-keygen -o /root/x.key 2>/root/x.pub && mkdir -p /media/x")
    rec = machine.succeed("grep -o 'age1[a-z0-9]*' /root/x.pub").strip()
    rc, o = machine.execute(f"agentosctl backup export --set /var/lib/agentos-snapshots/x1 --recipient {rec} --out /media/x/x1 2>&1")
    assert rc == 0 and '"verified"' in o, o
    p = plan_x("x4")
    assert p["status"] == 201, p
    ok = confirm_x(p, "x5")
    assert '"succeeded"' in json.dumps(ok), ok
    machine.wait_until_succeeds(f"test $(sqlite3 /var/lib/agentos-machine/machine.sqlite \"SELECT state FROM workspaces WHERE workspace_id='{ws_x}'\") = deleted", timeout=60)
    machine.fail(f"test -e /var/lib/agentos/workspaces/{ws_x}")
    assert set_x in sql(f"SELECT delete_json FROM workspaces WHERE workspace_id='{ws_x}'")
    # the exported copy still restores the deleted workspace's data
    machine.succeed(f"agentos-recovery-worker import --in /media/x/x1/ws-{ws_x}.age --identity /root/x.key --staging /root/xcheck | grep -q '\"ok\":true'")

with subtest("owner transfer and disable: the old approvals wait for review; a stale memberVersion or plan is refused (I09, I12)"):
    # the machine holds at most 4 active local accounts (MAX_USERS): disable the two earlier accounts that own nothing
    # (dave from I11, carol revoked in I08) so frank and gina fit; a disabled account is not counted
    for who, tag in [(sql("SELECT user_id FROM users WHERE login_name='dave'"), "tdd"), (carol, "tdc")]:
        p = call(1, [{"methodId": "machine.users.disable", "idempotencyKey": str(uuid.uuid4()), "body": {"userId": who}}], tag + "p")[0]
        assert p["status"] == 201, p
        ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], tag + "c")[0]
        assert '"succeeded"' in json.dumps(ok), ok
    frank = make_user("frank", "frank-pw-1", "uf")
    gina = make_user("gina", "gina-pw-1", "ug")
    tty_login(6, "frank", "frank-pw-1")
    # A runs (an earlier subtest may have stopped it; the machine runs at most two workspaces)
    for w in sql(f"SELECT workspace_id FROM workspaces WHERE state IN ('starting','running') AND workspace_id != '{ws_a}'").split():
        call(1, [{"methodId": "workspaces.stop", "workspaceId": w, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "tpre")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "t0")[0]
    assert r["status"] == 200, r
    for who, tag in [(frank, "t1"), (gina, "t2")]:
        # a new member starts as viewer (machined refuses anything else), then is promoted with the current version
        r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": who, "role": "viewer"}}], tag)[0]
        assert r["status"] == 200, r
        v = int(sql(f"SELECT member_version FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{who}'"))
        r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": who, "role": "editor", "expectedMemberVersion": v}}], tag + "e")[0]
        assert r["status"] == 200, r
    # I12: an old memberVersion cannot change a member
    mv = int(sql(f"SELECT member_version FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{frank}'"))
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": frank, "role": "viewer", "expectedMemberVersion": mv - 1}}], "t3")[0]
    assert code(r) == "PLAN_STALE", r
    assert sql(f"SELECT role FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{frank}'") == "editor"
    # I12: an old plan (a transfer begun before the receiver's membership changed) cannot be confirmed
    r = call(1, [{"methodId": "members.transferOwner", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"toUserId": frank}}], "t4")[0]
    assert r["status"] == 202, r
    t_old = r["body"]["transferId"]
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": frank, "role": "viewer", "expectedMemberVersion": mv}}], "t5")[0]
    assert r["status"] == 200, r
    r = call(6, [{"methodId": "members.transferOwner", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"transferId": t_old}}], "t6")[0]
    assert code(r) == "PLAN_STALE", r
    assert sql(f"SELECT role FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{alice}'") == "owner"
    # approvals given earlier: one by the owner (alice), one by an editor (gina) — written into the Host database as
    # the approval flow leaves them (state enabled, approved_user_id), with the Host stopped
    r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "t7")[0]
    assert r["status"] == 200, r
    machine.wait_until_fails(f"pgrep -u {ua} -f packages/host/dist/main.js", timeout=60)
    login_a = sql(f"SELECT exec_login FROM workspaces WHERE workspace_id='{ws_a}'")
    hostdb = f"/var/lib/agentos/workspaces/{ws_a}/data/os.sqlite"
    def hq(q):
        return machine.succeed(f"runuser -u {login_a} -- sqlite3 {hostdb} \"{q}\"").strip()
    for pid, who in [("i09-owner", alice), ("i09-editor", gina)]:
        hq("INSERT INTO maintenance_policies (id, version, template_id, template_version, target_kind, target_id, trigger_json, condition_json, bounds_json, mode, allowed_actions, policy_hash, approved_by, approved_at, approved_hash, maintenance_epoch, expires_at, state, root_sync_state, created_at, updated_at, approved_user_id, approved_member_version) "
           f"VALUES ('{pid}', 1, 'app-optimize', 1, 'workspace', '{ws_a}', '{{}}', '{{}}', '{{}}', 'suggest', '[]', 'sha256:{pid}', 'user:{who}', '2026-01-01T00:00:00.000Z', 'sha256:{pid}', 1, '2099-01-01T00:00:00.000Z', 'enabled', 'none', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{who}', 1)")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "t8")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js", timeout=90)
    assert hq("SELECT state FROM maintenance_policies WHERE id='i09-owner'") == "enabled"
    # I09: transfer to frank (current versions, receiver confirms in his own session)
    mv = int(sql(f"SELECT member_version FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{frank}'"))
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": frank, "role": "editor", "expectedMemberVersion": mv}}], "t9")[0]
    assert r["status"] == 200, r
    r = call(1, [{"methodId": "members.transferOwner", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"toUserId": frank}}], "t10")[0]
    assert r["status"] == 202, r
    r = call(6, [{"methodId": "members.transferOwner", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"transferId": r["body"]["transferId"]}}], "t11")[0]
    assert r["status"] == 200, r
    assert sql(f"SELECT role FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{frank}'") == "owner"
    assert sql(f"SELECT role FROM workspace_members WHERE workspace_id='{ws_a}' AND user_id='{alice}'") != "owner"
    machine.wait_until_succeeds(f"runuser -u {login_a} -- sqlite3 {hostdb} \"SELECT state FROM maintenance_policies WHERE id='i09-owner'\" | grep -qx paused_needs_review", timeout=90)
    assert hq("SELECT state FROM maintenance_policies WHERE id='i09-editor'") == "enabled"
    # I09: disabling gina (owns nothing) puts her approval up for review as well
    p = call(1, [{"methodId": "machine.users.disable", "idempotencyKey": str(uuid.uuid4()), "body": {"userId": gina}}], "t12")[0]
    assert p["status"] == 201, p
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], "t13")[0]
    assert '"succeeded"' in json.dumps(ok), ok
    machine.wait_until_succeeds(f"runuser -u {login_a} -- sqlite3 {hostdb} \"SELECT state FROM maintenance_policies WHERE id='i09-editor'\" | grep -qx paused_needs_review", timeout=90)
    assert hq("SELECT COUNT(*) FROM maintenance_policies WHERE state IN ('enabled','syncing')") == "0"
