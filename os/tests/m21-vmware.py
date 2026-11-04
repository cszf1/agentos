# m21-vmware: see m21-vmware.nix. Prepended: lib.py (tty_login, answer_first_boot).
import re
import time

MD = "/var/lib/agentos-machine"
MARKER = f"{MD}/first-boot-closed"

def sql(q):
    return machine.succeed(f"sqlite3 {MD}/machine.sqlite \"{q}\"").strip()

def skips():
    # greetd runs agentos-greeter-kms as its ExecCondition; each run that finds no DRM card logs this once and starts
    # the notice (a skipped condition: no "Starting", no retry, NRestarts stays 0)
    return int(machine.succeed("journalctl -b -o cat --no-pager -t agentos-greeter | grep -c '^no display device (/dev/dri/card\\*)' || true").strip() or 0)

def not_started():
    return int(machine.succeed("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | grep -c 'login screen not started: no display device' || true").strip() or 0)

def greetd_diag(where):
    # durable diagnostics: what systemd decided for greetd, and its own journal lines, at the key points
    print(f"--- greetd at {where} ---")
    print(machine.succeed("systemctl show -p Type,Restart,NRestarts,Result,ExecMainStatus,ActiveState,SubState greetd.service"))
    print(machine.succeed("journalctl -b -o cat --no-pager -u greetd.service"))

def gave_up():
    return machine.succeed("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | grep -c 'login screen gave up' || true").strip()

def vt_stays(n, until, timeout):
    # The text login must keep the console: poll the active VT until `until()` holds, it must be tty<n> every time.
    deadline = time.monotonic() + timeout
    polls = 0
    while not until():
        active = machine.succeed("cat /sys/class/tty/tty0/active").strip()
        assert active == f"tty{n}", f"the console was pulled to {active} (poll {polls})"
        polls += 1
        assert time.monotonic() < deadline, "timed out watching the console"
        time.sleep(1)
    return polls

machine.start()

with subtest("VMware SVGA II: vmwgfx comes from udev, and no Load Kernel Modules unit fails (initrd or system)"):
    # Not multi-user.target: agentos-first-setup (oneshot, WantedBy=multi-user.target, TimeoutStartSec=infinity) holds
    # it until first boot is answered on tty1. The prompt comes after sysinit, so both Load Kernel Modules runs are over.
    machine.wait_for_unit("systemd-modules-load.service")
    machine.wait_until_tty_matches("1", "Administrator login: ", timeout=300)
    machine.succeed("grep -qx 0x15ad /sys/bus/pci/devices/*/vendor")
    machine.succeed("test -d /sys/module/vmwgfx")
    j = machine.succeed("journalctl -b -o cat --no-pager")
    bad = re.findall(r".*Failed to start .*Load Kernel Modules.*|.*systemd-modules-load\.service: (?:Failed|Main process exited, code=exited, status=[1-9]).*|.*Failed to insert module.*", j)
    assert not bad, bad
    assert machine.succeed("systemctl show -p Result --value systemd-modules-load.service").strip() == "success"
    ml = machine.succeed("journalctl -b -o cat --no-pager -t systemd-modules-load")
    print(ml)
    # D and the hv_* follow-up: no platform driver of another hypervisor is forced in by name any more
    assert not re.search(r"vmwgfx|vboxvideo|hyperv_drm|hv_|vmw_pvscsi", ml), ml

with subtest("first boot cut off after install.ensure and before closeFirstBoot: the console asks again and completes"):
    machine.wait_until_tty_matches("1", "Administrator login: ", timeout=300)
    machine.fail(f"test -e {MD}/first-boot-id")
    # Held stdin: agentosctl firstboot runs install.ensure and reads the status, then waits for the password, so it
    # stops between install.ensure and users.provision. The power is cut there.
    machine.succeed("systemd-run --unit=fb-cut -p Type=exec --setenv=PATH=/run/current-system/sw/bin sh -c 'sleep infinity | agentosctl firstboot --admin alice --workspace A'")
    machine.wait_until_succeeds(f"test -s {MD}/first-boot-id && agentosctl status >/dev/null", timeout=120)
    machine.succeed("systemctl is-active fb-cut.service")
    fbid = machine.succeed(f"cat {MD}/first-boot-id").strip()
    assert sql("SELECT first_boot_state FROM machine_meta") == "open"
    assert sql("SELECT COUNT(*) FROM users") == "0"
    machine.succeed("sync")
    machine.crash()
    machine.start()
    machine.wait_for_unit("agentos-machine.service")
    machine.fail(f"test -e {MARKER}")
    assert machine.succeed(f"cat {MD}/first-boot-id").strip() == fbid, "first boot started over with a new id"
    assert sql("SELECT first_boot_state FROM machine_meta") == "open"
    answer_first_boot("alice", "alice-pw-1", "A")
    machine.wait_until_succeeds(f"test -s {MARKER}", timeout=180)
    machine.wait_for_unit("multi-user.target")          # first setup has finished, so boot completes
    assert sql("SELECT first_boot_state FROM machine_meta") == "closed"
    assert sql("SELECT COUNT(*) FROM users WHERE role = 'admin' AND state = 'active'") == "1"
    machine.succeed("journalctl -b -o cat --no-pager -t agentos-first-setup | grep -q 'first boot completed for administrator alice'")

