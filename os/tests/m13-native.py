# Native Shell end to end (see m13-native.nix). Results are "KVM VM" evidence; the Shell renders offscreen (no real
# display), driven through its own pages' buttons, Home intent field and app view (records form/search).
import contextlib
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
# the Host answers 503 STORE_UNAVAILABLE (retryable) until it has finished starting; same idempotency key each try
for i in range(60):
    r = call(1, [fwd(ws, "maintenance.settings.post", {"backgroundModel": True, "backgroundModelRequestsPer24h": 200, "backgroundOutputTokensPer24h": 5000000}, idem="settings")], f"set-{i}")[0]
    if not (r["status"] == 503 and r.get("body", {}).get("error", {}).get("retryable")):
        break
    time.sleep(2)
assert r["status"] == 200, r

# One failing item must not hide the evidence of the next (run 41164440050: daily failed, W05/O03/S08 never ran).
# The mainline stays hard: later items use its apps. The check still fails at the end if any item failed.
failed: list[str] = []

@contextlib.contextmanager
def item(name):
    try:
        with subtest(name):
            yield
    except Exception as e:
        failed.append(f"{name}: {e}")
        print(f"ITEM FAILED: {name}: {e}")

def hsql(q):
    return machine.succeed(f"sqlite3 {OS} \"{q}\"").strip()

def e2e(phase, timeout, extra_env=""):
    out = f"/tmp/e2e-{phase}"
    script = (f"cd /tmp && env QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software AGENTOS_E2E_PHASE={phase} QTEST_FUNCTION_TIMEOUT={timeout * 1000} {extra_env} "
              f"agentos-shell-e2e -maxwarnings 0 > {out} 2>&1; echo rc=$? >> {out}; echo done >> {out}\n")
    machine.succeed(f"echo {base64.b64encode(script.encode()).decode()} | base64 -d > {out}.sh && chmod 0644 {out}.sh && rm -f {out}")
    machine.send_key("alt-f1")
    machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active")
    machine.send_chars(f"sh {out}.sh\n")
    t0 = time.time()
    try:
        machine.wait_until_succeeds(f"grep -q '^done$' {out}", timeout=timeout)
    finally:
        text = machine.execute(f"cat {out}")[1]
        print(text[-12000:])
        print(f"e2e {phase}: {time.time() - t0:.0f} s")
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

with item("native daily actions to reconciled state: cancel, compact, proposal, maintenance pause, archive/restore (D08, M06)"):
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

with item("real session: a query in flight in A, then rapid A→B→A→B switching shows nothing of A in B; A keeps it (W05)"):
    r = call(1, [{"methodId": "workspaces.create", "idempotencyKey": str(uuid.uuid4()), "body": {"displayName": "B"}}], "cb")[0]
    assert r["status"] == 201, r
    ws_b = r["body"]["workspaceId"]
    s = e2e("switch", 600, f"AGENTOS_E2E_WS_A={ws} AGENTOS_E2E_WS_B={ws_b}")
    assert "switch" in s, s
    print("W05", s["switch"])
    marker = s["switch"]["marker"]
    OSB = f"/var/lib/agentos/workspaces/{ws_b}/data/os.sqlite"
    assert machine.succeed(f"sqlite3 {OSB} \"SELECT COUNT(*) FROM apps\"").strip() == "0"
    # ask SQLite, not cat|grep: the driver runs `set -euo pipefail`, so a missing -wal or a SIGPIPE failed the pipe
    # whatever grep found (run 41177042175), and machine.fail on the same pipe passed vacuously
    has = f"SELECT COUNT(*) FROM records WHERE instr(data_json, '{marker}') > 0"
    assert hsql(has) == "1", "the record is in A's store"
    assert machine.succeed(f"sqlite3 {OSB} \"{has}\"").strip() == "0", "and not in B's"
    rc = machine.execute(f"grep -rqaF -D skip '{marker}' /var/lib/agentos/workspaces/{ws_b}")[0]
    assert rc == 1, f"no file of B holds A's marker (grep rc={rc})"

