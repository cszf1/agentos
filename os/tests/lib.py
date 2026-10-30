# Shared helpers for AgentOS VM checks (prepended to each test script).
import json

RPC = "python3 /etc/agentos-test/rpc.py /run/agentos/gateway.sock"

def rpc_as_root(reqs):
    return [json.loads(l) for l in machine.succeed(f"{RPC} '{json.dumps(reqs)}'").strip().splitlines()]

def tty_login(n, user, pw):
    machine.send_key(f"alt-f{n}")
    # With a KMS console (virtio-gpu, greetd on VT1) the key switch alone may not spawn the autovt getty: switch and
    # start it explicitly (no-op when it already runs).
    machine.succeed(f"chvt {n}; systemctl start getty@tty{n}.service")
    machine.wait_until_tty_matches(str(n), "login: ")
    machine.send_chars(f"{user}\n")
    machine.wait_until_tty_matches(str(n), "Password: ")
    machine.send_chars(f"{pw}\n")
    machine.wait_until_succeeds(f"loginctl list-sessions --no-legend | grep -w {user}")

def tty_run(n, cmd, out):
    # Run inside the real tty login session (seat0); results go to a file the test reads back.
    # Typing long lines through the emulated keyboard drops characters under TCG: type only a short command and
    # let a root-written script (world-readable) carry the payload.
    import base64
    # send_chars types into the ACTIVE VT: switch to tty n first (and that session becomes the active one on seat0).
    machine.send_key(f"alt-f{n}")
    machine.wait_until_succeeds(f"grep -qx tty{n} /sys/class/tty/tty0/active")
    script = f"{cmd} > {out} 2>&1; echo done >> {out}\n"
    machine.succeed(f"echo {base64.b64encode(script.encode()).decode()} | base64 -d > {out}.sh && chmod 0644 {out}.sh && rm -f {out}")
    machine.send_chars(f"sh {out}.sh\n")
    try:
        machine.wait_until_succeeds(f"grep -q '^done$' {out}", timeout=200)
    except BaseException:
        print(machine.execute(f"cat {out}; journalctl -u agentos-machine -u agentos-session-gateway --no-pager | tail -40; ps aux | grep -E 'rpc.py|agentos' | head")[1])
        raise
    return machine.succeed(f"cat {out}")

def user_session(user, tty=None):
    # logind 260 list-sessions columns are SESSION UID USER SEAT LEADER CLASS TTY ...; the user manager also owns a
    # session (class "manager", cannot be locked). Pick the user's class=user session, on the given TTY if named.
    script = ("for s in $(loginctl list-sessions --no-legend | awk '{print $1}'); do "
              "echo \"$s $(loginctl show-session $s -p Name --value) $(loginctl show-session $s -p Class --value) "
              "$(loginctl show-session $s -p TTY --value)\"; done")
    best = ""
    for line in machine.succeed(script).splitlines():
        f = line.split() + ["", "", ""]
        if f[1] == user and f[2] == "user" and (tty is None or f[3] == tty):
            best = f[0]
    assert best, machine.succeed(script)
    return best

def revocation_diag(rid):
    M = "sqlite3 /var/lib/agentos-machine/machine.sqlite"
    print(machine.execute(f"{M} \"SELECT * FROM revocations WHERE revocation_id='{rid}'\"; {M} \"SELECT target_kind, target_id, registry_seq, kind, state, attempt_count FROM registry_outbox ORDER BY registry_seq DESC LIMIT 20\"")[1])
    print(machine.execute("journalctl -u agentos-broker -u agentos-machine -u agentos-session-gateway --no-pager | grep -iE 'registry|revok|error|warn' | tail -40")[1])
    print(machine.execute("for f in /var/lib/agentos/workspaces/*/data/logs/*.log*; do echo == $f; grep -E 'registry|revok|error' $f | tail -15; done")[1])

def wait_revoked(rid, timeout=90):
    try:
        machine.wait_until_succeeds(f"test \"$(sqlite3 /var/lib/agentos-machine/machine.sqlite \\\"SELECT state FROM revocations WHERE revocation_id='{rid}'\\\")\" = revoked", timeout=timeout)
    except BaseException:
        revocation_diag(rid)
        raise

def must(cmd):
    rc, out = machine.execute(cmd + " 2>&1")
    if rc != 0:
        print(out)
        print(machine.execute("journalctl -u agentos-machine -u agentos-session-gateway --no-pager | tail -60")[1])
        raise Exception(f"failed: {cmd}")
    return out

