# M23 quick start (VM images): the graphical release system on its qcow2 template, as a person gets it. The only thing
# asked on first boot is one password (twice): it re-keys the disk (as m6-qcow2) and becomes the password of the
# administrator "admin" with the default workspace; then the login screen comes up. Nothing else is typed on the
# console, the handed-over password leaves no file and no log line, and the next boot asks for it once to unlock.
{ pkgs, mkSystem, releaseModules, nixpkgs }:
let
  installed = mkSystem (releaseModules ++ [
    "${nixpkgs}/nixos/modules/testing/test-instrumentation.nix"
    ({ lib, ... }: { boot.kernelParams = [ "console=ttyS0" ]; users.users.root.hashedPasswordFile = lib.mkForce null; })
  ]);
  top = installed.config.system.build.toplevel;
  installer = pkgs.callPackage ./../packages/installer.nix { system = top; };
  image = pkgs.callPackage ./../packages/qcow2.nix { system = top; inherit installer; qemu = pkgs.qemu-utils; name = "agentos-qcow2-quick"; luksGiB = 10; };
in
pkgs.testers.runNixOSTest {
  name = "agentos-m23-quickstart";
  nodes = { };
  testScript = ''
    import json, os, re, shutil, subprocess
    import time as _t
    IMG = "${image}/agentos.qcow2"
    PW = "quick-start-pw-1"
    extra = []
    import contextlib
    @contextlib.contextmanager
    def kill_on_fail():
        try:
            yield
        except BaseException:
            for x in extra:
                if x.booted:
                    x.crash()
            raise

    def wait_console(m, pattern, timeout=900):
        end = _t.monotonic() + timeout
        while _t.monotonic() < end:
            if re.search(pattern, m.get_console_log()):
                return
            if m.process is not None and m.process.poll() is not None:
                raise Exception("the VM exited while waiting for " + pattern)
            _t.sleep(0.2)
        raise Exception(f"console never showed {pattern!r}")

    def feed(m, text, done, timeout=900):
        # systemd-ask-password prompts end without a newline: type the answer every 15 s until `done` shows
        end = _t.time() + timeout
        while _t.time() < end:
            if re.search(done, m.get_console_log()):
                return
            m.send_console(text + "\n")
            try:
                wait_console(m, done, timeout=15)
                return
            except Exception:
                pass
        raise Exception(f"console never showed {done!r}")

    def unlock_existing(m, text, timeout=900):
        # as m6-qcow2: answer only a new passphrase request until the guest's test backdoor connects
        import select, socket
        marker = b"Spawning backdoor root shell..."
        end, seen = _t.monotonic() + timeout, 0
        while _t.monotonic() < end:
            if m.connected:
                return
            if select.select([m.shell], [], [], 0)[0]:
                data = m.shell.recv(65536, socket.MSG_PEEK)
                if not data:
                    raise Exception("the guest-ready channel closed before its handshake")
                pos = data.find(marker)
                if pos >= 0:
                    if pos:
                        m.shell.recv(pos, socket.MSG_WAITALL)
                    m.connect()
                    return
                discard = len(data) - len(marker) + 1
                if discard > 0:
                    m.shell.recv(discard, socket.MSG_WAITALL)
            console = m.get_console_log()
            new, seen = console[seen:], len(console)
            if re.search(r"Please enter passphrase|Starting password query on /dev/ttyS0", new):
                m.send_console(text + "\n")
            _t.sleep(0.2)
        raise Exception("the encrypted disk did not unlock and boot")

    d = os.path.join(os.environ.get("TMPDIR", "/tmp"), "quick")
    os.makedirs(d, exist_ok=True)
    disk = os.path.join(d, "disk.qcow2")
    subprocess.run(["${pkgs.qemu_test}/bin/qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", IMG, disk], check=True)
    vars_ = os.path.join(d, "ovmf-vars.fd")
    shutil.copy("${pkgs.OVMF.variables}", vars_)
    os.chmod(vars_, 0o644)
    start = (f"${pkgs.qemu_test}/bin/qemu-kvm -m 3072 -smp 2 -vga none -device virtio-gpu-pci "
             f"-drive if=pflash,format=raw,unit=0,readonly=on,file=${pkgs.OVMF.firmware} "
             f"-drive if=pflash,format=raw,unit=1,file={vars_} -drive file={disk},if=virtio,format=qcow2")
    m = create_machine(start, name="quick")
    extra.append(m)

    with subtest("first boot: one password, asked twice, is all a person types; then the login screen"), kill_on_fail():
        m.start()
        wait_console(m, "template disk detected", timeout=900)
        wait_console(m, "Choose the password for this machine", timeout=120)
        feed(m, PW, "disk passphrase set")
        m.wait_for_unit("agentos-machine.service", timeout=600)
        # first setup takes the handed-over password: nothing is typed on tty1
        m.wait_until_succeeds("test -e /var/lib/agentos-machine/first-boot-closed", timeout=300)
        m.wait_for_unit("greetd.service", timeout=300)
        j = m.succeed("journalctl -b -t agentos-first-setup -o cat --no-pager")
        print(j)
        assert "first boot completed for administrator admin (quick start)" in j, j
        assert "quick start refused" not in j, j
        m.fail("test -e /run/agentos-first-setup/password")
        m.fail(f"journalctl -b --no-pager | grep -F {PW}")
        m.fail(f"grep -rsF {PW} /var/lib/agentos-machine /var/lib/agentos-first-setup /etc /run/agentos-first-setup 2>/dev/null")
        st = json.loads(m.succeed("agentosctl status"))
        print("workspaces", st.get("workspaceList"))
        assert len(st["workspaceList"]) == 1, st["workspaceList"]
        assert st["workspaceList"][0].get("displayName") == "\u6211\u7684\u5de5\u4f5c\u533a", st["workspaceList"]
        m.succeed("getent passwd admin")
        # the account was made from the handed-over password (agentosctl firstboot read it on stdin: see
        # test_first_setup.py); the same password unlocks the disk
        m.succeed(f"printf {PW} | cryptsetup open --test-passphrase --key-file=- /dev/disk/by-partlabel/agentos-luks")
        m.fail("cryptsetup open --test-passphrase --key-file=/etc/agentos/template-disk.key /dev/disk/by-partlabel/agentos-luks")
        m.screenshot("quick-first-login")

    with subtest("next boot: the same password unlocks the disk; no setup again, straight to the login screen"), kill_on_fail():
        m.shutdown()
        m.start()
        unlock_existing(m, PW)
        m.wait_for_unit("greetd.service", timeout=600)
        assert m.succeed("systemctl show -p ActiveState --value agentos-first-setup.service").strip() == "inactive"
        m.succeed("test -e /var/lib/agentos-machine/first-boot-closed")
        m.screenshot("quick-second-boot")
        m.shutdown()
  '';
}
