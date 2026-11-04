# m21-vmware: see m21-vmware.nix. Prepended: lib.py (tty_login, answer_first_boot).
import re

MD = "/var/lib/agentos-machine"
MARKER = f"{MD}/first-boot-closed"

def sql(q):
    return machine.succeed(f"sqlite3 {MD}/machine.sqlite \"{q}\"").strip()

def started(unit):
    return int(machine.succeed(f"journalctl -b -o cat --no-pager -u {unit} | grep -c '^Started {unit}' || true").strip() or 0)

machine.start()

with subtest("VMware SVGA II: vmwgfx comes from udev, and no Load Kernel Modules unit fails (initrd or system)"):
    # Not multi-user.target: agentos-first-setup (oneshot, WantedBy=multi-user.target, TimeoutStartSec=infinity) holds
    # it until first boot is answered on tty1. The prompt comes after sysinit, so both Load Kernel Modules runs are over.
    machine.wait_for_unit("systemd-modules-load.service")
    machine.wait_until_tty_matches("1", "Administrator login: ", timeout=300)
    machine.succeed("grep -qx 0x15ad /sys/bus/pci/devices/*/vendor")
    machine.succeed("test -d /sys/module/vmwgfx")
    j = machine.succeed("journalctl -b -o cat --no-pager")
    bad = re.findall(r".*Failed to start .*Load Kernel Modules.*|.*systemd-modules-load\.service: (?:Failed|Main process exited, code=exited, status=[1-9]).*", j)
    assert not bad, bad
    assert machine.succeed("systemctl show -p Result --value systemd-modules-load.service").strip() == "success"
    ml = machine.succeed("journalctl -b -o cat --no-pager -t systemd-modules-load")
    print(ml)
    # D: the GPU drivers of the other hypervisors are not forced in by name any more
    assert not re.search(r"vmwgfx|vboxvideo|hyperv_drm", ml), ml

with subtest("first boot cut off after install.ensure and before closeFirstBoot: the console asks again and completes"):
    machine.wait_until_tty_matches("1", "Administrator login: ", timeout=300)
    machine.fail(f"test -e {MD}/first-boot-id")
    # Held stdin: agentosctl firstboot runs install.ensure and reads the status, then waits for the password, so it
    # stops between install.ensure and users.provision. The power is cut there.
    machine.succeed("systemd-run --unit=fb-cut -p Type=exec sh -c 'sleep infinity | agentosctl firstboot --admin alice --workspace A'")
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

with subtest("no DRM device on QEMU's SVGA II: greetd gives up after bounded retries, tty1 says so, text login works"):
    # If this precondition ever fails (a QEMU that vmwgfx accepts), ReGreet can be checked here instead.
    machine.succeed("dmesg | grep -q 'vmwgfx.*probe with driver vmwgfx failed'")
    machine.fail("ls /dev/dri/card*")
    machine.wait_until_succeeds("journalctl -b -o cat --no-pager -t agentos-greeter-fallback | grep -q 'login screen gave up'", timeout=600)
    print(machine.succeed("journalctl -b -o cat --no-pager -t agentos-greeter | tail -20"))
    # systemd (service.c, service_enter_restart) counts NRestarts when it queues the restart job, and the start limit
    # refuses that job later (service_test_startable). With StartLimitBurst=N, greetd starts N times, the Nth restart
    # job is refused, and NRestarts is N when OnFailure runs the notice.
    burst = int(machine.succeed("systemctl show -p StartLimitBurst --value greetd.service"))
    assert burst >= 2, burst
    machine.succeed(f"journalctl -b -o cat --no-pager -t agentos-greeter-fallback | grep -q 'result=start-limit-hit restarts={burst}$'")
    n = started("greetd.service")
    assert n == burst, f"greetd started {n} times before the fallback, StartLimitBurst={burst}"
    machine.succeed("chvt 1")
    machine.wait_until_tty_matches("1", "Press Enter to start the login screen again", timeout=60)
    machine.send_key("ret")
    machine.wait_until_succeeds(f"test $(journalctl -b -o cat --no-pager -u greetd.service | grep -c '^Started greetd') -gt {n}", timeout=60)
    tty_login(2, "alice", "alice-pw-1")

with subtest("an install from before the first-boot-closed marker: machined restores it before ready, no first boot"):
    machine.succeed(f"rm {MARKER}")
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("agentos-machine.service")
    machine.succeed(f"test -s {MARKER}")
    machine.wait_until_succeeds("journalctl -b -o cat --no-pager -u greetd.service | grep -q '^Started greetd'", timeout=300)
    assert machine.succeed("systemctl show -p ConditionResult --value agentos-first-setup.service").strip() == "no"
    assert machine.succeed("systemctl show -p ExecMainStartTimestampMonotonic --value agentos-first-setup.service").strip() == "0"
