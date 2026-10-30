# V1-O09 drill on two NixOS VMs, part "import a v0.4 backup → off-machine restore" (V1-M01/M02/M05/M07 on a real
# machine, V1-R10 with imported data). `machine` imports the fixture v0.4 cold backup through `agentosctl import-v04`
# (machined allocates the workspace, the import runs as its execution UID), serves it through the real gateway/Host,
# takes one machine set and exports it with age; `target` (its own install identity and users) clones it and serves
# the same records. Helpers from lib.py act on the global `machine`; the script rebinds it to the target half-way.
SNAP = "/var/lib/agentos-snapshots"
source, dest = machine, target
APP = "9efaf674-4561-4c6b-9860-cf44e09fdd01"          # the fixture's app (3 records, revision sha256:428df8c7…)
REV = "sha256:428df8c73bfcf3a1bc07029d9b5e31286728c4026d4cfe4a203fbc87211332d5"
STORE = "1385edad-f864-464f-b9d1-d640406dfbfd"

def ctl(args, ok=True):
    rc, out = machine.execute(f"agentosctl {args} 2>&1")
    if ok:
        assert rc == 0, (args, out)
        return json.loads(out[out.index("{"):])
    return rc, out

def records_via_gateway(n, ws, tag):
    for i in range(60):
        r = call(n, [fwd(ws, "apps.records.list", params={"appId": APP})], f"{tag}{i}")[0]
        if not (r["status"] == 503 and (r.get("body") or {}).get("error", {}).get("retryable")):
            break
        time.sleep(2)
    assert r["status"] == 200, r
    b = r["body"].get("data", r["body"]) if isinstance(r["body"], dict) else r["body"]
    rows = b if isinstance(b, list) else (b.get("records") or b.get("items") or [])
    return sorted(x.get("id") or x.get("recordId") for x in rows)

start_all()
machine.wait_for_unit("agentos-session-gateway.service")
out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws_a, mid_src = out["workspaceId"], out["machineInstallId"]
machine.wait_for_unit("agentos-broker.service")
alice = sql("SELECT user_id FROM users WHERE login_name='alice'")
machine.succeed("cp -rL /etc/agentos-test/v04-backup /root/v04 && chmod -R go-rwx /root/v04")
pristine = machine.succeed("cd /root/v04 && find . -type f | sort | xargs sha256sum").strip()

with subtest("import: a v0.4 cold backup becomes a NEW workspace on this machine; the import runs as its execution UID (M01, M02, M05)"):
    v = ctl("import-v04 --backup /root/v04 --owner alice --name Imported")
    ws_i = v["workspaceId"]
    assert ws_i != ws_a and v["storeUUID"] == STORE and v["origin"] == "imported_v04", v
    imp = v["import"]
    assert imp["ok"] and imp["identical"] is True and imp["secrets"] == "model_unconfigured", imp
    assert imp["before"] == imp["after"], imp                                              # content facts unchanged
    uid_i = int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws_i}'"))
    assert uid_i != int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws_a}'"))
    assert sql(f"SELECT origin || ' ' || owner_user_id FROM workspaces WHERE workspace_id='{ws_i}'") == f"imported_v04 {alice}"
    d = f"/var/lib/agentos/workspaces/{ws_i}/data"
    machine.succeed(f"test \"$(find {d} ! -uid {uid_i} | wc -l)\" = 0")                      # every file the new UID's
    machine.succeed(f"test \"$(stat -c %a {d})\" = 700 && test \"$(stat -c %a {d}/os.sqlite)\" = 600")
    machine.fail(f"test -e /var/lib/agentos/workspaces/{ws_i}/import-src")                  # the private copy is gone
    q = lambda s: machine.succeed(f"setpriv --reuid {uid_i} --regid {uid_i} --clear-groups sqlite3 {d}/os.sqlite \"{s}\"").strip()
    assert q("SELECT schema_version || ' ' || store_uuid || ' ' || workspace_id FROM meta") == f"5 {STORE} {ws_i}"
    assert q(f"SELECT active_revision_id FROM apps WHERE id='{APP}'") == REV
    assert q(f"SELECT COUNT(*) FROM records WHERE app_id='{APP}'") == "3"
    assert q("SELECT owner_user_id FROM legacy_principals WHERE legacy_key='user:local'") == alice     # M03
    assert q("SELECT COUNT(*) FROM maintenance_policies WHERE state IN ('enabled','syncing','pending_approval')") == "0"
    assert q("SELECT COUNT(*) FROM service_grants WHERE revoked_at IS NULL") == "0"
    # the backup itself is untouched and still usable (M01)
    assert machine.succeed("cd /root/v04 && find . -type f | sort | xargs sha256sum").strip() == pristine

