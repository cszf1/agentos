import json, time
machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
machine.wait_for_unit("greetd.service")
must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A")

with subtest("login on a VT starts Sway with the Qt Shell; no browser engine (D01)"):
    tty_login(2, "alice", "alice-pw-1")
    machine.send_chars("exec agentos-session\n")
    machine.wait_until_succeeds("pgrep -u alice -x sway", timeout=120)
    machine.wait_until_succeeds("pgrep -u alice -f bin/agentos-shell", timeout=120)
    pid = machine.succeed("pgrep -u alice -f bin/agentos-shell | head -1").strip()
    time.sleep(5)
    maps = machine.succeed(f"cat /proc/{pid}/maps")
    for bad in ["WebEngine", "libQt6WebView", "chromium", "firefox"]:
        assert bad not in maps, bad
    machine.fail("pgrep -f -i 'chromium|firefox|webkit'")
    machine.succeed(f"grep -q libQt6Quick /proc/{pid}/maps")
    machine.screenshot("shell")

with subtest("lock: swaylock confirms, logind LockedHint=yes, gateway refuses (I10/H03)"):
    sid = machine.succeed("loginctl list-sessions --no-legend | awk '$3==\"alice\" && $5==\"tty2\" {print $1}'").strip() or \
          machine.succeed("loginctl list-sessions --no-legend | awk '$3==\"alice\" {print $1}' | tail -1").strip()
    machine.succeed(f"loginctl lock-session {sid}")
    machine.wait_until_succeeds("pgrep -u alice -x swaylock", timeout=60)
    machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.screenshot("locked")
    machine.send_chars("alice-pw-1\n")
    machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q no", timeout=60)
    machine.wait_until_fails("pgrep -u alice -x swaylock", timeout=60)

with subtest("a killed locker never returns to an unlocked desktop (H03)"):
    machine.succeed(f"loginctl lock-session {sid}")
    machine.wait_until_succeeds(f"loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.succeed("pkill -KILL -u alice -x swaylock")
    # the session agent ends the session (back to the greeter) instead of clearing LockedHint
    machine.wait_until_succeeds(f"! loginctl show-session {sid} -p State 2>/dev/null | grep -q active || loginctl show-session {sid} -p LockedHint | grep -q yes", timeout=60)
    machine.wait_until_fails("pgrep -u alice -f bin/agentos-shell", timeout=90)
    machine.fail(f"loginctl show-session {sid} -p LockedHint 2>/dev/null | grep -q '=no'")
