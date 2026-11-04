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
        machine.wait_until_succeeds("udevadm info -q property /dev/dri/card0 | tee -p /dev/null | grep -Eq '^TAGS=.*:seat:'", timeout=60)
        machine.wait_until_succeeds("loginctl seat-status seat0 --no-pager | tee -p /dev/null | grep -q 'drm:card0'", timeout=60)
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
        machine.fail("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | tee -p /dev/null | grep -q 'login screen gave up'")
    except BaseException:
        seat_diag()
        raise

def greetd_diag(where):
    print(f"--- greetd at {where} ---")
    print(machine.execute("systemctl show -p Type,Restart,NRestarts,Result,ExecMainStatus,ActiveState,SubState greetd.service; "
                          "journalctl -b -o cat --no-pager -u greetd.service | tail -80")[1])

def count(tag, text):
    return int(machine.succeed(f"journalctl -b -o cat --no-pager -t {tag} | grep -c '{text}' || true").strip() or 0)

def show(prop):
    return machine.succeed(f"systemctl show -p {prop} --value greetd.service").strip()

def watch_tty2(seconds, check):
    # poll the active VT for `seconds`: it must be tty2 every time, and `check()` must hold throughout
    end, polls = time.monotonic() + seconds, 0
    while time.monotonic() < end:
        active = machine.succeed("cat /sys/class/tty/tty0/active").strip()
        assert active == "tty2", f"the console was pulled to {active} (poll {polls})"
        check()
        polls += 1
        time.sleep(1)
    assert polls >= 1, "watched no poll"
    return polls

CRASH = "/run/systemd/system/greetd.service.d/test-crash.conf"

with subtest("a DRM card and a greeter that always crashes: bounded retries, the notice with their count, tty2 keeps the console, Enter brings ReGreet back"):
    # Test-only injection at runtime (the shipped config is unchanged): greetd's own ExecStart with a config whose
    # greeter command logs and exits 1 at once, like a Cage/ReGreet crash. Debug logging records systemd's restart
    # decisions (service_enter_dead) in greetd's journal for the diagnostics.
    machine.succeed("systemd-analyze log-level debug")
    try:
        burst = int(show("StartLimitBurst"))
        assert burst >= 2, burst
        start = machine.succeed("systemctl cat greetd.service | sed -n 's/^ExecStart=//p' | tail -1").strip()
        exe, flag, conf = start.split()
        assert flag == "--config", start
        machine.succeed(
            "printf '#!/bin/sh\\n/run/current-system/sw/bin/logger -t agentos-greeter \"test greeter crashed\"\\nexit 1\\n' > /run/agentos-crash-greeter",
            "chmod 755 /run/agentos-crash-greeter",
            f"sed 's|^command *=.*|command = \"/run/agentos-crash-greeter\"|' {conf} > /run/agentos-crash-greetd.toml",
            "grep -q '^command = \"/run/agentos-crash-greeter\"' /run/agentos-crash-greetd.toml",
            f"mkdir -p {os.path.dirname(CRASH)}",
            f"printf '[Service]\\nExecStart=\\nExecStart={exe} --config /run/agentos-crash-greetd.toml\\n' > {CRASH}",
            "systemctl daemon-reload",
        )
        # The user is on the Ctrl+Alt+F2 text login when greetd starts again (a fresh start: NRestarts 0). greetd
        # waits for VT1 (terminal.switch = false) instead of switching to it, so nothing crashes and tty2 stays.
        tty_login(2, "alice", "alice-pw-1")
        # reset-failed also clears the start limit's window, so earlier starts on this boot do not count
        machine.succeed("systemctl reset-failed greetd.service; systemctl restart greetd.service")
        def nothing_ran():
            assert count("agentos-greeter", "test greeter crashed") == 0
            assert show("NRestarts") == "0"
        polls = watch_tty2(15, nothing_ran)
        print(f"tty2 kept the console for {polls} polls while greetd waited for VT1")
        greetd_diag("waiting for VT1")
        # Back on VT1 the greeter runs and crashes each time: Restart=always retries until the start limit refuses the
        # Nth restart job (counted in NRestarts when queued, service.c service_enter_restart), then OnFailure.
        machine.succeed("chvt 1")
        machine.wait_until_succeeds("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | tee -p /dev/null | grep -q 'login screen gave up'", timeout=240)
        greetd_diag("gave up")
        assert show("NRestarts") == str(burst), show("NRestarts")
        assert show("Result") == "start-limit-hit", show("Result")
        assert count("agentos-greeter-fallback", f"result=start-limit-hit restarts={burst}$") == 1
        crashes = count("agentos-greeter", "test greeter crashed")
        assert crashes == burst, f"the greeter ran {crashes} times, StartLimitBurst={burst}"
        machine.wait_until_tty_matches("1", re.escape(f"the login screen failed to start (greetd: start-limit-hit, {burst} restarts)."), timeout=60)
        machine.wait_until_tty_matches("1", "Press Enter to start the login screen again", timeout=60)
        # the tty2 login is still there and keeps the console beside the notice
        machine.send_key("alt-f2")
        machine.wait_until_succeeds("grep -qx tty2 /sys/class/tty/tty0/active", timeout=30)
        watch_tty2(5, lambda: None)
        machine.succeed("loginctl list-sessions --no-legend | grep -w alice | tee -p /dev/null | grep -qw tty2")
        # the greeter is fixed again; Enter on the notice starts greetd, and ReGreet comes up on VT1
        machine.succeed(f"rm {CRASH}", "systemctl daemon-reload")
        machine.succeed("chvt 1")
        machine.send_key("ret")
        machine.wait_until_succeeds("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | tee -p /dev/null | grep -q 'starting the login screen again'", timeout=30)
        machine.wait_until_succeeds("loginctl seat-status seat0 --no-pager | tee -p /dev/null | grep -q 'drm:card0'", timeout=60)
        machine.wait_until_succeeds("pgrep -u greeter -f '[r]egreet'", timeout=180)
        machine.wait_until_succeeds("grep -qx tty1 /sys/class/tty/tty0/active", timeout=60)
        end = time.time() + 120
        while True:
            try:
                greeter_login_button(shot("m22-greeter-after-crashes"))
                break
            except AssertionError:
                if time.time() > end:
                    raise
                time.sleep(2)
        assert show("NRestarts") == "0", show("NRestarts")   # a new start, not a restart
        assert count("agentos-greeter", "test greeter crashed") == burst
    except BaseException:
        seat_diag()
        greetd_diag("failure")
        raise
    finally:
        machine.execute("systemd-analyze log-level info")
