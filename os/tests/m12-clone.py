# M9 clone (spec §24.2; V1-R10) on two NixOS VMs: `machine` is the source, `target` a second machine with its own
# install identity, users and passwords. Helpers from lib.py act on the global `machine`; the script rebinds it to
# the target half-way. Results are "KVM VM" evidence.
SNAP = "/var/lib/agentos-snapshots"
source, dest = machine, target

def ctl(args, ok=True):
    rc, out = machine.execute(f"agentosctl {args} 2>&1")
    if ok:
        assert rc == 0, (args, out)
        return json.loads(out[out.index("{"):])
    return rc, out

start_all()
machine.wait_for_unit("agentos-session-gateway.service")
out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws_a, mid_src = out["workspaceId"], out["machineInstallId"]
machine.wait_for_unit("agentos-broker.service")
tty_login(1, "alice", "alice-pw-1")
alice = sql("SELECT user_id FROM users WHERE login_name='alice'")
r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "a1")[0]
assert r["status"] == 200, r
uid_src = int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws_a}'"))
store = sql(f"SELECT store_uuid FROM workspaces WHERE workspace_id='{ws_a}'")
osa = f"/var/lib/agentos/workspaces/{ws_a}/data/os.sqlite"
machine.wait_until_succeeds(f"test -s /var/lib/agentos/workspaces/{ws_a}/data/agent.sqlite", timeout=120)

with subtest("source: a code app generated and running before the set is taken (M04)"):
    # the Host answers 503 STORE_UNAVAILABLE (retryable) until it has finished starting; same idempotency key each try
    for i in range(60):
        r = call(1, [fwd(ws_a, "runs.post", {"intent": "做一个看板应用", "targetAppId": None}, idem="kanban")], f"k1-{i}")[0]
        if not (r["status"] == 503 and r.get("body", {}).get("error", {}).get("retryable")):
            break
        time.sleep(2)
    assert r["status"] in (200, 202), r
    b = r.get("body") or {}
    b = b.get("data") or b
    run_k = b["runId"]
    machine.wait_until_succeeds(f"sqlite3 {osa} \"SELECT status FROM runs WHERE id='{run_k}'\" | grep -qE '^(succeeded|failed|cancelled)$'", timeout=600)
    st_k = machine.succeed(f"sqlite3 {osa} \"SELECT status FROM runs WHERE id='{run_k}'\"").strip()
    assert st_k == "succeeded", st_k
    app_k = machine.succeed(f"sqlite3 {osa} \"SELECT target_app_id FROM runs WHERE id='{run_k}'\"").strip()
    rev_k = machine.succeed(f"sqlite3 {osa} \"SELECT active_revision_id FROM apps WHERE id='{app_k}'\"").strip()
    assert rev_k, app_k

