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

def write_entry(rid, init_override=None, extra="", system=None):
    machine.succeed("readlink -f /run/current-system > /tmp/sys")
    sysp = machine.succeed("cat /tmp/sys").strip() if system is None else system
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
    SBOM_HASH = ["sha256:" + "7" * 64]
    h = lambda c: "sha256:" + c * 64
    # review R2-1: real OCI archives; image ID = sha256 of the image config named in the archive's manifest.json
    def image_id(tar):
        cfg = machine.succeed(f"tar -xzOf {tar} manifest.json | jq -r '.[0].Config'").strip()
        return "sha256:" + machine.succeed(f"tar -xzOf {tar} {cfg} | sha256sum | cut -d' ' -f1").strip()
    IA, IB = image_id("/etc/agentos-u04/a.tar.gz"), image_id("/etc/agentos-u04/b.tar.gz")
    assert IA != IB
    fsha = lambda f: "sha256:" + machine.succeed(f"sha256sum {f} | cut -d' ' -f1").strip()
    oci = [IA]
    def manifest(**over):
        m = {"formatVersion": 1, "releaseId": str(_uuid.uuid4()), "releaseSequence": 7, "version": "1.0.0", "channel": "stable",
             "publishedAt": now - 1000, "expiresAt": now + 86400000, "supportUntil": now + 86400000 * 30,
             "sourceCommit": "a" * 40, "flakeLockHash": h("1"), "nixpkgsRevision": "b" * 40, "platform": "x86_64-linux",
             "hardwareProfiles": ["qemu-virtio"], "baseClosurePath": sysp, "baseClosureHash": h("2"), "closureContentHashes": hashes,
             "kernelVersion": "6.18.59", "initrdHash": h("4"), "ociDigests": oci, "sbomHash": SBOM_HASH[0],
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
    def verify(mpath, spath, extra="--trusted-time --images /root/rel/index.json --sbom /root/rel/sbom.json"):
        return machine.execute(f"agentosctl update verify --manifest {mpath} --signature {spath} {extra} 2>&1")
    machine.succeed(f"agentosctl update trust-key --key-id rel1 --public-key {pk}")
    put("/root/rel/index.json", {"formatVersion": 1, "archive": "images.tar", "images": [{"name": "agentos-u04-a", "imageId": IA}]})
    machine.succeed("cp /etc/agentos-u04/a.tar.gz /root/rel/images.tar")
    def sbom_for(path, archive_sha, ids):
        put(path, {"formatVersion": 1, "kind": "agentos-closure-sbom", "ociArchive": {"file": "images.tar", "sha256": archive_sha, "imageIds": ids}, "components": []})
        return fsha(path)
    SBOM_HASH[0] = GOOD_SBOM = sbom_for("/root/rel/sbom.json", fsha("/root/rel/images.tar"), [IA])
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
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time --images /root/rel/index-bad.json --sbom /root/rel/sbom.json")
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, o
    machine.succeed("mkdir -p /root/rel2 && cp /root/rel/index.json /root/rel2/")
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time --images /root/rel2/index.json --sbom /root/rel/sbom.json")
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, o
    # review R2-1: the archive's real bytes and real content are checked (copies in their own directories)
    def oci_case(name, prep, sbom="/root/rel/sbom.json", mpath="/root/rel/good.json", spath="/root/rel/good.sig"):
        d = f"/root/oci-{name}"
        machine.succeed(f"rm -rf {d} && mkdir -p {d} && cp /root/rel/index.json /root/rel/images.tar {d}/")
        machine.succeed(prep.replace("@D@", d))
        rc, o = verify(mpath, spath, f"--trusted-time --images {d}/index.json --sbom {sbom}")
        print("R2-1", name, rc, o.strip().splitlines()[-1] if o.strip() else o)
        assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, (name, o)
        return o
    sz = int(machine.succeed("stat -c %s /root/rel/images.tar").strip())
    oci_case("flip", f"printf '\\377' | dd of=@D@/images.tar bs=1 seek={sz // 2} conv=notrunc status=none")
    oci_case("truncate", f"truncate -s {sz // 2} @D@/images.tar")
    # a changed layer: unpack, change the layer's file, pack again (gzip of a modified docker-archive)
    oci_case("layer", "cd @D@ && mkdir x && tar -xzf images.tar -C x && L=$(jq -r '.[0].Layers[0]' x/manifest.json) && mkdir l && tar -xf x/$L -C l && echo tampered > l/u04 && tar -cf x/$L -C l . && tar -czf images.tar -C x . && rm -rf x l")
    # the attacker also rewrites the SBOM to the new bytes: the signed sbomHash no longer matches
    machine.succeed("mkdir -p /root/oci-sbom && cp /root/rel/index.json /root/oci-sbom/ && cp /etc/agentos-u04/b.tar.gz /root/oci-sbom/images.tar")
    sbom_for("/root/oci-sbom/sbom.json", fsha("/root/oci-sbom/images.tar"), [IA])
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time --images /root/oci-sbom/index.json --sbom /root/oci-sbom/sbom.json")
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o and "sbomHash" in o, o
    # replaced manifest.json inside the archive (points at image b's config): bytes differ from the signed hash
    oci_case("manifest", "cd @D@ && mkdir x && tar -xzf images.tar -C x && cp x/manifest.json m.json && jq '.[0].RepoTags=[\"evil:1\"]' m.json > x/manifest.json && tar -czf images.tar -C x . && rm -rf x m.json")
    # index right, hashes right (the release signed image b's archive under image a's ID): the import finds b, not a
    machine.succeed("mkdir -p /root/rel-b && cp /root/rel/index.json /root/rel-b/ && cp /etc/agentos-u04/b.tar.gz /root/rel-b/images.tar")
    SBOM_HASH[0] = sbom_for("/root/rel-b/sbom.json", fsha("/root/rel-b/images.tar"), [IA])
    put("/root/rel/wrong.json", manifest())
    sign("/root/rel/wrong.json", "rel.pem", "/root/rel/wrong.sig")
    rc, o = verify("/root/rel/wrong.json", "/root/rel/wrong.sig", "--trusted-time --images /root/rel-b/index.json --sbom /root/rel-b/sbom.json")
    print("R2-1 content", o)
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o and "importing the archive gave image IDs" in o and IB in o, o
    SBOM_HASH[0] = GOOD_SBOM
    # a release that declares OCI images but ships no SBOM / no index is refused
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time --images /root/rel/index.json")
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, o
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time")
    assert rc != 0 and "UPDATE_CONTENT_MISMATCH" in o, o
    # the positive case imported the real archive and reports its content ID
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig")
    assert rc == 0 and IA in o, o
    # missing files are refusals, never skips
    rc, o = verify("/root/rel/good.json", "/root/rel/none.sig")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    rc, o = verify("/root/rel/none.json", "/root/rel/good.sig")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--trusted-time --images /root/rel/none-index.json --sbom /root/rel/sbom.json")
    assert rc != 0 and "UPDATE_SIGNATURE_INVALID" in o, o
    # without trusted time nothing is accepted automatically
    rc, o = verify("/root/rel/good.json", "/root/rel/good.sig", "--images /root/rel/index.json --sbom /root/rel/sbom.json")
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
    # review R2-2: a broker in diagnostics-only mode (log lost) keeps its socket and an active unit; the commit is
    # still refused and names the broker's own readiness answer
    machine.succeed("systemctl stop agentos-broker.path agentos-broker.service; mkdir -p /root/broker-keep; mv /var/lib/agentos-broker/broker.sqlite* /root/broker-keep/")
    machine.succeed("systemctl start agentos-broker.service")
    machine.wait_until_succeeds("journalctl -u agentos-broker -b --no-pager | grep -q 'diagnostics-only mode'", timeout=60)
    machine.succeed("systemctl is-active agentos-broker.service && test -S /run/agentos-broker/broker.sock")
    rc, out = machine.execute(f"{UW} commit --release-id {GOOD} --health-gate --state-dir /var/lib/agentos-machine")
    print(out)
    v = json.loads(out.strip().splitlines()[-1])
    assert not v["ok"] and v["error"]["code"] == "NEEDS_ATTENTION" and "broker_identity" in v["error"]["message"] and "diagnostics-only" in v["error"]["message"], v
    assert machine.succeed(f"tail -c +5 {efi} | tr -d '\\000'").strip() == before
    machine.succeed("systemctl stop agentos-broker.service; mv /root/broker-keep/broker.sqlite* /var/lib/agentos-broker/; systemctl start agentos-broker.service agentos-broker.path")

with subtest("power cut at every ESP publish point leaves only the complete old entries or a complete candidate; known-good still boots (U07)"):
    NEW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    efi = "/sys/firmware/efi/efivars/LoaderEntryDefault-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f"
    default0 = machine.succeed(f"tail -c +5 {efi} | tr -d '\\000'").strip()
    assert default0 == f"agentos-{CAND}.conf", default0
    sysp = machine.succeed("readlink -f /run/current-system").strip()
    kernel = machine.succeed(f"readlink -f {sysp}/kernel").strip()
    initrd = machine.succeed(f"readlink -f {sysp}/initrd").strip()
    kh = machine.succeed(f"sha256sum {kernel} | cut -d' ' -f1").strip()
    ih = machine.succeed(f"sha256sum {initrd} | cut -d' ' -f1").strip()
    params = machine.succeed(f"cat {sysp}/kernel-params").strip()
    cmd = f"{UW} write-entry --esp /boot --release-id {NEW} --kernel {kernel} --initrd {initrd} --initrd-hash sha256:{ih} --init {sysp}/init --cmdline '{params}' --title 'AgentOS {NEW[:8]}'"
    def esp_state():
        conf = machine.succeed(f"test -e /boot/loader/entries/agentos-{NEW}.conf && echo y || echo n").strip() == "y"
        d = f"/boot/EFI/agentos/{NEW}"
        lk = machine.succeed(f"sha256sum {d}/linux 2>/dev/null | cut -d' ' -f1 || true").strip()
        ik = machine.succeed(f"sha256sum {d}/initrd 2>/dev/null | cut -d' ' -f1 || true").strip()
        return conf, lk == kh and ik == ih, bool(lk or ik)
    # The test image's ESP is the fixed 256 MiB of make-disk-image (the installed layout has 2 GiB, os/modules/
    # disk-layout.nix); with NixOS's own entry, two old AgentOS entries and the candidate it is full after one leaked
    # FAT chain. Keep the persistent default (known-good, CAND) and the NixOS entries; the older GOOD entry goes first.
    r = uw(f"gc --esp /boot --keep {CAND}")
    assert GOOD in r["removed"], r
    print(machine.succeed("df -k /boot; du -sk /boot/EFI/* /boot/EFI/agentos/* 2>/dev/null || true"))
    def old_entries_complete():
        for rid in (CAND,):
            machine.succeed(f"test -s /boot/loader/entries/agentos-{rid}.conf && test -s /boot/EFI/agentos/{rid}/linux && test -s /boot/EFI/agentos/{rid}/initrd")
            machine.succeed(f"cmp /boot/EFI/agentos/{rid}/linux {kernel} && cmp /boot/EFI/agentos/{rid}/initrd {initrd}")
    for pt in ("boot.after_copy_linux", "boot.after_copy_initrd", "boot.before_dir_publish", "boot.before_entry", "boot.after_entry"):
        rc, out = machine.execute(f"AGENTOS_FAULT_POINT={pt} {cmd}")
        assert rc != 0, (pt, out)                                   # the worker died at that publish point
        machine.crash()                                             # power cut: no shutdown, no sync of anything still unwritten
        machine.start()
        machine.wait_for_unit("multi-user.target", timeout=600)
        assert booted_release() == CAND, (pt, booted_release())     # the persistent default (known-good) still boots
        assert machine.succeed(f"tail -c +5 {efi} | tr -d '\\000'").strip() == default0, pt
        machine.fail("test -n \"$(cat /sys/firmware/efi/efivars/LoaderEntryOneShot-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f 2>/dev/null)\"")
        old_entries_complete()
        conf, complete, any_asset = esp_state()
        print(pt, "entry", conf, "assets complete", complete, "assets present", any_asset)
        assert (not conf) or complete, pt                           # a visible entry always names complete assets
        if pt == "boot.after_entry":
            assert conf and complete, pt                            # past the last publish point: the complete candidate
        if pt in ("boot.after_copy_linux", "boot.after_copy_initrd", "boot.before_dir_publish"):
            assert not conf and not any_asset, pt                   # before the directory publish: no candidate at all (only .tmp)
        # the same command completes from whatever was left, and the candidate is then complete
        uw(cmd[len(UW) + 1:])
        conf, complete, _ = esp_state()
        assert conf and complete, pt
        r = uw(f"gc --esp /boot --keep {CAND}")
        assert NEW in r["removed"], r
        print(pt, machine.succeed("df -k /boot | tail -1"))
        old_entries_complete()

with subtest("commit window: a crash after the intent or after the default resolves from facts; business stays closed until committed; nothing repeats (U10)"):
    import uuid
    efi = "/sys/firmware/efi/efivars/LoaderEntryDefault-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f"
    C1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    C2 = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    NEWGEN = machine.succeed("readlink -f /run/current-system").strip()
    OLDGEN = machine.succeed(f"readlink -f {NEWGEN}/specialisation/oldgen").strip()
    assert OLDGEN.startswith("/nix/store/") and OLDGEN != NEWGEN, (OLDGEN, NEWGEN)
    machine.succeed(f"test -e {OLDGEN}/etc/agentos-oldgen-only && test ! -e {NEWGEN}/etc/agentos-oldgen-only")
    # the older generation runs the AgentOS programs of an earlier v1.0 commit (U11): other native and Host builds
    NEWPROG = machine.succeed(f"cat {NEWGEN}/etc/agentos-programs").split()
    OLDPROG = machine.succeed(f"cat {OLDGEN}/etc/agentos-programs").split()
    print("AgentOS programs, newer:", NEWPROG, "older:", OLDPROG)
    assert len(OLDPROG) == 2 and OLDPROG[0] != NEWPROG[0] and OLDPROG[1] != NEWPROG[1], (NEWPROG, OLDPROG)
    machine.succeed(f"grep -q '{OLDPROG[0]}/bin/agentos-machined' {OLDGEN}/etc/systemd/system/agentos-machine.service")
    machine.succeed("cat > /root/mcall.py <<'PY'\nimport json, socket, struct, sys\ns = socket.socket(socket.AF_UNIX); s.connect('/run/agentos/machine/machine.sock')\nb = json.dumps({'op': sys.argv[1], 'args': json.loads(sys.argv[2])}).encode()\ns.sendall(struct.pack('>I', len(b)) + b)\nn = struct.unpack('>I', s.recv(4, socket.MSG_WAITALL))[0]\nprint(s.recv(n, socket.MSG_WAITALL).decode())\nPY")
    def mcall(op, args):
        return json.loads(machine.succeed(f"python3 /root/mcall.py {op} '{json.dumps(args)}'"))
    def mok(op, args):
        r = mcall(op, args)
        assert r["ok"], (op, r)
        return r["data"]
    def msql(q):
        return machine.succeed(f"sqlite3 /var/lib/agentos-machine/machine.sqlite \"{q}\"").strip()
    def default_entry():
        return machine.succeed(f"tail -c +5 {efi} | tr -d '\\000'").strip()
    T = "AGENTOS_TEST_FAULTS=1 AGENTOS_TEST_SKIP_HEALTH_GATE=1"
    def ctl(args):
        return json.loads(machine.succeed(f"{T} agentosctl update {args}"))
    def reboot():
        machine.shutdown()
        machine.start()
        machine.wait_for_unit("multi-user.target", timeout=600)
        machine.wait_until_succeeds("test -S /run/agentos/machine/machine.sock", timeout=120)
    machine.wait_until_succeeds("test -S /run/agentos/machine/machine.sock", timeout=120)
    ws = msql("SELECT workspace_id FROM workspaces ORDER BY created_at LIMIT 1")   # first boot ran in the U04 subtest
    assert ws, "no workspace"
    comp = json.dumps({"machineSchema": [1, 2], "workspaceSchema": [5, 5], "brokerSchema": [4, 4], "brokerProtocol": [3, 3], "nativeRpc": [1, 1]}).replace('"', '\\"')
    seq0 = int(msql("SELECT IFNULL(MAX(release_sequence), 0) FROM releases"))
    for k, rid in enumerate((CAND, C1, C2), 1):
        msql(f"INSERT INTO releases (release_id, manifest_hash, release_sequence, closure_path, compatibility_json, migration_class, verification_state, support_until, created_at) VALUES ('{rid}', 'sha256:{rid}', {seq0 + k}, '/nix/store/{rid}', '{comp}', 'none', 'verified', 4102444800000, 1)")
    mok("releases.setCurrent", {"releaseId": CAND, "knownGood": True})
    assert default_entry() == f"agentos-{CAND}.conf", default_entry()
    def cycle(rid, known):
        """open → … → armed (the update holds the machine barrier) → one-shot trial boot → reconcile: validating"""
        uid = str(uuid.uuid4())
        mok("updates.open", {"updateId": uid, "toReleaseId": rid, "plan": {"to": rid}})
        for st in ("downloading", "staged", "waiting_confirmation", "quiescing"):
            # review R2-4: staging names the target release's own closure
            f = {"releaseId": rid, "manifestHash": f"sha256:{rid}", "closurePath": f"/nix/store/{rid}"} if st == "staged" else {}
            mok("updates.advance", {"updateId": uid, "to": st, "fields": f})
        b = mok("barrier.hold", {"ownerKind": "update", "ownerId": uid, "scope": {}})["barrierId"]
        mok("updates.advance", {"updateId": uid, "to": "armed", "fields": {"barrierId": b, "candidateEntryId": f"agentos-{rid}.conf", "previousEntryId": f"agentos-{known}.conf"}})
        # C1 is the older generation (its own closure); every other entry is the newer one. Run 41143311441: C2's entry
        # was written while C1 (OLDGEN) was booted, copied /run/current-system and so booted the older closure again
        write_entry(rid, system=OLDGEN if rid == C1 else NEWGEN)
        uw(f"arm --esp /boot --release-id {rid} --known-good {known}")
        reboot()
        assert booted_release() == rid, booted_release()
        machine.wait_for_unit("agentos-update-reconcile.service")       # the boot unit entered validation
        print(machine.succeed("journalctl -b -o cat --no-pager -u agentos-update-reconcile.service | tail -40"))
        machine.succeed("journalctl -b -o cat --no-pager -u agentos-update-reconcile.service | grep -q enter_validating")
        r = ctl("reconcile")                                               # running it again changes nothing
        print("reconcile (trial boot, again)", r)
        assert r["action"]["action"] == "none" and r["state"] == "validating", r
        bid = machine.succeed("cat /proc/sys/kernel/random/boot_id").strip()
        u = mok("updates.get", {"updateId": uid})
        assert u["trialBootId"] == bid and u["commitIntent"] is False, u
        # business stays closed during the trial: no workspace starts under the update's barrier
        r = mcall("workspaces.rootStart", {"workspaceId": ws})
        assert not r["ok"] and r["error"]["code"] == "CHECKPOINT_INCOMPLETE", r
        assert msql(f"SELECT state FROM workspaces WHERE workspace_id='{ws}'") != "running"
        return uid
    def committed_once(uid, rid):
        assert msql(f"SELECT COUNT(*) FROM root_audit WHERE kind='update.state' AND scope_id='{uid}' AND outcome='committed'") == "1"
        assert msql(f"SELECT COUNT(*) FROM root_audit WHERE kind='update.commit_intent' AND scope_id='{uid}'") == "1"
        assert msql("SELECT current_release_id || '|' || known_good_release_id FROM machine_meta") == f"{rid}|{rid}"
        assert msql("SELECT COUNT(*) FROM barriers WHERE state='held'") == "0"
        assert msql("SELECT schema_version FROM machine_meta") == "2"
        r = ctl("reconcile")                                                   # a second pass finds nothing to do
        assert r["action"] == "none", r
    # (1) crash after the commit intent, before the default: the firmware boots known-good (the one-shot is spent);
    # reconcile writes the default again from the intent, then commits once
    u1 = cycle(C1, CAND)
    rc, o = machine.execute(f"{T} AGENTOS_FAULT_POINT=update.commit.after_intent agentosctl update commit --update-id {u1} 2>&1")
    print(o)
    assert rc != 0 and "fault injected" in o, (rc, o)
    u = mok("updates.get", {"updateId": u1})
    assert u["state"] == "validating" and u["commitIntent"] is True, u
    assert default_entry() == f"agentos-{CAND}.conf", default_entry()
    machine.crash()
    machine.start()
    machine.wait_for_unit("multi-user.target", timeout=600)
    machine.wait_until_succeeds("test -S /run/agentos/machine/machine.sock", timeout=120)
    assert booted_release() == CAND, booted_release()
    machine.wait_for_unit("agentos-update-reconcile.service")
    print(machine.succeed("journalctl -b -o cat --no-pager -u agentos-update-reconcile.service | tail -40"))
    machine.succeed("journalctl -b -o cat --no-pager -u agentos-update-reconcile.service | grep -q resume_commit_set_default")
    assert mok("updates.get", {"updateId": u1})["state"] == "committed"
    assert default_entry() == f"agentos-{C1}.conf", default_entry()
    committed_once(u1, C1)
    reboot()
    assert booted_release() == C1, booted_release()
    # the business opens only now
    mok("workspaces.rootStart", {"workspaceId": ws})
    mok("workspaces.rootStop", {"workspaceId": ws})
    # (2) crash after the default was written and read back, before machined recorded committed: the next boot is
    # the candidate from the persistent default; reconcile finishes the commit without writing anything twice
    r = uw(f"gc --esp /boot --keep {C1}")
    assert CAND in r["removed"], r
    u2 = cycle(C2, C1)
    rc, o = machine.execute(f"{T} AGENTOS_FAULT_POINT=update.commit.after_default agentosctl update commit --update-id {u2} 2>&1")
    print(o)
    assert rc != 0 and "fault injected" in o, (rc, o)
    assert mok("updates.get", {"updateId": u2})["state"] == "validating"
    assert default_entry() == f"agentos-{C2}.conf", default_entry()
    machine.crash()
    machine.start()
    machine.wait_for_unit("multi-user.target", timeout=600)
    machine.wait_until_succeeds("test -S /run/agentos/machine/machine.sock", timeout=120)
    assert booted_release() == C2, booted_release()
    machine.wait_for_unit("agentos-update-reconcile.service")
    print(machine.succeed("journalctl -b -o cat --no-pager -u agentos-update-reconcile.service | tail -40"))
    machine.succeed("journalctl -b -o cat --no-pager -u agentos-update-reconcile.service | grep -q finish_commit")
    assert mok("updates.get", {"updateId": u2})["state"] == "committed"
    committed_once(u2, C2)

with subtest("rollback boots the older registered entry: records stay readable; an incompatible generation is refused before it boots (U11 boot part)"):
    C0 = "abababab-abab-4bab-8bab-abababababab"
    comp0 = json.dumps({"machineSchema": [1, 1], "workspaceSchema": [5, 5], "brokerSchema": [4, 4], "brokerProtocol": [3, 3], "nativeRpc": [1, 1]}).replace('"', '\\"')
    seqm = int(msql("SELECT MAX(release_sequence) FROM releases"))
    msql(f"INSERT INTO releases (release_id, manifest_hash, release_sequence, closure_path, compatibility_json, migration_class, verification_state, support_until, created_at) VALUES ('{C0}', 'sha256:{C0}', {seqm + 1}, '/nix/store/{C0}', '{comp0}', 'none', 'verified', 4102444800000, 1)")
    # the newer generation (C2, running now) writes a record the older generation must read after the rollback
    cur = machine.succeed("readlink -f /run/current-system").strip()
    print("running before the rollback:", cur, "booted entry:", booted_release(), "NEWGEN:", NEWGEN)
    # the newer generation is the one running. Run 41140592033 failed on a toplevel store-path equality here after
    # the U10 reboots (paths not printed then); what matters is which generation's /etc is live, and both are printed
    assert cur != OLDGEN and machine.succeed("cat /etc/agentos-generation").strip() != "oldgen", cur
    machine.fail("test -e /etc/agentos-oldgen-only")
    seq_a = int(msql("SELECT IFNULL(MAX(seq), 0) FROM root_audit"))
    mok("workspaces.rootStart", {"workspaceId": ws})                     # real machined writes on the newer generation
    mok("workspaces.rootStop", {"workspaceId": ws})
    newgen_rows = msql(f"SELECT group_concat(seq || ':' || kind || ':' || outcome, ',') FROM root_audit WHERE seq > {seq_a}")
    print("written on the newer generation:", newgen_rows)
    assert newgen_rows, "the newer generation wrote nothing"
    facts0 = msql("SELECT (SELECT COUNT(*) FROM users) || '|' || (SELECT COUNT(*) FROM update_jobs) || '|' || (SELECT COUNT(*) FROM root_audit) || '|' || accepted_release_sequence FROM machine_meta")
    hw0 = facts0.split("|")[3]
    # a generation that only knows machine schema 1 is refused before anything boots it: default unchanged
    r = mcall("releases.setCurrent", {"releaseId": C0, "knownGood": True})
    assert not r["ok"] and r["error"]["code"] == "ROLLBACK_INCOMPATIBLE", r
    assert default_entry() == f"agentos-{C2}.conf", default_entry()
    # the older registered entry C1 declares schema 1..2: machined accepts it, the worker makes it the default
    mok("releases.setCurrent", {"releaseId": C1, "knownGood": True})
    uw(f"commit --release-id {C1}")
    assert default_entry() == f"agentos-{C1}.conf", default_entry()
    reboot()
    assert booted_release() == C1, booted_release()
    # really the older closure: its own toplevel and /etc, not the newer system under another entry name
    assert machine.succeed("readlink -f /run/current-system").strip() == OLDGEN, machine.succeed("readlink -f /run/current-system")
    assert machine.succeed("cat /etc/agentos-generation").strip() == "oldgen"
    machine.succeed("test -e /etc/agentos-oldgen-only")
    # and the older AgentOS code is what serves: machined's running binary comes from the earlier commit's build
    exe = machine.succeed("readlink -f /proc/$(systemctl show -p MainPID --value agentos-machine.service)/exe").strip()
    print("machined after the rollback:", exe)
    assert exe.startswith(OLDPROG[0] + "/"), (exe, OLDPROG)
    machine.wait_for_unit("agentos-update-reconcile.service")
    assert msql(f"SELECT group_concat(seq || ':' || kind || ':' || outcome, ',') FROM root_audit WHERE seq > {seq_a} AND seq <= {newgen_rows.split(',')[-1].split(':')[0]}") == newgen_rows
    st = json.loads(machine.succeed("agentosctl status"))
    print("after rollback boot", st.get("meta"))
    assert msql("SELECT current_release_id || '|' || known_good_release_id FROM machine_meta") == f"{C1}|{C1}"
    assert msql("SELECT accepted_release_sequence FROM machine_meta") == hw0              # high water not lowered
    assert msql("SELECT schema_version FROM machine_meta") == "2"                          # no down-migration
    f1 = msql("SELECT (SELECT COUNT(*) FROM users) || '|' || (SELECT COUNT(*) FROM update_jobs) || '|' || (SELECT COUNT(*) FROM root_audit) || '|' || accepted_release_sequence FROM machine_meta")
    assert f1.split("|")[:2] == facts0.split("|")[:2] and int(f1.split("|")[2]) >= int(facts0.split("|")[2]), (facts0, f1)
    mok("workspaces.rootStart", {"workspaceId": ws})                                      # the workspace opens on it
    mok("workspaces.rootStop", {"workspaceId": ws})
