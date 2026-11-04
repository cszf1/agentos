# m21-vmware: see m21-vmware.nix. Prepended: lib.py (tty_login, answer_first_boot).
import re
import time

MD = "/var/lib/agentos-machine"
MARKER = f"{MD}/first-boot-closed"

def sql(q):
    return machine.succeed(f"sqlite3 {MD}/machine.sqlite \"{q}\"").strip()

def starts(unit):
    # start attempts: systemd logs "Starting <unit>" for the first start and for every restart job it runs. Without a
    # DRM card greetd's ExecStartPre fails, so these never reach "Started".
    return int(machine.succeed(f"journalctl -b -o cat --no-pager -u {unit} | grep -c '^Starting {unit}' || true").strip() or 0)

def gave_up():
    return machine.succeed("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | grep -c 'login screen gave up' || true").strip()

def vt_stays(n, until, timeout):
    # The text login must keep the console: poll the active VT until `until()` holds, it must be tty<n> every time.
    deadline = time.monotonic() + timeout
    polls = 0
    while not until():
        active = machine.succeed("cat /sys/class/tty/tty0/active").strip()
        assert active == f"tty{n}", f"the console was pulled to {active} while greetd retried (poll {polls})"
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

with subtest("no DRM device on QEMU's SVGA II: the tty2 text login keeps the console while greetd retries, then tty1 says it gave up"):
    # If this precondition ever fails (a QEMU that vmwgfx accepts), ReGreet can be checked here instead.
    machine.succeed("dmesg | grep -q 'vmwgfx.*probe with driver vmwgfx failed'")
    machine.fail("ls /dev/dri/card*")
    burst = int(machine.succeed("systemctl show -p StartLimitBurst --value greetd.service"))
    assert burst >= 2, burst
    # The notice on tty1 points at Ctrl+Alt+F2; the user goes there while greetd is still retrying (first boot just
    # closed, so the retries have only begun).
    tty_login(2, "alice", "alice-pw-1")
    s0 = starts("greetd.service")
    assert gave_up() == "0" and s0 < burst, f"greetd was no longer retrying when the tty2 login finished ({s0} starts)"
    polls = vt_stays(2, lambda: gave_up() != "0", timeout=600)
    assert starts("greetd.service") > s0, "no greetd retry ran while the console was watched"
    print(f"tty2 kept the console for {polls} polls across {starts('greetd.service') - s0} greetd retries")
    machine.succeed("loginctl list-sessions --no-legend | grep -w alice | grep -qw tty2")
    print(machine.succeed("journalctl -b -o cat --no-pager -t agentos-greeter | tail -20"))
    # greetd itself never ran: its KMS check failed first, so nothing took VT1 for a greeter
    machine.succeed("journalctl -b -o cat --no-pager -t agentos-greeter | grep -q 'no display device (/dev/dri/card\\*)'")
    assert machine.succeed("systemctl show -p ExecMainStartTimestampMonotonic --value greetd.service").strip() == "0"
    # systemd (service.c, service_enter_restart) counts NRestarts when it queues the restart job, and the start limit
    # refuses that job later (service_test_startable). With StartLimitBurst=N, greetd starts N times, the Nth restart
    # job is refused, and NRestarts is N when OnFailure runs the notice. A failing ExecStartPre counts like a failing
    # greeter: Restart=always restarts it and each attempt counts towards the limit.
    machine.succeed(f"journalctl -b -o cat --no-pager -t agentos-greeter-fallback | grep -q 'result=start-limit-hit restarts={burst}$'")
    n = starts("greetd.service")
    assert n == burst, f"greetd started {n} times before the fallback, StartLimitBurst={burst}"
    machine.succeed("chvt 1")
    machine.wait_until_tty_matches("1", "Press Enter to start the login screen again", timeout=60)
    machine.send_key("ret")
    machine.wait_until_succeeds(f"test $(journalctl -b -o cat --no-pager -u greetd.service | grep -c '^Starting greetd') -gt {n}", timeout=60)
    # Enter started a new round of retries; back on tty2, the console stays there through more of them
    machine.send_key("alt-f2")
    machine.wait_until_succeeds("grep -qx tty2 /sys/class/tty/tty0/active", timeout=30)
    s1 = starts("greetd.service")
    vt_stays(2, lambda: starts("greetd.service") >= s1 + 2, timeout=300)
    machine.succeed("loginctl list-sessions --no-legend | grep -w alice | grep -qw tty2")

with subtest("an install from before the first-boot-closed marker: machined restores it before ready, no first boot"):
    machine.succeed(f"rm {MARKER}")
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("agentos-machine.service")
    machine.succeed(f"test -s {MARKER}")
    # greetd is started (not held by first setup); on this VM without a DRM card that is a start attempt
    machine.wait_until_succeeds("journalctl -b -o cat --no-pager -u greetd.service | grep -q '^Starting greetd'", timeout=300)
    assert machine.succeed("systemctl show -p ConditionResult --value agentos-first-setup.service").strip() == "no"
    assert machine.succeed("systemctl show -p ExecMainStartTimestampMonotonic --value agentos-first-setup.service").strip() == "0"