with subtest("source: history and old authority in the workspace, one machine set, age export"):
    r = call(1, [{"methodId": "workspaces.stop", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "s1")[0]
    assert r["status"] == 200, r
    machine.wait_until_fails(f"pgrep -u {uid_src} -f packages/host/dist/main.js", timeout=60)
    asu = f"setpriv --reuid {uid_src} --regid {uid_src} --clear-groups sqlite3 {osa}"
    # history (kept as evidence) and authority of the source machine (must not act on the target)
    machine.succeed(f"{asu} \"INSERT INTO events (kind, payload_json, created_at) VALUES ('test.history', '{{\\\"n\\\":42}}', '2026-10-31T00:00:00Z')\"")
    machine.succeed(f"{asu} \"INSERT INTO gc_delete_intents (id, object_kind, object_id, gc_generation, source_path, phase, created_at, updated_at) VALUES ('old-intent','staging','.staging-old',1,'.staging-old','unknown','2026-10-31T00:00:00Z','2026-10-31T00:00:00Z')\"")
    assert machine.succeed(f"{asu} \"SELECT COUNT(*) FROM membership_mirror WHERE user_id='{alice}'\"").strip() == "1"
    v = ctl(f"backup --out {SNAP}/c1")
    set_id = v["setId"]
    machine.succeed("age-keygen -o /root/c.key 2>/root/c.pub")
    rec = machine.succeed("grep -o 'age1[a-z0-9]*' /root/c.pub").strip()
    e = ctl(f"backup export --set {SNAP}/c1 --recipient {rec} --out /root/carry")
    assert e["exportState"] == "verified", e
    machine.succeed("cp /root/c.key /root/carry/ && tar -C /root -cf /root/carry.tar carry")
    machine.copy_from_vm("/root/carry.tar", "")
    # a same-machine set is restored, never cloned
    rc, o = ctl(f"clone --set {SNAP}/c1 --owner alice", ok=False)
    assert rc != 0 and "CONFLICT" in o, o

# ---- second machine ----
machine = dest
machine.wait_for_unit("agentos-session-gateway.service")
out = json.loads(must("printf 'bea-pw-2' | agentosctl firstboot --admin bea"))
mid_dst = out["machineInstallId"]
assert mid_dst != mid_src
machine.wait_for_unit("agentos-broker.service")
machine.copy_from_host(str(source.out_dir / "carry.tar"), "/root/carry.tar")
machine.succeed("tar -C /root -xf /root/carry.tar")

with subtest("target: the copy is decrypted and verified; a damaged part refuses the whole clone"):
    machine.succeed(f"agentos-recovery-worker import --in /root/carry/ws-{ws_a}.age --identity /root/carry/c.key --staging /root/cset/ws/{ws_a} | grep -q '\"ok\":true'")
    machine.succeed("age -d -i /root/carry/c.key -o /root/cset/machine-set.json /root/carry/machine-set.json.age")
    machine.succeed("cp -a /root/cset /root/cbad && f=$(ls /root/cbad/ws/*/data/os.sqlite) && printf 'x' >> $f")
    rc, o = ctl("clone --set /root/cbad --owner bea", ok=False)
    assert rc != 0 and "verification" in o, o
    assert sql("SELECT COUNT(*) FROM workspaces WHERE origin='cloned'") == "0"
    rc, o = ctl("clone --set /root/cset --owner alice", ok=False)       # alice does not exist here
    assert rc != 0, o

with subtest("clone: new workspace, new execution account under the local owner; old users, sessions and authority do not travel (R10)"):
    v = ctl("clone --set /root/cset --owner bea")
    [w] = v["workspaces"]
    ws_n = w["workspaceId"]
    assert ws_n != ws_a and w["storeUUID"] == store, w
    assert v["sourceMachineInstallId"] == mid_src and v["machineInstallId"] == mid_dst
    uid_n = int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws_n}'"))
    assert sql(f"SELECT origin || ' ' || state FROM workspaces WHERE workspace_id='{ws_n}'") in ("cloned stopped", "cloned created"), sql(f"SELECT origin, state FROM workspaces WHERE workspace_id='{ws_n}'")
    bea = sql("SELECT user_id FROM users WHERE login_name='bea'")
    assert sql(f"SELECT owner_user_id FROM workspaces WHERE workspace_id='{ws_n}'") == bea
    machine.succeed(f"test \"$(find /var/lib/agentos/workspaces/{ws_n}/data ! -uid {uid_n} | wc -l)\" = 0")
    machine.fail("id alice")                                        # source accounts and passwords do not exist here
    # repeated clone of the same set: same workspace, no second writable copy of the store
    v2 = ctl("clone --set /root/cset --owner bea")
    assert v2["workspaces"][0]["workspaceId"] == ws_n, v2
    assert sql(f"SELECT COUNT(*) FROM workspaces WHERE store_uuid='{store}'") == "1"
    tty_login(1, "bea", "bea-pw-2")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_n, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "t1")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"pgrep -u {uid_n} -f packages/host/dist/main.js", timeout=120)
    osn = f"/var/lib/agentos/workspaces/{ws_n}/data/os.sqlite"
    machine.wait_until_succeeds(f"test ! -e /var/lib/agentos/workspaces/{ws_n}/data/clone-reconcile-pending", timeout=120)
    q = lambda s: machine.succeed(f"setpriv --reuid {uid_n} --regid {uid_n} --clear-groups sqlite3 {osn} \"{s}\"").strip()
    assert q("SELECT workspace_id FROM meta") == ws_n
    assert q("SELECT COUNT(*) FROM events WHERE kind='test.history'") == "1"            # history kept as evidence
    assert q("SELECT COUNT(*) FROM events WHERE kind='workspace.cloned'") == "1"
    assert mid_src in q("SELECT payload_json FROM events WHERE kind='workspace.cloned'")
    assert q("SELECT phase FROM gc_delete_intents WHERE id='old-intent'") == "aborted"  # old intents never act
    assert q("SELECT COUNT(*) FROM provider_grant_outbox WHERE dispatch_state IN ('pending','sent')") == "0"
    assert q("SELECT COUNT(*) FROM maintenance_policies WHERE state IN ('enabled','syncing')") == "0"
    for _ in range(60):
        if q("SELECT group_concat(user_id) FROM membership_mirror") == bea:
            break
        time.sleep(1)
    assert q("SELECT group_concat(user_id) FROM membership_mirror") == bea
    assert q(f"SELECT COUNT(*) FROM membership_mirror WHERE user_id='{alice}'") == "0"
    # the clone's broker on this machine knows only this machine's registration
    machine.wait_until_succeeds(f"sqlite3 /var/lib/agentos-broker/broker.sqlite \"SELECT COUNT(*) FROM machine_hosts WHERE store_uuid='{store}'\" | grep -qx 1", timeout=60)

