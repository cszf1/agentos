import json

GOOD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
CAND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
BAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
UW = "agentos-update-worker"

def uw(args):
    out = machine.succeed(f"{UW} {args}")
    v = json.loads(out.strip().splitlines()[-1])
    assert v["ok"], v
    return v["result"]

def write_entry(rid, init_override=None, extra=""):
    machine.succeed("readlink -f /run/current-system > /tmp/sys")
    sysp = machine.succeed("cat /tmp/sys").strip()
    kernel = machine.succeed(f"readlink -f {sysp}/kernel").strip()
    initrd = machine.succeed(f"readlink -f {sysp}/initrd").strip()
    ih = "sha256:" + machine.succeed(f"sha256sum {initrd} | cut -d' ' -f1").strip()
    params = machine.succeed(f"cat {sysp}/kernel-params").strip()
    init = init_override or f"{sysp}/init"
    return uw(f"write-entry --esp /boot --release-id {rid} --kernel {kernel} --initrd {initrd} --initrd-hash {ih} --init {init} --cmdline '{params} {extra}' --title 'AgentOS {rid[:8]}'")

def booted_release():
    return machine.succeed("tr ' ' '\\n' < /proc/cmdline | sed -n 's/^agentos.release=//p'").strip()

machine.start()
machine.wait_for_unit("multi-user.target")
machine.succeed("test -d /sys/firmware/efi/efivars")

with subtest("known-good and candidate entries are complete; the default is known-good"):
    write_entry(GOOD)
    machine.succeed(f"bootctl set-default agentos-{GOOD}.conf")
    write_entry(CAND)
    machine.succeed(f"test -s /boot/loader/entries/agentos-{CAND}.conf && test -s /boot/EFI/agentos/{CAND}/linux && test -s /boot/EFI/agentos/{CAND}/initrd")
    # foreign entries (NixOS' own generations) exist and are not registered
    machine.succeed("ls /boot/loader/entries/ | grep -v '^agentos-' | grep -q .")

with subtest("first boot into known-good from the persistent default"):
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    assert booted_release() == GOOD, booted_release()

with subtest("space or power not met: nothing is armed, entries and default untouched (U06)"):
    machine.succeed("mkdir -p /tmp/pw/BAT0 && printf 'Battery\\n' > /tmp/pw/BAT0/type && printf '15\\n' > /tmp/pw/BAT0/capacity && printf 'Discharging\\n' > /tmp/pw/BAT0/status")
    before = machine.succeed("bootctl status 2>/dev/null | grep -iE 'default|oneshot' ; ls -l /boot/loader/entries/").strip()
    for extra in ("--power-dir /tmp/pw", "--need-store-bytes 999999999999999"):
        rc, out = machine.execute(f"{UW} arm --esp /boot --release-id {CAND} --known-good {GOOD} {extra}")
        print(out)
        assert rc != 0 and "UPDATE_PRECONDITION" in out, out
    machine.fail("bootctl status 2>/dev/null | grep -i 'oneshot' | grep -q agentos-")
    assert machine.succeed("bootctl status 2>/dev/null | grep -iE 'default|oneshot' ; ls -l /boot/loader/entries/").strip() == before

with subtest("one-shot trial boots the candidate exactly once; default unchanged (U08)"):
    r = uw(f"arm --esp /boot --release-id {CAND} --known-good {GOOD}")
    assert r["oneshot"] == f"agentos-{CAND}.conf", r
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    assert booted_release() == CAND, booted_release()
    facts = json.dumps({"state": "armed", "candidate": CAND, "knownGood": GOOD})
    a = uw(f"after-boot --facts '{facts}' --boot-id $(cat /proc/sys/kernel/random/boot_id)")
    assert a["action"] == "enter_validating", a
    # without commit the next boot returns to known-good
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    assert booted_release() == GOOD, booted_release()

with subtest("commit sets and reads back the default (U10)"):
    r = uw(f"commit --release-id {CAND}")
    assert r["default"] == f"agentos-{CAND}.conf", r
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    assert booted_release() == CAND, booted_release()
    facts = json.dumps({"state": "validating", "candidate": CAND, "knownGood": GOOD, "commitIntent": True, "trialBootId": "x"})
    a = uw(f"after-boot --facts '{facts}' --boot-id $(cat /proc/sys/kernel/random/boot_id)")
    assert a["action"] == "finish_commit", a

