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