with subtest("containers on the new UID come from the fixed release images; the source graphroot never travels (M04)"):
    login_n = sql(f"SELECT exec_login FROM workspaces WHERE workspace_id='{ws_n}'")
    assert int(machine.succeed(f"id -u {login_n}").strip()) == uid_n
    # nothing of a Podman store came with the set: the part holds only the workspace data tree
    machine.fail("find /root/cset -path '*containers*' -o -name 'overlay*' | grep -q .")
    machine.succeed(f"test \"$(find /var/lib/agentos-runtime/{ws_n} ! -uid {uid_n} 2>/dev/null | wc -l)\" = 0")
    machine.wait_until_succeeds(f"test -S /run/user/{uid_n}/podman/podman.sock", timeout=120)
    machine.succeed("ip route del default 2>/dev/null; ip -6 route del default 2>/dev/null; true")
    rel = machine.succeed(f"systemctl --user -M {login_n}@ show -p Environment agentos-host@{ws_n}.service | grep -o 'AGENTOS_RELEASE_IMAGES=[^ ]*' | cut -d= -f2").strip()
    assert rel.startswith("/nix/store/") and "agentos-oci" in rel, rel
    env = (f"XDG_RUNTIME_DIR=/run/user/{uid_n} AGENTOS_RUNTIME=podman AGENTOS_PODMAN_SOCKET=/run/user/{uid_n}/podman/podman.sock "
           f"AGENTOS_DATA_DIR=/var/lib/agentos/workspaces/{ws_n}/data AGENTOS_RELEASE_IMAGES={rel}")
    pf = json.loads(machine.succeed(f"cd /tmp && runuser -u {login_n} -- env {env} agentos-runtime prefetch"))
    assert pf["ok"] and len(pf["locks"]) == 4, pf
    imgs = machine.succeed(f"runuser -u {login_n} -- env XDG_RUNTIME_DIR=/run/user/{uid_n} podman images --format '{{{{.Repository}}}}:{{{{.Tag}}}}'")
    assert "docker.io/library/node" not in imgs, imgs
    rc, dr = machine.execute(f"cd /tmp && runuser -u {login_n} -- env {env} agentos-runtime doctor")
    print(dr)
    lines = {l.split(":", 1)[0][6:]: l for l in dr.splitlines() if l.startswith(("ok  ", "FAIL"))}
    for n in ["probe container", "no network", "read-only rootfs"]:
        assert n in lines and lines[n].startswith("ok"), (n, lines.get(n))

