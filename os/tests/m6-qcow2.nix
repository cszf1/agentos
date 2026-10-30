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
  image = pkgs.callPackage ./../packages/qcow2.nix { system = top; inherit installer; qemu = pkgs.qemu-utils; name = "agentos-qcow2-test"; };
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

    ids = []
    for n in (1, 2):
        m = boot(n)
        with subtest(f"clone {n}: the template key opens the disk once and must be replaced before machined (U03)"), kill_on_fail():
            m.start()
            # the template key opens the disk without a prompt; then the rekey service asks twice (the same answer is
            # typed until it reports success); machined must not be running before that
            m.wait_for_console_text("template disk detected", timeout=900)
            feed(m, "clone-pass-" + str(n), "disk passphrase set")
            m.wait_for_unit("agentos-machine.service", timeout=600)
            # machined started only after the rekey finished
            rk = int(m.succeed("systemctl show -P ExecMainExitTimestampMonotonic agentos-disk-rekey.service").strip())
            ms = int(m.succeed("systemctl show -P ExecMainStartTimestampMonotonic agentos-machine.service").strip())
            assert 0 < rk <= ms, (rk, ms)
            m.fail("cryptsetup open --test-passphrase --key-file=/etc/agentos/template-disk.key /dev/disk/by-partlabel/agentos-luks")
            m.succeed(f"printf clone-pass-{n} | cryptsetup open --test-passphrase --key-file=- /dev/disk/by-partlabel/agentos-luks")
            m.succeed("cryptsetup status agentos-root | grep -q LUKS2 && findmnt -no FSTYPE / | grep -q btrfs")
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
    assert ids[0] != ids[1], ids
  '';
}