with subtest("no DRM device on QEMU's SVGA II: greetd is not started or retried, tty1 says why, the tty2 text login keeps the console"):
    # If this precondition ever fails (a QEMU that vmwgfx accepts), ReGreet can be checked here instead.
    machine.succeed("dmesg | grep -q 'vmwgfx.*probe with driver vmwgfx failed'")
    machine.fail("ls /dev/dri/card*")
    greetd_diag("no DRM device, first boot just closed")
    # The KMS check waits 10 s for a card (as Cage would) before the notice; the user is on Ctrl+Alt+F2 meanwhile.
    tty_login(2, "alice", "alice-pw-1")
    greetd_diag("tty2 login done")
    polls = vt_stays(2, lambda: not_started() >= 1, timeout=120)
    print(f"tty2 kept the console for {polls} polls until the notice")
    greetd_diag("notice shown")
    machine.succeed("loginctl list-sessions --no-legend | grep -w alice | grep -qw tty2")
    # One check, no retry: Restart=always never restarts a skipped ExecCondition (systemd service.c
    # service_shall_restart, SERVICE_SKIP_CONDITION), and greetd's main process (the VT1 switch) never ran.
    assert skips() == 1, skips()
    assert machine.succeed("systemctl show -p Result --value greetd.service").strip() == "exec-condition"
    assert machine.succeed("systemctl show -p NRestarts --value greetd.service").strip() == "0"
    assert machine.succeed("systemctl show -p ExecMainStartTimestampMonotonic --value greetd.service").strip() == "0"
    assert gave_up() == "0", "the retry notice ran although nothing was retried"
    assert not_started() == 1
    machine.succeed("chvt 1")
    machine.wait_until_tty_matches("1", "Press Enter to start the login screen again", timeout=60)
    tty1 = machine.get_tty_text("1")
    assert "no display device was found" in tty1, tty1
    assert "restart" not in tty1.split("Last messages")[0], tty1
    machine.send_key("ret")
    # Enter starts greetd again: one more 10 s check, one more notice; back on tty2 the console stays there throughout
    machine.wait_until_succeeds("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | grep -q 'starting the login screen again'", timeout=30)
    machine.send_key("alt-f2")
    machine.wait_until_succeeds("grep -qx tty2 /sys/class/tty/tty0/active", timeout=30)
    vt_stays(2, lambda: not_started() >= 2, timeout=120)
    greetd_diag("after Enter")
    assert skips() == 2, skips()
    assert machine.succeed("systemctl show -p NRestarts --value greetd.service").strip() == "0"
    assert gave_up() == "0"
    machine.succeed("loginctl list-sessions --no-legend | grep -w alice | grep -qw tty2")

with subtest("an install from before the first-boot-closed marker: machined restores it before ready, no first boot"):
    machine.succeed(f"rm {MARKER}")
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("agentos-machine.service")
    machine.succeed(f"test -s {MARKER}")
    # greetd is started (not held by first setup); on this VM without a DRM card its KMS check runs and skips it
    machine.wait_until_succeeds("journalctl -b -o cat --no-pager -t agentos-greeter | grep -q '^no display device'", timeout=300)
    greetd_diag("boot with the marker restored")
    assert machine.succeed("systemctl show -p ConditionResult --value agentos-first-setup.service").strip() == "no"
    assert machine.succeed("systemctl show -p ExecMainStartTimestampMonotonic --value agentos-first-setup.service").strip() == "0"
