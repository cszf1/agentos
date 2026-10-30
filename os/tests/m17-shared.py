# V1-W09: two workspaces, one physical resource. Prepended with lib.py and members_lib.py. Every Host request goes
# through the real gateway from alice's PAM login (owner of both workspaces). "KVM VM" evidence.
UNIT = "agentos-lab.service"
FAM = "service.ensure_state.running"
FINAL = ("succeeded", "no_change", "failed_no_effect", "needs_attention", "indeterminate", "failed", "cancelled")

def data(r):
    b = r.get("body") or {}
    return b.get("data", b) if isinstance(b, dict) else b

def F(ws, route, body=None, params=None, write=False, tag="f"):
    return call(1, [fwd(ws, route, body, params=params, idem=str(uuid.uuid4()) if write else None)], tag)[0]

def unit_state():
    return machine.execute(f"systemctl is-active {UNIT}")[1].strip()

machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
machine.wait_for_unit(UNIT)
out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws_a = out["workspaceId"]
machine.wait_for_unit("agentos-broker.service")
tty_login(1, "alice", "alice-pw-1")
r = call(1, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "B"}}], "cb")[0]
assert r["status"] == 201, r
ws_b = r["body"]["workspaceId"]
for ws, tag in ((ws_a, "aa"), (ws_b, "ab")):
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": "att-" + tag, "body": {}}], tag)[0]
    assert r["status"] == 200, r
for ws in (ws_a, ws_b):
    machine.wait_until_succeeds(f"test -s /var/lib/agentos/workspaces/{ws}/data/agent.sqlite", timeout=120)
store = {ws_a: sql(f"SELECT store_uuid FROM workspaces WHERE workspace_id='{ws_a}'"), ws_b: sql(f"SELECT store_uuid FROM workspaces WHERE workspace_id='{ws_b}'")}
assert store[ws_a] and store[ws_b] and store[ws_a] != store[ws_b], store

with subtest("the administrator registers one unit for two workspaces under different keys (root policy, root-only file)"):
    pol = json.loads(machine.succeed("cat /etc/agentos/broker/policy.json"))
    def unit(st, key):
        return {"key": key, "storeUuid": st, "unit": UNIT, "displayName": f"lab ({key})", "templateHash": "sha256:" + "0" * 64,
                "safeRepeatStart": True, "autoConverge": False, "cpuQuotaPerSecUSec": {"min": 10000, "max": 1000000},
                "memoryMax": {"min": 16777216, "max": 268435456}}
    pol["units"] = [unit(store[ws_a], "lab"), unit(store[ws_b], "shared-lab")]
    pol["maintenance"] = [{"unitKey": k, "storeUuid": store[w], "actionFamilies": [FAM], "perHour": 2, "per24h": 3, "cooldownSeconds": 600}
                          for w, k in ((ws_a, "lab"), (ws_b, "shared-lab"))]
    b64 = base64.b64encode(json.dumps(pol).encode()).decode()
    machine.succeed(f"echo {b64} | base64 -d > /etc/agentos/broker/policy.json.new && chmod 0444 /etc/agentos/broker/policy.json.new && mv -f /etc/agentos/broker/policy.json.new /etc/agentos/broker/policy.json")
    machine.succeed("systemctl restart agentos-broker.service")
    machine.wait_for_unit("agentos-broker.service")
    # Each Host mirrors the broker's catalog at boot (and on its 30 s refresh once its link is back). Run 41141352527
    # never saw the new units within 3 minutes after the broker restart, so each workspace is restarted here: a
    # fresh Host handshakes with the restarted broker and syncs the catalog before admitting anything.
    for ws, tag in ((ws_a, "a"), (ws_b, "b")):
        uidw = int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws}'"))
        r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "st" + tag)[0]
        assert r["status"] == 200, r
        machine.wait_until_fails(f"pgrep -u {uidw} -f packages/host/dist/main.js", timeout=60)
        r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "re" + tag)[0]
        assert r["status"] == 200, r
        machine.wait_until_succeeds(f"pgrep -u {uidw} -f packages/host/dist/main.js", timeout=120)

