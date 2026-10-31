# V1-O09 drill on two NixOS VMs, part "import a v0.4 backup → off-machine restore" (V1-M01/M02/M05/M07 on a real
# machine, V1-R10 with imported data). `machine` imports the fixture v0.4 cold backup through `agentosctl import-v04`
# (machined allocates the workspace, the import runs as its execution UID), serves it through the real gateway/Host,
# takes one machine set and exports it with age; `target` (its own install identity and users) clones it and serves
# the same records. Helpers from lib.py act on the global `machine`; the script rebinds it to the target half-way.
import re
SNAP = "/var/lib/agentos-snapshots"
source, dest = machine, target
APP = "9efaf674-4561-4c6b-9860-cf44e09fdd01"          # the fixture's app (3 records, revision sha256:428df8c7…)
REV = "sha256:428df8c73bfcf3a1bc07029d9b5e31286728c4026d4cfe4a203fbc87211332d5"
STORE = "1385edad-f864-464f-b9d1-d640406dfbfd"

ADMIN_PW = {"machine": "alice-pw-1", "target": "bea-pw-2"}

def admin(args, ok=True, n=1, pw=None, tag="adm"):
    """Decision 80 / RELEASE_V1.0.md: the machine administrator runs `agentosctl admin …` in their own tty login
    session (no root: root is locked, no sudo); the plan is confirmed with their password (PAM at the gateway)."""
    pw = pw if pw is not None else ADMIN_PW[machine.name]
    # one group, so tty_run's redirection catches agentosctl's output too (run 41209639290 only had "rc=1")
    o = tty_run(n, f"{{ printf '%s\\n' '{pw}' | agentosctl admin {args} --password-stdin; echo rc=$?; }}", f"/tmp/{tag}")
    rc = int(re.findall(r"^rc=(\d+)$", o, re.M)[-1])
    if ok:
        assert rc == 0, (args, o)
        v = json.loads(o[o.index("{"):o.rindex("}") + 1])
        assert v["state"] == "succeeded", v
        return v["result"]
    return rc, o

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
# the administrator brought the v0.4 backup along (copied into their home from removable media)
tty_login(1, "alice", "alice-pw-1")
machine.succeed("cp -rL /etc/agentos-test/v04-backup /home/alice/v04 && chown -R alice: /home/alice/v04 && chmod -R go-rwx /home/alice/v04")
pristine = machine.succeed("cd /home/alice/v04 && find . -type f | sort | xargs sha256sum").strip()

with subtest("administration without root: root is locked, the administrator has no sudo; a non-administrator and a wrong password are refused before anything runs (O09, decision 80)"):
    # (this test VM carries the NixOS test instrumentation, which gives root a password; the installed release's
    # locked root is checked from its own disk in m19-iso)
    print("root in the test VM:", machine.succeed("passwd -S root"))
    machine.fail("id -nG alice | grep -qw wheel")
    machine.fail("su - alice -c 'sudo -n true' 2>/dev/null")
    p = call(1, [{"methodId": "machine.users.create", "idempotencyKey": str(uuid.uuid4()), "body": {"loginName": "carl", "role": "user", "password": "carl-pw-1"}}], "uc")[0]
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], "ucc")[0]
    assert '"succeeded"' in json.dumps(ok), ok
    tty_login(2, "carl", "carl-pw-1")
    rc, o = admin("backup --name nope", ok=False, n=2, pw="carl-pw-1", tag="carl")
    assert rc != 0 and "NOT_FOUND_OR_FORBIDDEN" in o, o
    rc, o = admin("backup --name nope", ok=False, pw="wrong-pw", tag="wrongpw")
    assert rc != 0 and "authentication failed" in o, o
    machine.fail(f"test -e {SNAP}/nope")
    assert sql("SELECT COUNT(*) FROM machine_operations WHERE kind='admin.backup' AND state NOT IN ('planned','expired_no_effect','cancelled_no_effect')") == "0"

with subtest("import: a v0.4 cold backup becomes a NEW workspace on this machine; the import runs as its execution UID (M01, M02, M05)"):
    v = admin("import-v04 --backup /home/alice/v04 --owner alice --name Imported", tag="imp1")
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
    assert machine.succeed("cd /home/alice/v04 && find . -type f | sort | xargs sha256sum").strip() == pristine