with subtest("the clone's code app is rebuilt on the new UID from the fixed images and runs (M04)"):
    osn = f"/var/lib/agentos/workspaces/{ws_n}/data/os.sqlite"
    assert machine.succeed(f"sqlite3 {osn} \"SELECT active_revision_id FROM apps WHERE id='{app_k}'\"").strip() == rev_k
    ep = machine.succeed(f"sqlite3 {osn} \"SELECT epoch FROM apps WHERE id='{app_k}'\"").strip()
    # the clone moved the workspace's clientEpoch forward (old pages/tokens die): a client reads it from attach
    a = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_n, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "rt0")[0]
    assert a["status"] == 200 and int(a["body"]["clientEpoch"]) >= 2, a
    def fwdn(route, body=None, params=None, idem=None):
        x = fwd(ws_n, route, body, params=params, idem=idem)
        x["clientEpoch"] = int(a["body"]["clientEpoch"])
        return x
    # S08 (new builds stop while machined is unreachable): one connection, bound before the outage and held open in
    # alice's real tty session, asks for the start (which needs a fresh build on this UID) only after machined is
    # stopped. The write is inside the 30 s grace; the Host's build gate must not start a builder container until
    # machined answers again, and it records why.
    held = [{"methodId": "session.bind"}, {"methodId": "$wait", "path": "/tmp/b8-go"},
            fwdn("apps.runtime.start.post", {"expectedAppEpoch": int(ep)}, params={"appId": app_k}, idem="rt-start")]
    machine.succeed(f"echo {base64.b64encode(json.dumps(held, ensure_ascii=False).encode()).decode()} | base64 -d > /tmp/b8.json && chmod 0644 /tmp/b8.json && rm -f /tmp/b8.out /tmp/b8-go")
    machine.succeed(f"echo {base64.b64encode((RPC + ' @/tmp/b8.json > /tmp/b8.out 2>&1; echo done >> /tmp/b8.out' + chr(10)).encode()).decode()} | base64 -d > /tmp/b8.sh && chmod 0644 /tmp/b8.sh")
    machine.send_key("alt-f1")
    machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active")
    machine.send_chars("sh /tmp/b8.sh\n")
    machine.wait_until_succeeds("test $(grep -c '^{' /tmp/b8.out) -ge 1", timeout=120)
    builders = f"runuser -u {login_n} -- env XDG_RUNTIME_DIR=/run/user/{uid_n} podman ps -a --filter label=agentos.role=build --format '{{{{.ID}}}}' | wc -l"
    n_ev = int(machine.succeed(f"sqlite3 {osn} \"SELECT COUNT(*) FROM events WHERE kind='machine.unreachable'\"").strip())
    machine.succeed("systemctl stop agentos-machine.service")
    machine.succeed("touch /tmp/b8-go")
    machine.wait_until_succeeds("grep -q '^done$' /tmp/b8.out", timeout=120)
    r = [json.loads(l) for l in machine.succeed("cat /tmp/b8.out").splitlines() if l.startswith("{")][-1]
    print("S08 build request during the outage:", r)
    assert r["status"] in (200, 202), r
    machine.wait_until_succeeds(f"sqlite3 {osn} \"SELECT COUNT(*) FROM events WHERE kind='machine.unreachable'\" | grep -qvx {n_ev}", timeout=90)
    ev = machine.succeed(f"sqlite3 {osn} \"SELECT payload_json FROM events WHERE kind='machine.unreachable' ORDER BY rowid DESC LIMIT 1\"").strip()
    print("S08 visible reason:", ev)
    assert '"waiting":"build"' in ev.replace(" ", "") and "build" in ev, ev
    for _ in range(25):                                    # ~25 s with machined gone: no builder container ever starts
        assert machine.succeed(builders).strip() == "0", machine.succeed(builders)
        time.sleep(1)
    bj = machine.succeed(f"sqlite3 {osn} \"SELECT status FROM build_jobs ORDER BY created_at DESC LIMIT 1\"").strip()
    print("S08 build job during the outage:", bj)
    assert bj in ("queued", "building"), bj
    machine.succeed("systemctl start agentos-machine.service")
    machine.wait_for_unit("agentos-machine.service")
    machine.wait_until_succeeds(f"sqlite3 {osn} \"SELECT COUNT(*) FROM events WHERE kind='machine.reachable'\" | grep -qv '^0$'", timeout=120)
    def rt():
        v = call(1, [fwdn("apps.runtime.list", params={"appId": app_k})], "rt2")[0]
        return json.dumps(v)
    for _ in range(60):
        st = rt()
        if '"running"' in st or '"ready"' in st:
            break
        time.sleep(5)
    print(st)
    assert '"running"' in st or '"ready"' in st, st
    ps = machine.succeed(f"runuser -u {login_n} -- env XDG_RUNTIME_DIR=/run/user/{uid_n} podman ps --format '{{{{.Image}}}} {{{{.Status}}}}'")
    print(ps)
    assert "Up" in ps, ps
    imgs = machine.succeed(f"runuser -u {login_n} -- env XDG_RUNTIME_DIR=/run/user/{uid_n} podman images --format '{{{{.Repository}}}}'")
    assert "docker.io/library/node" not in imgs, imgs                     # nothing pulled: offline, fixed images only