with subtest("a bad candidate (no init) falls back to the default, no endless retry (U08)"):
    write_entry(BAD, init_override="/nix/store/00000000000000000000000000000000-missing/init", extra="boot.panic_on_fail panic=1")
    uw(f"arm --esp /boot --release-id {BAD} --known-good {CAND}")
    machine.succeed("sync")
    machine.shutdown()
    # stage 1 fails, the kernel panics and resets (panic=1). The test QEMU runs with -no-reboot, so the reset ends the
    # QEMU process; starting it again with the same disk and EFI variables is the hardware reset. The firmware then
    # boots the persistent default: the one-shot was consumed by the failed attempt.
    machine.start()
    machine.wait_for_shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target", timeout=900)
    assert booted_release() == CAND, booted_release()
    facts = json.dumps({"state": "armed", "candidate": BAD, "knownGood": CAND})
    a = uw(f"after-boot --facts '{facts}' --boot-id $(cat /proc/sys/kernel/random/boot_id)")
    assert a["action"] == "rolled_back", a
    machine.fail("test -n \"$(cat /sys/firmware/efi/efivars/LoaderEntryOneShot-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f 2>/dev/null)\"")

with subtest("GC removes only unpinned registered entries; NixOS entries stay (U12)"):
    before = machine.succeed("ls /boot/loader/entries | grep -v '^agentos-' | sort")
    r = uw(f"gc --esp /boot --keep {CAND},{GOOD}")
    assert r["removed"] == [BAD], r
    after = machine.succeed("ls /boot/loader/entries | grep -v '^agentos-' | sort")
    assert before == after, (before, after)
    machine.succeed(f"test -e /boot/loader/entries/agentos-{GOOD}.conf && test -e /boot/loader/entries/agentos-{CAND}.conf")

