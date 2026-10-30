import uuid
RW = "agentos-recovery-worker"

def rw(args, ok=True):
    rc, out = machine.execute(f"{RW} {args}")
    v = json.loads(out.strip().splitlines()[-1])
    assert v["ok"] == ok, (args, v)
    return v

machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws, mid = out["workspaceId"], out["machineInstallId"]
root = f"/var/lib/agentos/workspaces/{ws}"
tty_login(1, "alice", "alice-pw-1")
ua = machine.succeed(f"stat -c %u {root}/data").strip()

with subtest("the Host creates the pair, then stops; a cold checkpoint needs host.lock (R01)"):
    r = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.attach\",\"workspaceId\":\"{ws}\",\"idempotencyKey\":\"a1\",\"body\":{{}}}}]'", "/tmp/m1")
    assert '"status": 200' in r.splitlines()[-2], r
    machine.wait_until_succeeds(f"test -s {root}/data/agent.sqlite")
    machine.fail(f"{RW} checkpoint --data {root}/data --out /var/lib/agentos-snapshots/live --set-id s0 --workspace-id {ws} --barrier-id b --machine-install-id {mid}")
    r = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.stop\",\"workspaceId\":\"{ws}\",\"idempotencyKey\":\"s1\",\"body\":{{}}}}]'", "/tmp/m2")
    machine.wait_until_fails(f"pgrep -u {ua} -f packages/host/dist/main.js")
    v = rw(f"checkpoint --data {root}/data --out /var/lib/agentos-snapshots/set1 --set-id {uuid.uuid4()} --workspace-id {ws} --barrier-id b --machine-install-id {mid}")
    rw("verify --set /var/lib/agentos-snapshots/set1")
    machine.succeed("stat -c '%a %U' /var/lib/agentos-snapshots | grep -q '700 root'")
    machine.fail(f"setpriv --reuid {ua} --regid {ua} --clear-groups ls /var/lib/agentos-snapshots/set1")

with subtest("a checkpoint killed before its manifest is not recoverable (R03)"):
    machine.fail(f"AGENTOS_FAULT_POINT=ckpt.before_manifest {RW} checkpoint --data {root}/data --out /var/lib/agentos-snapshots/set2 --set-id s2 --workspace-id {ws} --barrier-id b --machine-install-id {mid}")
    machine.fail("test -e /var/lib/agentos-snapshots/set2")
    rw("verify --set /var/lib/agentos-snapshots/set2.partial", ok=False)

with subtest("restore swaps the whole tree, owned by the execution UID; newer data kept as the old candidate"):
    machine.succeed(f"setpriv --reuid {ua} --regid {ua} --clear-groups sqlite3 {root}/data/os.sqlite 'CREATE TABLE after_checkpoint (x)'")
    rid = str(uuid.uuid4())
    v = rw(f"restore --set /var/lib/agentos-snapshots/set1 --ws-root {root} --restore-id {rid} --uid {ua} --gid {ua}")
    machine.fail(f"sqlite3 {root}/data/os.sqlite '.tables' | grep -q after_checkpoint")
    machine.succeed(f"sqlite3 {v['result']['previous']}/os.sqlite '.tables' | grep -q after_checkpoint")
    machine.succeed(f"test \"$(find {root}/data ! -uid {ua} | wc -l)\" = 0")
    machine.succeed(f"stat -c %a {root}/data | grep -q 700 && stat -c %a {root}/data/os.sqlite | grep -q 600")

with subtest("encrypted export → read back → decrypt to an empty disk; wrong key / tampered refused (R04)"):
    machine.succeed("age-keygen -o /root/id.key 2>/root/id.pub; age-keygen -o /root/wrong.key 2>/dev/null")
    rec = machine.succeed("sed -n 's/^Public key: //p' /root/id.pub").strip()
    machine.succeed("mkdir -p /media/usb && chmod 700 /media/usb")
    v = rw(f"export --set /var/lib/agentos-snapshots/set1 --recipient {rec} --out /media/usb/ws.age")
    machine.succeed("cd /media/usb && test \"$(sha256sum ws.age | cut -d' ' -f1)\" = \"$(cut -d' ' -f1 ws.age.sha256)\"")
    machine.succeed("truncate -s 512M /root/disk.img && mkfs.ext4 -q /root/disk.img && mkdir -p /mnt/empty && mount -o loop /root/disk.img /mnt/empty")
    rw("import --in /media/usb/ws.age --identity /root/id.key --staging /mnt/empty/set")
    rw("verify --set /mnt/empty/set")
    rw("import --in /media/usb/ws.age --identity /root/wrong.key --staging /mnt/empty/w", ok=False)
    machine.fail("test -e /mnt/empty/w")
    machine.succeed("cp /media/usb/ws.age /root/bad.age && printf '\\x00' | dd of=/root/bad.age bs=1 seek=300 conv=notrunc")
    rw("import --in /root/bad.age --identity /root/id.key --staging /mnt/empty/b", ok=False)
    machine.fail("test -e /mnt/empty/b")
    # export to a symlink target is refused
    machine.succeed("ln -s /etc/passwd /media/usb/link.age")
    rw(f"export --set /var/lib/agentos-snapshots/set1 --recipient {rec} --out /media/usb/link.age", ok=False)

with subtest("archive escapes cannot write outside staging (R05)"):
    machine.succeed("python3 - <<'PY'\n"
        "import json,struct,hashlib\n"
        "body=b'pwned'\n"
        "h={'path':'../../etc/agentos-escape','kind':'file','size':5,'sha256':hashlib.sha256(body).hexdigest(),'exec':False}\n"
        "b=json.dumps(h,sort_keys=True,separators=(',',':')).encode()\n"
        "open('/root/evil.ar','wb').write(b'AGENTOS-AR1\\n'+struct.pack('>I',len(b))+b+body)\n"
        "PY")
    machine.succeed(f"age -r {rec} -o /root/evil.age /root/evil.ar && echo ok")
    rw("import --in /root/evil.age --identity /root/id.key --staging /mnt/empty/e", ok=False)
    machine.fail("test -e /etc/agentos-escape")

with subtest("the restored workspace starts again with its pair (Host bind succeeds)"):
    r = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.attach\",\"workspaceId\":\"{ws}\",\"idempotencyKey\":\"a2\",\"body\":{{}}}}]'", "/tmp/m3")
    assert '"status": 200' in r.splitlines()[-2], r
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js")