with subtest("import is resumable and never makes a second writable copy of the store (M07)"):
    v2 = admin("import-v04 --backup /home/alice/v04 --owner alice --name Imported", tag="imp2")
    assert v2["workspaceId"] == ws_i and v2.get("resumed") is True, v2
    # the same store from a different backup (one byte more in the manifest): refused, nothing created
    machine.succeed("cp -a /home/alice/v04 /home/alice/v04b && sed -i 's/\"complete\": true/\"complete\":  true/' /home/alice/v04b/manifest.json")
    rc, o = admin("import-v04 --backup /home/alice/v04b --owner alice --name Again", ok=False, tag="imp3")
    assert rc != 0 and "STORE_ALREADY_REGISTERED" in o, o
    assert sql(f"SELECT COUNT(*) FROM workspaces WHERE store_uuid='{STORE}'") == "1"
    # a damaged backup is refused before anything is published (format/hash, M07)
    machine.succeed("cp -a /home/alice/v04 /home/alice/v04c && printf x >> /home/alice/v04c/os.sqlite && "
                    "python3 -c \"import json;p='/home/alice/v04c/manifest.json';m=json.load(open(p));m['storeUUID']='2385edad-f864-464f-b9d1-d640406dfbfd';json.dump(m,open(p,'w'))\"")
    rc, o = admin("import-v04 --backup /home/alice/v04c --owner alice --name Bad", ok=False, tag="imp4")
    assert rc != 0 and "IMPORT_HASH_MISMATCH" in o, o
    assert sql("SELECT COUNT(*) FROM workspaces WHERE store_uuid='2385edad-f864-464f-b9d1-d640406dfbfd'") == "0"   # nothing allocated

with subtest("the imported workspace is served by its own Host through the real gateway (M02 on a machine)"):
    r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_i, "idempotencyKey": str(uuid.uuid4()), "body": {}}], "ai")[0]
    assert r["status"] == 200, r
    machine.wait_until_succeeds(f"pgrep -u {uid_i} -f packages/host/dist/main.js", timeout=120)
    recs = records_via_gateway(1, ws_i, "ri")
    assert len(recs) == 3, recs
    src_recs = sorted(q(f"SELECT id FROM records WHERE app_id='{APP}'").split())
    assert recs == src_recs, (recs, src_recs)

with subtest("source: one machine set with the imported workspace, exported with age and read back"):
    v = admin("backup --name o1", tag="bk")
    machine.succeed(f"test -d {SNAP}/o1 && test \"$(stat -c %U {SNAP}/o1)\" = root")          # the plain set stays root-only
    tty_run(1, "age-keygen -o /home/alice/c.key 2>/home/alice/c.pub", "/tmp/keygen")             # the administrator's own key
    rec = machine.succeed("grep -o 'age1[a-z0-9]*' /home/alice/c.pub").strip()
    e = admin(f"backup export --set o1 --recipient {rec} --out /home/alice/carry", tag="exp")
    assert e["exportState"] == "verified" and e["offMachineCopy"] is True, e
    machine.succeed(f"test -e /home/alice/carry/ws-{ws_i}.age && test \"$(stat -c %U /home/alice/carry/ws-{ws_i}.age)\" = alice")
    machine.succeed("cp /home/alice/c.key /home/alice/carry/ && tar -C /home/alice -cf /root/carry.tar carry")
    machine.copy_from_vm("/root/carry.tar", "")

# ---- second machine ----
machine = dest
machine.wait_for_unit("agentos-session-gateway.service")
out = json.loads(must("printf 'bea-pw-2' | agentosctl firstboot --admin bea"))
assert out["machineInstallId"] != mid_src
machine.wait_for_unit("agentos-broker.service")
machine.copy_from_host(str(source.out_dir / "carry.tar"), "/root/carry.tar")
tty_login(1, "bea", "bea-pw-2")
machine.succeed("tar -C /home/bea -xf /root/carry.tar && chown -R bea: /home/bea/carry")       # the carried copy, in bea's home

with subtest("off-machine restore: the imported workspace comes back on another machine under its local owner with the same records (R10)"):
    admin("import-set --in /home/bea/carry --identity /home/bea/carry/c.key --name cset", tag="iset")
    v = admin("clone --set cset --owner bea", tag="cln")
    [w] = [x for x in v["workspaces"] if x["sourceWorkspaceId"] == ws_i]
    ws_n = w["workspaceId"]
    assert w["storeUUID"] == STORE, w
    uid_n = int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws_n}'"))
    bea = sql("SELECT user_id FROM users WHERE login_name='bea'")
    assert sql(f"SELECT owner_user_id FROM workspaces WHERE workspace_id='{ws_n}'") == bea
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