rid = {}
with subtest("each workspace sees the unit as its own resource and enables keep-running maintenance (broker-confirmed)"):
    for ws, tag in ((ws_a, "a"), (ws_b, "b")):
        items = []
        for i in range(60):
            items = data(F(ws, "systemresources.list", tag=f"rl{tag}{i}")).get("items") or []
            if any(x.get("kind") == "service" and x.get("status") == "available" for x in items):
                break
            time.sleep(2)
        svc = [x for x in items if x.get("kind") == "service"]
        print(ws, "service resources", svc)
        if len(svc) != 1:
            print(machine.execute("journalctl -u agentos-broker --no-pager | tail -30; journalctl --no-pager | grep -iE 'broker|describe' | grep agentos-host | tail -20")[1])
        assert len(svc) == 1 and svc[0]["status"] == "available", items
        rid[ws] = svc[0]["resourceId"]
        r = F(ws, "maintenance.control.post", {"action": "resume"}, write=True, tag=f"mc{tag}")
        assert r["status"] in (200, 202), r
        for i in range(60):
            st = data(F(ws, "maintenance.state.list", tag=f"ms{tag}{i}"))
            if st.get("root") == "synced" and st.get("state") == "running":
                break
            time.sleep(1)
        assert st.get("root") == "synced" and st.get("state") == "running", st
        c = F(ws, "maintenance.policies.post", {"templateId": "service-ensure-running", "target": {"kind": "service", "id": rid[ws]}, "mode": "automatic", "trigger": {"kind": "manual"}}, write=True, tag=f"pp{tag}")
        assert c["status"] == 201, c
        cp = data(c)
        r = F(ws, "maintenance.policies.approve.post", {"version": cp["version"], "policyHash": cp["policyHash"]}, params={"id": cp["policyId"]}, write=True, tag=f"pa{tag}")
        assert r["status"] in (200, 202), r
        for i in range(60):
            ps = data(F(ws, "maintenance.policies.list", tag=f"pl{tag}{i}")).get("items") or []
            if any(p.get("policyId") == cp["policyId"] and p.get("state") == "enabled" for p in ps):
                break
            time.sleep(1)
        assert any(p.get("policyId") == cp["policyId"] and p.get("state") == "enabled" for p in ps), ps
        r = F(ws, "systemresources.maintenancecontrol.post", {"intent": "running"}, params={"id": rid[ws]}, write=True, tag=f"rc{tag}")
        assert r["status"] == 200, r
    assert rid[ws_a] != rid[ws_b], rid        # two workspace-scoped ids for one physical unit

def check(ws, tag):
    c = F(ws, "maintenance.checks.post", {"templateId": "service-ensure-running", "target": {"kind": "service", "id": rid[ws]}}, write=True, tag=f"ck{tag}")
    assert c["status"] == 202, c
    job = data(c)["jobId"]
    j = {}
    for i in range(120):
        j = data(F(ws, "maintenance.jobs.get", params={"id": job}, tag=f"jg{tag}{i}"))
        if j.get("state") in FINAL:
            return j
        time.sleep(2)
    raise AssertionError(("maintenance job did not finish", j))

BDB = "/var/lib/agentos-broker/broker.sqlite"
with subtest("workspace A recovers the stopped unit once: one admitted attempt on the physical unit"):
    machine.succeed(f"systemctl stop {UNIT}")
    machine.wait_until_succeeds(f"! systemctl is-active -q {UNIT}")
    j = check(ws_a, "a1")
    print("A job", json.dumps(j)[:1500])
    machine.wait_until_succeeds(f"systemctl is-active -q {UNIT}", timeout=60)
    n = machine.succeed(f"sqlite3 {BDB} \"SELECT count(*) FROM maintenance_attempts\"").strip()
    assert n == "1", n

with subtest("workspace B cannot reset the count: the same unit stopped again is refused by the shared cooldown (W09)"):
    machine.succeed(f"systemctl stop {UNIT}")
    machine.wait_until_succeeds(f"! systemctl is-active -q {UNIT}")
    j = check(ws_b, "b1")
    print("B job", json.dumps(j)[:1500])
    assert j.get("state") != "succeeded", j
    assert "CIRCUIT_OPEN" in json.dumps(j) or "cooldown" in json.dumps(j), j
    time.sleep(5)
    assert unit_state() != "active", unit_state()          # nothing started the unit for B
    n = machine.succeed(f"sqlite3 {BDB} \"SELECT count(*) FROM maintenance_attempts\"").strip()
    assert n == "1", n                                      # B's refusal took no attempt
    rows = machine.succeed(f"sqlite3 {BDB} \"SELECT store_uuid, resource_id FROM maintenance_attempts\"").strip()
    assert store[ws_a] in rows and rid[ws_a] in rows, rows   # the one attempt is A's, under A's id
    # B's broker view counts the physical unit: A's attempt shows up in B's own policy
    st = data(F(ws_b, "maintenance.state.list", tag="msb2"))
    print("B maintenance state", json.dumps(st)[:2000])