with item("no model: generation visibly unavailable; CRUD, query, version switch and deterministic maintenance still work offline (O03)"):
    machine.succeed("echo AGENTOS_MODEL_MODE=real > /run/agentos-test/model.env")   # real mode, no provider configured
    machine.succeed("ip route del default 2>/dev/null; ip -6 route del default 2>/dev/null; true")
    machine.fail("ip route | grep -q default")
    r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "stop")[0]
    assert r["status"] == 200, r
    machine.wait_until_fails(f"pgrep -u {uid} -f packages/host/dist/main.js", timeout=60)
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "att2")[0]
    assert r["status"] == 200, r
    runs_before = hsql("SELECT COUNT(*) FROM runs")
    s = e2e("offline", 600, f"AGENTOS_E2E_WS_A={ws}")
    for k in ["generation", "crud", "version"]:
        assert k in s, (k, s)
    assert s["generation"]["modelAvailable"] is False, s
    # spec O03 also names deterministic maintenance: a model-free check (log-cleanup, usesModel false) still runs offline
    r = call(1, [fwd(ws, "maintenance.control.post", {"action": "resume"}, idem="o3-resume")], "o3r")[0]
    assert r["status"] == 200, r
    r = call(1, [fwd(ws, "maintenance.checks.post", {"templateId": "log-cleanup", "target": {"kind": "workspace", "id": "workspace"}}, idem="o3-chk")], "o3c")[0]
    assert r["status"] == 202, r
    job = r["body"]["data"]["jobId"]   # Host answers {data: ...}
    machine.wait_until_succeeds(f"sqlite3 {OS} \"SELECT state FROM maintenance_jobs WHERE id='{job}'\" | grep -Eqx 'succeeded|no_change|awaiting_approval'", timeout=120)
    print("O03 maintenance:", hsql(f"SELECT state || ' ' || COALESCE(outcome_reason,'') || ' run=' || COALESCE(run_id,'') FROM maintenance_jobs WHERE id='{job}'"))
    assert hsql("SELECT COUNT(*) FROM runs") == runs_before