with subtest("import is resumable and never makes a second writable copy of the store (M07)"):
    v2 = ctl("import-v04 --backup /root/v04 --owner alice --name Imported")
    assert v2["workspaceId"] == ws_i and v2.get("resumed") is True, v2
    # the same store from a different backup (one byte more in the manifest): refused, nothing created
    machine.succeed("cp -a /root/v04 /root/v04b && sed -i 's/\"complete\": true/\"complete\":  true/' /root/v04b/manifest.json")
    rc, o = ctl("import-v04 --backup /root/v04b --owner alice --name Again", ok=False)
    assert rc != 0 and "STORE_ALREADY_REGISTERED" in o, o
    assert sql(f"SELECT COUNT(*) FROM workspaces WHERE store_uuid='{STORE}'") == "1"
    # a damaged backup is refused before anything is published (format/hash, M07)
    machine.succeed("cp -a /root/v04 /root/v04c && printf x >> /root/v04c/os.sqlite && "
                    "python3 -c \"import json;p='/root/v04c/manifest.json';m=json.load(open(p));m['storeUUID']='2385edad-f864-464f-b9d1-d640406dfbfd';json.dump(m,open(p,'w'))\"")
    rc, o = ctl("import-v04 --backup /root/v04c --owner alice --name Bad", ok=False)
    assert rc != 0 and "IMPORT_HASH_MISMATCH" in o, o
    assert sql("SELECT COUNT(*) FROM workspaces WHERE store_uuid='2385edad-f864-464f-b9d1-d640406dfbfd'") == "0"   # nothing allocated

with subtest("the imported workspace is served by its own Host through the real gateway (M02 on a machine)"):
    tty_login(1, "alice", "alice-pw-1")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_i, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "ai")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"pgrep -u {uid_i} -f packages/host/dist/main.js", timeout=120)
    recs = records_via_gateway(1, ws_i, "ri")
    assert len(recs) == 3, recs
    src_recs = sorted(q(f"SELECT id FROM records WHERE app_id='{APP}'").split())
    assert recs == src_recs, (recs, src_recs)

with subtest("source: one machine set with the imported workspace, exported with age and read back"):
    v = ctl(f"backup --out {SNAP}/o1")
    machine.succeed("age-keygen -o /root/c.key 2>/root/c.pub")
    rec = machine.succeed("grep -o 'age1[a-z0-9]*' /root/c.pub").strip()
    e = ctl(f"backup export --set {SNAP}/o1 --recipient {rec} --out /root/carry")
    assert e["exportState"] == "verified" and e["offMachineCopy"] is True, e
    machine.succeed(f"test -e /root/carry/ws-{ws_i}.age")
    machine.succeed("cp /root/c.key /root/carry/ && tar -C /root -cf /root/carry.tar carry")
    machine.copy_from_vm("/root/carry.tar", "")

# ---- second machine ----
machine = dest
machine.wait_for_unit("agentos-session-gateway.service")
out = json.loads(must("printf 'bea-pw-2' | agentosctl firstboot --admin bea"))
assert out["machineInstallId"] != mid_src
machine.wait_for_unit("agentos-broker.service")
machine.copy_from_host(str(source.out_dir / "carry.tar"), "/root/carry.tar")
machine.succeed("tar -C /root -xf /root/carry.tar")

with subtest("off-machine restore: the imported workspace comes back on another machine under its local owner with the same records (R10)"):
    for f in machine.succeed("ls /root/carry").split():
        if f.startswith("ws-") and f.endswith(".age"):
            w = f[3:-4]
            machine.succeed(f"agentos-recovery-worker import --in /root/carry/{f} --identity /root/carry/c.key --staging /root/cset/ws/{w} | grep -q '\"ok\":true'")
    machine.succeed("age -d -i /root/carry/c.key -o /root/cset/machine-set.json /root/carry/machine-set.json.age")
    v = ctl("clone --set /root/cset --owner bea")
    [w] = [x for x in v["workspaces"] if x["sourceWorkspaceId"] == ws_i]
    ws_n = w["workspaceId"]
    assert w["storeUUID"] == STORE, w
    uid_n = int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws_n}'"))
    bea = sql("SELECT user_id FROM users WHERE login_name='bea'")
    assert sql(f"SELECT owner_user_id FROM workspaces WHERE workspace_id='{ws_n}'") == bea
    tty_login(1, "bea", "bea-pw-2")
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_n, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "tn")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"pgrep -u {uid_n} -f packages/host/dist/main.js", timeout=120)
    machine.wait_until_succeeds(f"test ! -e /var/lib/agentos/workspaces/{ws_n}/data/clone-reconcile-pending", timeout=120)
    recs_n = records_via_gateway(1, ws_n, "rn")
    assert recs_n == recs, (recs_n, recs)
    dn = f"/var/lib/agentos/workspaces/{ws_n}/data/os.sqlite"
    qn = lambda s: machine.succeed(f"setpriv --reuid {uid_n} --regid {uid_n} --clear-groups sqlite3 {dn} \"{s}\"").strip()
    assert qn(f"SELECT active_revision_id FROM apps WHERE id='{APP}'") == REV
    assert qn("SELECT COUNT(*) FROM legacy_principals WHERE legacy_key='user:local'") == "1"     # history kept
    assert qn("SELECT COUNT(*) FROM maintenance_policies WHERE state IN ('enabled','syncing')") == "0"
    print("O09 drill (import → off-machine restore):", json.dumps({"source": mid_src, "target": out["machineInstallId"], "imported": ws_i, "restored": ws_n, "records": recs_n}))
