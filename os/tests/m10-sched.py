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

with subtest("machined unreachable: gateway fails closed with a visible reason, Hosts stay, all resumes after (S08)"):
    machine.succeed(f"echo 1 > {FM}/hold")
    machine.succeed("systemctl stop agentos-machine.service")
    out = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}}]'", "/tmp/s8a")
    print(out)
    assert "STORE_UNAVAILABLE" in out or "unreachable" in out, out
    ua = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_a}/data").strip()
    ub = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_b}/data").strip()
    for u in (ua, ub):
        machine.succeed(f"pgrep -u {u} -f packages/host/dist/main.js")   # the Hosts keep their data and processes
    machine.succeed("systemctl start agentos-machine.service")
    machine.wait_for_unit("agentos-machine.service")
    r = call(1, [{"methodId": "workspaces.list"}], "s8b")[0]
    assert r["status"] == 200, r
    n0 = len([e for e in fm_log() if e["ev"] == "start"])
    rid = run(1, ws_b, "做一个天气记录应用", "s8r")
    machine.wait_until_succeeds(f"test $(grep -c '\"ev\": \"start\"' {FM}/log.jsonl) -gt {n0}", timeout=180)   # new model work flows again
