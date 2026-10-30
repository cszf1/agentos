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

def must(cmd):
    rc, out = machine.execute(cmd + " 2>&1")
    if rc != 0:
        print(out)
        print(machine.execute("journalctl -u agentos-machine -u agentos-session-gateway --no-pager | tail -60")[1])
        raise Exception(f"failed: {cmd}")
    return out