with item("machined unreachable: a new build stops before any builder starts and the reason is visible; it runs once machined is back (S08 build)"):
    # Force a real rebuild: stop the code app, damage its linked artifact (the Host then rebuilds it from the fixed
    # recipe, spec §14.4), stop machined, and start the app inside the gateway's write grace. The build job must wait
    # for its machine build slot (no builder container) and the Host must record why.
    ep = int(hsql(f"SELECT epoch FROM apps WHERE id='{kanban}'"))
    r = call(1, [fwd(ws, "apps.runtime.stop.post", {"expectedAppEpoch": ep}, params={"appId": kanban}, idem="b8-stop")], "b8s")[0]
    assert r["status"] in (200, 202), r
    for _ in range(60):
        if hsql(f"SELECT COALESCE(active_instance_id,'') FROM app_runtime WHERE app_id='{kanban}'") == "":
            break
        time.sleep(2)
    assert hsql(f"SELECT COALESCE(active_instance_id,'') FROM app_runtime WHERE app_id='{kanban}'") == "", "the code app did not stop"
    ep = int(hsql(f"SELECT epoch FROM apps WHERE id='{kanban}'"))
    rel = hsql(f"SELECT a.relative_path FROM revision_artifacts ra JOIN artifacts a ON a.id = ra.artifact_id JOIN apps p ON p.id = ra.app_id AND p.active_revision_id = ra.revision_id WHERE ra.app_id='{kanban}'")
    adir = f"/var/lib/agentos/workspaces/{ws}/data/artifacts/{rel.split('/')[-1]}"
    machine.succeed(f"test -d {adir}")
    jobs0 = int(hsql(f"SELECT COUNT(*) FROM build_jobs WHERE app_id='{kanban}'"))
    unreach0 = int(hsql("SELECT COUNT(*) FROM events WHERE kind='machine.unreachable'"))
    machine.succeed(f"f=$(find {adir} -type f ! -name manifest.json | sort | head -1) && test -n \"$f\" && printf 'x' >> \"$f\"")
    machine.succeed("rm -f /tmp/b8-go")
    b8 = [fwd(ws, "apps.runtime.list", params={"appId": kanban}), {"methodId": "$wait", "path": "/tmp/b8-go"},
          fwd(ws, "apps.runtime.start.post", {"expectedAppEpoch": ep}, params={"appId": kanban}, idem="b8-start")]
    body = json.dumps([{"methodId": "session.bind"}] + b8, ensure_ascii=False)
    machine.succeed(f"echo {base64.b64encode(body.encode()).decode()} | base64 -d > /tmp/b8.json && chmod 0644 /tmp/b8.json && rm -f /tmp/b8.out")
    machine.succeed(f"echo {base64.b64encode((RPC + ' @/tmp/b8.json > /tmp/b8.out 2>&1; echo done >> /tmp/b8.out' + chr(10)).encode()).decode()} | base64 -d > /tmp/b8.sh && chmod 0644 /tmp/b8.sh")
    machine.send_key("alt-f1")
    machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active")
    machine.send_chars("sh /tmp/b8.sh\n")
    machine.wait_until_succeeds("test $(grep -c '^{' /tmp/b8.out) -ge 2", timeout=120)
    machine.succeed("systemctl stop agentos-machine.service")
    machine.succeed("touch /tmp/b8-go")
    machine.wait_until_succeeds("grep -q '^done$' /tmp/b8.out", timeout=60)
    L = [json.loads(l) for l in machine.succeed("cat /tmp/b8.out").splitlines() if l.startswith("{")]
    print("S08 build start during outage:", L[-1])
    assert L[-1]["status"] in (200, 202), L
    # the rebuild job exists and waits for its slot: queued, no builder container, and the Host says why
    machine.wait_until_succeeds(f"test $(sqlite3 {OS} \"SELECT COUNT(*) FROM build_jobs WHERE app_id='{kanban}'\") -gt {jobs0}", timeout=120)
    machine.wait_until_succeeds(f"test $(sqlite3 {OS} \"SELECT COUNT(*) FROM events WHERE kind='machine.unreachable'\") -gt {unreach0}", timeout=60)
    ev = json.loads(hsql("SELECT payload_json FROM events WHERE kind='machine.unreachable' ORDER BY rowid DESC LIMIT 1"))
    print("S08 build reason:", ev)
    assert ev["waiting"] == "build" and "build requests are paused" in ev["reason"], ev
    time.sleep(10)
    job = hsql(f"SELECT id || '|' || status || '|' || COALESCE(container_id,'') FROM build_jobs WHERE app_id='{kanban}' ORDER BY created_at DESC LIMIT 1").split("|")
    assert job[1] == "queued" and job[2] == "", job                   # nothing was built while machined was away
    names = machine.succeed(f"runuser -u {login} -- env XDG_RUNTIME_DIR=/run/user/{uid} podman ps -a --format '{{{{.Names}}}}' 2>/dev/null || true")
    assert f"agentos-b-{job[0][:12]}" not in names, names
    machine.succeed("systemctl start agentos-machine.service")
    machine.wait_for_unit("agentos-machine.service")
    # the waiting build gets its slot and leaves the queue; the Host records the recovery
    machine.wait_until_succeeds(f"sqlite3 {OS} \"SELECT status FROM build_jobs WHERE id='{job[0]}'\" | grep -qv '^queued$'", timeout=300)
    machine.wait_until_succeeds(f"sqlite3 {OS} \"SELECT COUNT(*) FROM events WHERE kind='machine.reachable'\" | grep -qv '^0$'", timeout=60)
    print("S08 build after recovery:", hsql(f"SELECT status || ' ' || COALESCE(error_json,'') FROM build_jobs WHERE id='{job[0]}'"))

assert not failed, failed
