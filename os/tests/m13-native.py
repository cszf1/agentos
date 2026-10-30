# Native Shell end to end (see m13-native.nix). Results are "KVM VM" evidence; the Shell renders offscreen (no real
# display), driven through its own pages' buttons, Home intent field and app view (records form/search).
machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
fb = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws = fb["workspaceId"]
machine.wait_for_unit("agentos-broker.service")
tty_login(1, "alice", "alice-pw-1")
r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "att")[0]
assert r["status"] == 200, r
login = sql(f"SELECT exec_login FROM workspaces WHERE workspace_id='{ws}'")
uid = machine.succeed(f"id -u {login}").strip()
OS = f"/var/lib/agentos/workspaces/{ws}/data/os.sqlite"
machine.wait_until_succeeds(f"test -s {OS}", timeout=120)
# background model budget for maintenance candidates (spec v0.4 §19); everything else goes through the Shell
r = call(1, [fwd(ws, "maintenance.settings.post", {"backgroundModel": True, "backgroundModelRequestsPer24h": 200, "backgroundOutputTokensPer24h": 5000000}, idem="settings")], "set")[0]
assert r["status"] == 200, r

def hsql(q):
    return machine.succeed(f"sqlite3 {OS} \"{q}\"").strip()

def e2e(phase, timeout):
    out = f"/tmp/e2e-{phase}"
    script = (f"cd /tmp && env QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software AGENTOS_E2E_PHASE={phase} "
              f"agentos-shell-e2e -maxwarnings 0 > {out} 2>&1; echo rc=$? >> {out}; echo done >> {out}\n")
    machine.succeed(f"echo {base64.b64encode(script.encode()).decode()} | base64 -d > {out}.sh && chmod 0644 {out}.sh && rm -f {out}")
    machine.send_key("alt-f1")
    machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active")
    machine.send_chars(f"sh {out}.sh\n")
    try:
        machine.wait_until_succeeds(f"grep -q '^done$' {out}", timeout=timeout)
    finally:
        text = machine.execute(f"cat {out}")[1]
        print(text[-12000:])
    if "rc=0" not in text:
        print(machine.execute(f"journalctl --no-pager -n 80 -u agentos-session-gateway; tail -60 /var/lib/agentos/workspaces/{ws}/data/logs/*.log")[1])
        raise Exception(f"agentos-shell-e2e {phase} failed")
    steps = {}
    for l in text.splitlines():
        if l.startswith("E2E "):
            k, _, v = l[4:].partition(" ")
            steps[k] = json.loads(v)
    return steps

with subtest("native mainline: declarative app, CRUD/query, modify, version switch, code app, system app (M06)"):
    s = e2e("mainline", 1500)
    for k in ["bound", "declarative", "crud", "modified", "switched", "code", "system"]:
        assert k in s, (k, s)
    todo, kanban = s["declarative"]["appId"], s["code"]["appId"]
    assert int(hsql("SELECT COUNT(*) FROM runs WHERE status='succeeded'")) >= 4
    print(machine.succeed(f"sqlite3 {OS} 'SELECT id, epoch, active_revision_id FROM apps'"))
    assert int(hsql(f"SELECT COUNT(*) FROM revisions WHERE app_id='{todo}'")) >= 2
    machine.copy_from_vm("/tmp/agentos-e2e", "")

with subtest("native daily actions to reconciled state: cancel, compact, proposal, maintenance pause, archive/restore (D08, M06)"):
    r = call(1, [fwd(ws, "maintenance.checks.post", {"templateId": "app-optimize", "target": {"kind": "app", "id": kanban}}, idem="chk")], "chk")[0]
    assert r["status"] == 202, r
    s = e2e("daily", 1500)
    for k in ["cancel", "compact", "proposal", "maintenance", "archive"]:
        assert k in s, (k, s)
    assert hsql(f"SELECT status FROM runs WHERE id='{s['cancel']['runId']}'") == "cancelled"
    print(machine.succeed(f"sqlite3 {OS} 'SELECT id, state FROM proposals'"))
    assert int(hsql("SELECT COUNT(*) FROM proposals WHERE state IN ('accepted','publishing','published')")) >= 1
    assert int(hsql("SELECT COUNT(*) FROM deployments WHERE origin='proposal_accept'")) >= 1
    print(machine.succeed(f"sqlite3 {OS} 'SELECT COUNT(*) FROM agent_compactions' 2>&1 || true"))

with subtest("no model: generation visibly unavailable; CRUD, query and version switch still work offline (O03)"):
    machine.succeed("echo AGENTOS_MODEL_MODE=real > /run/agentos-test/model.env")   # real mode, no provider configured
    machine.succeed("ip route del default 2>/dev/null; ip -6 route del default 2>/dev/null; true")
    machine.fail("ip route | grep -q default")
    r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "stop")[0]
    assert r["status"] == 200, r
    machine.wait_until_fails(f"pgrep -u {uid} -f packages/host/dist/main.js", timeout=60)
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "att2")[0]
    assert r["status"] == 200, r
    runs_before = hsql("SELECT COUNT(*) FROM runs")
    s = e2e("offline", 600)
    for k in ["generation", "crud", "version"]:
        assert k in s, (k, s)
    assert s["generation"]["modelAvailable"] is False, s
    assert hsql("SELECT COUNT(*) FROM runs") == runs_before
