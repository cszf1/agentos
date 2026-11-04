# m22-virtio: see m22-virtio.nix. Prepended: PNGTOPNM, lib.py (answer_first_boot), pnm.py (pnm_rgb, greeter_login_button).
import os, re, subprocess, time

def seat_diag():
    print(machine.execute("loginctl seat-status seat0 --no-pager; udevadm info /dev/dri/card0; ls -la /dev/dri; "
                          "journalctl -b -o short-monotonic --no-pager -u greetd -t agentos-greeter -t agentos-greeter-fallback | tail -60")[1])

def shot(name):
    machine.screenshot(name)
    return pnm_rgb(subprocess.run([PNGTOPNM, os.path.join(machine.out_dir, name + ".png")], check=True, capture_output=True).stdout)

machine.start()

with subtest("first boot on the console of the released VM system on virtio-gpu"):
    # Not multi-user.target: agentos-first-setup (oneshot, WantedBy=multi-user.target, TimeoutStartSec=infinity) holds
    # it until first boot is answered on tty1. The prompt comes after sysinit, so both Load Kernel Modules runs are over.
    machine.wait_for_unit("systemd-modules-load.service")
    machine.wait_until_tty_matches("1", "Administrator login: ", timeout=300)
    machine.succeed("grep -qx 0x1af4 /sys/bus/pci/devices/*/vendor && test -d /sys/module/virtio_gpu")
    assert machine.succeed("systemctl show -p Result --value systemd-modules-load.service").strip() == "success"
    # the initrd's run is only in the journal: no platform driver may be force-loaded there (vm-drivers.nix)
    j = machine.succeed("journalctl -b -o cat --no-pager")
    bad = re.findall(r".*Failed to start .*Load Kernel Modules.*|.*systemd-modules-load\.service: (?:Failed|Main process exited, code=exited, status=[1-9]).*|.*Failed to insert module.*", j)
    assert not bad, bad
    answer_first_boot("alice", "alice-pw-1", "A")
    machine.wait_until_succeeds("test -s /var/lib/agentos-machine/first-boot-closed", timeout=180)
    machine.wait_for_unit("multi-user.target")          # first setup has finished, so boot completes

with subtest("card0 is a seat device of seat0, and ReGreet comes up on it"):
    try:
        machine.wait_until_succeeds("test -c /dev/dri/card0", timeout=60)
        # c4786ac: card0 had no udev database entry, so logind never assigned it
        machine.wait_until_succeeds("udevadm info -q property /dev/dri/card0 | grep -Eq '^TAGS=.*:seat:'", timeout=60)
        machine.wait_until_succeeds("loginctl seat-status seat0 --no-pager | grep -q 'drm:card0'", timeout=60)
        machine.wait_for_unit("greetd.service")
        machine.wait_until_succeeds("pgrep -u greeter -f '[r]egreet'", timeout=180)
        machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active", timeout=60)
        # a running process is not a frame on the output: wait for the rendered Login button
        end = time.time() + 120
        while True:
            try:
                greeter_login_button(shot("m22-greeter"))
                break
            except AssertionError:
                if time.time() > end:
                    raise
                time.sleep(2)
        assert machine.succeed("systemctl show -p NRestarts --value greetd.service").strip() == "0"
        # The User field: ReGreet 0.3 lists AccountsService users by RealName (username when empty), and
        # AccountsService takes RealName from the GECOS text before the first comma. It used to read
        # "agentos-user <provisioning uuid>", the bare ownership marker machined wrote as GECOS.
        UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        gecos = machine.succeed("getent passwd alice").strip().split(":")[4]
        assert re.fullmatch(r"alice,,,,agentos-user " + UUID.pattern, gecos), gecos     # name first, marker last
        path = machine.succeed("busctl call org.freedesktop.Accounts /org/freedesktop/Accounts org.freedesktop.Accounts FindUserByName s alice").split()[-1].strip('"')
        real = machine.succeed(f"busctl get-property org.freedesktop.Accounts {path} org.freedesktop.Accounts.User RealName").strip()
        assert real == 's "alice"', real
        end = time.time() + 60
        while True:
            texts = machine.get_screen_text_variants()
            seen = [t for t in texts if re.search(r"\balice\b", t)]
            leak = [t for t in texts if UUID.search(t) or "agentos-user" in t]
            if seen and not leak:
                break
            if time.time() > end:
                raise AssertionError(f"the User field does not show alice without a UUID; OCR: {texts!r}")
            time.sleep(2)
        machine.fail("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | grep -q 'login screen gave up'")
    except BaseException:
        seat_diag()
        raise