with subtest("release verification: tampered manifest/closure/OCI/signature, unknown key, missing file all refused (U04)"):
    import base64, uuid as _uuid
    machine.wait_for_unit("agentos-machine.service")
    # the release high-water mark lives in the machine identity: first boot creates it
    machine.succeed("printf 'alice-pw-1' | agentosctl firstboot --admin alice")
    machine.succeed("mkdir -p /root/rel && cd /root/rel && openssl genpkey -algorithm ed25519 -out rel.pem && openssl genpkey -algorithm ed25519 -out other.pem")
    pk = machine.succeed("openssl pkey -in /root/rel/rel.pem -pubout -outform DER | tail -c 32 | od -An -tx1 | tr -d ' \\n'").strip()
    assert len(pk) == 64, pk
    sysp = machine.succeed("readlink -f /run/current-system").strip()
    pi = json.loads(machine.succeed(f"nix --extra-experimental-features nix-command path-info --json --recursive {sysp}"))
    items = pi.values() if isinstance(pi, dict) else pi
    def nar(h):
        if h.startswith("sha256-"):
            return "sha256:" + base64.b64decode(h[7:]).hex()
        assert h.startswith("sha256:") and len(h) == 71, h
        return h
    hashes = sorted({nar(v["narHash"]) for v in items})
    now = int(machine.succeed("date +%s%3N").strip())
    h = lambda c: "sha256:" + c * 64
    oci = sorted([h("5"), h("6")])
    def manifest(**over):
        m = {"formatVersion": 1, "releaseId": str(_uuid.uuid4()), "releaseSequence": 7, "version": "1.0.0", "channel": "stable",
             "publishedAt": now - 1000, "expiresAt": now + 86400000, "supportUntil": now + 86400000 * 30,
             "sourceCommit": "a" * 40, "flakeLockHash": h("1"), "nixpkgsRevision": "b" * 40, "platform": "x86_64-linux",
             "hardwareProfiles": ["qemu-virtio"], "baseClosurePath": sysp, "baseClosureHash": h("2"), "closureContentHashes": hashes,
             "kernelVersion": "6.18.59", "initrdHash": h("4"), "ociDigests": oci, "sbomHash": h("7"),
             "compatibility": {"workspaceSchema": [5, 5], "machineSchema": [1, 2], "brokerSchema": [4, 4], "brokerProtocol": [3, 3], "nativeRpc": [1, 1]},
             "migrationClass": "none", "healthProfile": "default", "minRecoveryVersion": "1.0.0", "keyId": "rel1"}
        m.update(over)
        return m
    def put(path, obj):
        machine.succeed(f"echo {base64.b64encode(json.dumps(obj).encode()).decode()} | base64 -d > {path}")
    def sign(mpath, key, spath):
        d = json.loads(machine.succeed(f"agentosctl update digest --manifest {mpath}"))["manifestHash"]
        esc = "".join("\\x" + d[7 + i:9 + i] for i in range(0, 64, 2))
        machine.succeed(f"printf '{esc}' > /root/rel/d.bin && test $(stat -c %s /root/rel/d.bin) = 32")
        machine.succeed(f"openssl pkeyutl -sign -inkey /root/rel/{key} -rawin -in /root/rel/d.bin -out /root/rel/s.bin && od -An -tx1 /root/rel/s.bin | tr -d ' \\n' > {spath}")
    def verify(mpath, spath, extra="--trusted-time --images /root/rel/index.json"):
        return machine.execute(f"agentosctl update verify --manifest {mpath} --signature {spath} {extra} 2>&1")
    machine.succeed(f"agentosctl update trust-key --key-id rel1 --public-key {pk}")
    put("/root/rel/index.json", {"formatVersion": 1, "archive": "images.tar", "images": [{"name": f"i{n}", "imageId": d} for n, d in enumerate(oci)]})
    machine.succeed("echo archive > /root/rel/images.tar")
    good = manifest()
    put("/root/rel/good.json", good)
    sign("/root/rel/good.json", "rel.pem", "/root/rel/good.sig")
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig")
    assert rc == 0 and '"ok": true' in o, o
    # tampered manifest after signing
    put("/root/rel/t1.json", dict(good, baseClosureHash=h("9")))
    rc, o = verify("/root/rel/t1.json", "/root/rel/good.sig")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    # tampered signature
    sig = machine.succeed("cat /root/rel/good.sig").strip()
    machine.succeed(f"printf %s {('0' if sig[0] != '0' else '1') + sig[1:]} > /root/rel/bad.sig")
    rc, o = verify("/root/rel/good.json", "/root/rel/bad.sig")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    # signed by an untrusted key under a trusted key id, and an unknown key id
    sign("/root/rel/good.json", "other.pem", "/root/rel/other.sig")
    rc, o = verify("/root/rel/good.json", "/root/rel/other.sig")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    put("/root/rel/unk.json", manifest(keyId="nobody"))
    sign("/root/rel/unk.json", "other.pem", "/root/rel/unk.sig")
    rc, o = verify("/root/rel/unk.json", "/root/rel/unk.sig")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    # correctly signed, but the store holds a closure the manifest does not list exactly (changed / missing path)
    changed = sorted(hashes[1:] + [h("8")])
    for n, cl in enumerate([changed, hashes[1:]]):
        put(f"/root/rel/c{n}.json", manifest(closureContentHashes=cl))
        sign(f"/root/rel/c{n}.json", "rel.pem", f"/root/rel/c{n}.sig")
        rc, o = verify(f"/root/rel/c{n}.json", f"/root/rel/c{n}.sig")
        assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, o
    # a closure path that is not in the store at all
    put("/root/rel/c2.json", manifest(baseClosurePath="/nix/store/00000000000000000000000000000000-agentos-system"))
    sign("/root/rel/c2.json", "rel.pem", "/root/rel/c2.sig")
    rc, o = verify("/root/rel/c2.json", "/root/rel/c2.sig")
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, o
    # shipped OCI images differ from the signed ociDigests; OCI archive missing
    put("/root/rel/index-bad.json", {"formatVersion": 1, "archive": "images.tar", "images": [{"name": "i0", "imageId": oci[0]}, {"name": "i1", "imageId": h("e")}]})
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time --images /root/rel/index-bad.json")
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, o
    machine.succeed("mkdir -p /root/rel2 && cp /root/rel/index.json /root/rel2/")
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time --images /root/rel2/index.json")
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, o
    # missing files are refusals, never skips
    rc, o = verify("/root/rel/good.json", "/root/rel/none.sig")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    rc, o = verify("/root/rel/none.json", "/root/rel/good.sig")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time --images /root/rel/none-index.json")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    # without trusted time nothing is accepted automatically
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--images /root/rel/index.json")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    # nothing above registered a release, and the store keeps require-sigs
    assert machine.succeed("sqlite3 /var/lib/agentos-machine/machine.sqlite 'SELECT COUNT(*) FROM releases' 2>/dev/null || echo 0").strip() == "0"
    machine.succeed("nix --extra-experimental-features nix-command config show require-sigs 2>/dev/null | grep -qx true || nix show-config 2>/dev/null | grep -q '^require-sigs = true'")

with subtest("a commit behind a failing health gate leaves the persistent default on known-good (U09)"):
    efi = "/sys/firmware/efi/efivars/LoaderEntryDefault-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f"
    before = machine.succeed(f"tail -c +5 {efi} | tr -d '\\000'").strip()
    assert before == f"agentos-{CAND}.conf", before
    # headless node: no greeter, no Shell frame -> the gate cannot pass
    rc, out = machine.execute(f"{UW} commit --release-id {GOOD} --health-gate --state-dir /var/lib/agentos-machine")
    print(out)
    v = json.loads(out.strip().splitlines()[-1])
    assert not v["ok"] and v["error"]["code"] == "NEEDS_ATTENTION" and "greeter_frame" in v["error"]["message"], v
    assert machine.succeed(f"tail -c +5 {efi} | tr -d '\\000'").strip() == before
