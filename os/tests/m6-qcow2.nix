# M6 qcow2 template (spec §19.1, V1-U03 in a KVM VM): the template is built by os/packages/qcow2.nix (the same
# installer and layout as an ISO install) from the release modules + the NixOS test backdoor (needed to drive the
# guest; the release output `agentos-qcow2` uses the plain release toplevel). Two clones of one template boot,
# each must replace the template disk key before machined starts, and first boot gives each its own identity.
{ pkgs, mkSystem, releaseModules, nixpkgs }:
let
  installed = mkSystem (releaseModules ++ [
    "${nixpkgs}/nixos/modules/testing/test-instrumentation.nix"
    ({ lib, ... }: { agentos.graphical = lib.mkForce false; boot.kernelParams = [ "console=ttyS0" ]; users.users.root.hashedPasswordFile = lib.mkForce null; })
  ]);
  top = installed.config.system.build.toplevel;
  installer = pkgs.callPackage ./../packages/installer.nix { system = top; };
  image = pkgs.callPackage ./../packages/qcow2.nix { system = top; inherit installer; qemu = pkgs.qemu-utils; name = "agentos-qcow2-test"; luksGiB = 10; };
in
pkgs.testers.runNixOSTest {
  name = "agentos-m6-qcow2";
  nodes = { };
  testScript = ''
    import json, os, shutil, subprocess
    IMG = "${image}/agentos.qcow2"
    TOP = "${top}"
    extra = []
    import contextlib
    @contextlib.contextmanager
    def kill_on_fail():
        # a failed check must not leave a create_machine() VM running: the driver would wait for it until the CI
        # step deadline (that, not slowness, is why earlier m6 runs only ended at the 110-minute cap)
        try:
            yield
        except BaseException:
            for x in extra:
                if x.booted:
                    x.crash()
            raise

    import time as _t
    def feed(m, text, done, timeout=900):
        # Console prompts (systemd-ask-password) end without a newline, so the driver only sees them once a later
        # line arrives (m6-install waited 8.5 min on "assphrase"). Type the answer every 15 s until `done` shows.
        end = _t.time() + timeout
        while _t.time() < end:
            m.send_console(text + "\n")
            try:
                m.wait_for_console_text(done, timeout=15)
                return
            except Exception:
                pass
        raise Exception(f"console never showed {done!r}")

    assert open("${image}/system").read().strip() == TOP

    def boot(n):
        d = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"clone{n}")
        os.makedirs(d, exist_ok=True)
        disk = os.path.join(d, "disk.qcow2")
        if not os.path.exists(disk):
            subprocess.run(["${pkgs.qemu_test}/bin/qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", IMG, disk], check=True)
        vars_ = os.path.join(d, "ovmf-vars.fd")
        if not os.path.exists(vars_):
            shutil.copy("${pkgs.OVMF.variables}", vars_)
            os.chmod(vars_, 0o644)
        start = (f"${pkgs.qemu_test}/bin/qemu-kvm -m 2048 -smp 2 "
                 f"-drive if=pflash,format=raw,unit=0,readonly=on,file=${pkgs.OVMF.firmware} "
                 f"-drive if=pflash,format=raw,unit=1,file={vars_} -drive file={disk},if=virtio,format=qcow2")
        mm = create_machine(start, name=f"clone{n}")
        extra.append(mm)
        return mm

    LUKS = "/dev/disk/by-partlabel/agentos-luks"
    def volume_key(m, keyopt):
        # hex of the LUKS2 volume key ("MK dump" of luksDump --dump-volume-key); test-only, the key never leaves the VM run
        o = m.succeed(f"cryptsetup luksDump --batch-mode --dump-volume-key {keyopt} {LUKS}")
        hexs, on = [], False
        for line in o.splitlines():
            if line.startswith("MK dump:"):
                on = True
                line = line[len("MK dump:"):]
            elif on and not line.startswith((" ", "\t")):
                break
            if on:
                hexs += [t for t in line.split() if len(t) == 2]
        assert len(hexs) >= 32, o
        return "".join(hexs)

    ids = []
    vks = []
    tvks = []
    for n in (1, 2):
        m = boot(n)
        with subtest(f"clone {n}: the template key opens the disk once and must be replaced before machined (U03)"), kill_on_fail():
            m.start()
            # the template key opens the disk without a prompt; then the rekey service asks twice (the same answer is
            # typed until it reports success); machined must not be running before that
            m.wait_for_console_text("template disk detected", timeout=900)
            # review F01: read the template's volume key while the rekey service waits for the passphrase
            tvk = volume_key(m, "--key-file=/etc/agentos/template-disk.key")
            tvks.append(tvk)
            m.succeed("printf '" + "".join("\\x" + tvk[i:i+2] for i in range(0, len(tvk), 2)) + "' > /run/template-vk.bin")
            if n == 2:
                assert tvks[0] == tvks[1], "the two clones did not start from the same template volume key"
                # power cut in the middle of the volume key re-encryption: the next boot resumes it
                m.send_console("clone-pass-2\n")
                for _ in range(40):
                    try:
                        m.wait_for_console_text("re-encrypting the disk", timeout=15)
                        break
                    except Exception:
                        m.send_console("clone-pass-2\n")
                m.crash()
                m.start()
                feed(m, "clone-pass-2", "resuming the interrupted disk re-encryption")
            feed(m, "clone-pass-" + str(n), "disk passphrase set")
            m.wait_for_unit("agentos-machine.service", timeout=600)
            # machined started only after the rekey finished
            rk = int(m.succeed("systemctl show -P ExecMainExitTimestampMonotonic agentos-disk-rekey.service").strip())
            ms = int(m.succeed("systemctl show -P ExecMainStartTimestampMonotonic agentos-machine.service").strip())
            assert 0 < rk <= ms, (rk, ms)
            # the partition keeps its GPT name after the grow, and udev shows it again under by-partlabel
            dev = m.succeed("cryptsetup status agentos-root | sed -n 's/^ *device: *//p'").strip()
            assert m.succeed(f"blkid -p -s PART_ENTRY_NAME -o value {dev}").strip() == "agentos-luks", dev
            m.wait_until_succeeds(f"test \"$(readlink -f {LUKS})\" = {dev}", timeout=30)
            m.fail(f"test -e {dev} && cryptsetup open --test-passphrase --key-file=/etc/agentos/template-disk.key {dev}")
            m.succeed(f"printf clone-pass-{n} | cryptsetup open --test-passphrase --key-file=- {dev}")
            m.succeed("cryptsetup status agentos-root | grep -q LUKS2 && findmnt -no FSTYPE / | grep -q btrfs")
            # review F01: a fresh volume key, the template volume key no longer opens the disk, no reencryption left,
            # one key slot, and the partition/filesystem grew from the 10 GiB template partition to the disk
            vk = volume_key(m, f"--key-file=<(printf clone-pass-{n})")
            assert vk != tvk, "the clone still uses the template volume key"
            vks.append(vk)
            rc, o = m.execute(f"cryptsetup open --volume-key-file=/run/template-vk.bin {LUKS} tvkcheck 2>&1")
            print("template volume key on the clone:", rc, o)
            assert rc != 0 and "not match" in o.lower(), o
            m.fail("test -e /dev/mapper/tvkcheck")
            dump = m.succeed(f"cryptsetup luksDump {LUKS}")
            assert "online-reencrypt" not in dump, dump
            assert "agentos-luks" in dump, dump
            assert sum(1 for l in dump.splitlines() if l.rstrip().endswith(": luks2") and l.startswith("  ")) == 1, dump
            assert int(m.succeed(f"blockdev --getsize64 {LUKS}").strip()) > 50 * 1024**3
            assert int(m.succeed("findmnt -bno SIZE /").strip()) > 50 * 1024**3
            m.succeed("grep -qx volume-key-regenerated-at-first-boot /var/lib/agentos-machine/disk-origin")
            m.succeed("shred -u /run/template-vk.bin")
            m.succeed("test \"$(readlink -f /run/current-system)\" = " + TOP)
            m.succeed("jq -e '.template == true' /etc/agentos/install.json || grep -q '\"template\":true' /etc/agentos/install.json")
            rc, o = m.execute("agentosctl status 2>&1")   # unregistered: no identity before first boot
            assert rc != 0 and "not installed" in o, o
            out = json.loads(m.succeed("printf 'admin-pw-1' | agentosctl firstboot --admin alice --workspace Home"))
            ids.append(out["machineInstallId"])
            m.fail("ss -ltn | grep -vE '^State' | grep -q .")
        with subtest(f"clone {n}: after a reboot the disk asks for the new passphrase; identity kept"), kill_on_fail():
            m.shutdown()
            m.start()
            feed(m, "clone-pass-" + str(n), "Password query on /dev/ttyS0 finished")
            m.wait_for_unit("agentos-machine.service", timeout=900)
            assert json.loads(m.succeed("agentosctl status"))["meta"]["machineInstallId"] == ids[-1]
            m.shutdown()
        if n == 1:
            # keep the runner's disk: clone 1's overlay grew by the re-encrypted partition
            shutil.rmtree(os.path.join(os.environ.get("TMPDIR", "/tmp"), "clone1"), ignore_errors=True)
    assert ids[0] != ids[1], ids
    assert len(vks) == 2 and vks[0] != vks[1], "two clones share a LUKS volume key (review F01)"
  '';
}
