import json

RPC = "python3 /etc/agentos-test/rpc.py /run/agentos/gateway.sock"

def rpc_as_root(reqs):
    return [json.loads(l) for l in machine.succeed(f"{RPC} '{json.dumps(reqs)}'").strip().splitlines()]

def tty_login(n, user, pw):
    machine.send_key(f"alt-f{n}")
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

machine.start()
machine.wait_for_unit("agentos-machine.service")
machine.wait_for_unit("agentos-session-gateway.service")
machine.succeed("test -S /run/agentos/machine/machine.sock && test -S /run/agentos/gateway.sock && test -S /run/agentos/gateway/host.sock")
machine.succeed("stat -c '%U %a' /run/agentos/gateway | grep -q 'root 755'")
# No TCP listener for AgentOS (spec §8.1)
machine.fail("ss -ltnp | grep -E 'agentos|node'")

with subtest("first boot: one identity, admin, default workspace; repeat is rejected"):
    out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace 'Alice 工作区'"))
    ws_a = out["workspaceId"]
    mid = out["machineInstallId"]
    machine.fail("printf 'x' | agentosctl firstboot --admin mallory")
    st = json.loads(machine.succeed("agentosctl status"))
    assert st["meta"]["machineInstallId"] == mid and st["meta"]["firstBootState"] == "closed", st

with subtest("root without a login session cannot bind (I02)"):
    r = rpc_as_root({"methodId": "session.bind"})[0]
    assert r["status"] == 401 and r["error"]["code"] == "SESSION_REQUIRED", r

with subtest("real PAM login on tty1 binds a session from the kernel peer (I01)"):
    tty_login(1, "alice", "alice-pw-1")
    res = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.list\"}}]'", "/tmp/a1")
    lines = [json.loads(l) for l in res.splitlines() if l.startswith("{")]
    assert lines[0]["status"] == 200 and lines[0]["body"]["loginName"] == "alice", lines
    assert [w["workspaceId"] for w in lines[1]["body"]["workspaces"]] == [ws_a], lines

with subtest("create user bob through a confirmed machine plan with admin re-authentication"):
    plan = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"machine.users.create\",\"idempotencyKey\":\"2b6f2f1e-6a51-4c63-9a4b-0d1e7c3a5b10\",\"body\":{{\"loginName\":\"bob\",\"role\":\"user\",\"password\":\"bob-pw-1\"}}}}]'", "/tmp/a2")
    p = [json.loads(l) for l in plan.splitlines() if l.startswith("{")][1]
    assert p["status"] == 201 and p["body"]["state"] == "planned", p
    op, ph = p["body"]["operationId"], p["body"]["planHash"]
    bad = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"machine.actions.confirm\",\"idempotencyKey\":\"k1\",\"body\":{{\"operationId\":\"{op}\",\"planHash\":\"{ph}\",\"password\":\"wrong\"}}}}]'", "/tmp/a3")
    assert '"SESSION_REQUIRED"' in bad, bad
    ok = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"machine.actions.confirm\",\"idempotencyKey\":\"k2\",\"body\":{{\"operationId\":\"{op}\",\"planHash\":\"{ph}\",\"password\":\"alice-pw-1\"}}}}]'", "/tmp/a4")
    assert '"succeeded"' in ok, ok
    machine.succeed("id bob")
    machine.fail("id -nG bob | grep -wE 'wheel|sudo'")

with subtest("bob's workspace gets its own execution UID, sub-ID range and roots (W01)"):
    tty_login(2, "bob", "bob-pw-1")
    r = tty_run(2, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.create\",\"idempotencyKey\":\"5d0f8a5e-1f6e-4a8a-8f0e-2b2a6c9d1e33\",\"body\":{{\"displayName\":\"Bob\"}}}},{{\"methodId\":\"workspaces.list\"}}]'", "/tmp/b1")
    lines = [json.loads(l) for l in r.splitlines() if l.startswith("{")]
    ws_b = lines[1]["body"]["workspaceId"]
    assert [w["workspaceId"] for w in lines[2]["body"]["workspaces"]] == [ws_b], lines
    ua = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_a}/data").strip()
    ub = machine.succeed(f"stat -c %u /var/lib/agentos/workspaces/{ws_b}/data").strip()
    assert ua != ub, (ua, ub)
    machine.succeed(f"stat -c '%a' /var/lib/agentos/workspaces/{ws_a}/data | grep -q 700")
    # each execution account cannot read the other's database
    machine.fail(f"setpriv --reuid {ua} --regid {ua} --clear-groups cat /var/lib/agentos/workspaces/{ws_b}/data/os.sqlite")
    machine.fail(f"setpriv --reuid {ub} --regid {ub} --clear-groups cat /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite")
    # login users cannot read either workspace
    machine.fail(f"su alice -c 'cat /var/lib/agentos/workspaces/{ws_a}/data/os.sqlite'")
    sub = machine.succeed("cat /etc/subuid")
    assert sub.count(":65536") >= 2, sub

with subtest("B cannot see or guess A's workspace (I03)"):
    r = tty_run(2, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.get\",\"workspaceId\":\"{ws_a}\"}},{{\"methodId\":\"workspace.forward\",\"workspaceId\":\"{ws_a}\",\"body\":{{\"routeId\":\"state.list\"}}}}]'", "/tmp/b2")
    lines = [json.loads(l) for l in r.splitlines() if l.startswith("{")]
    assert lines[1]["status"] == 404 and lines[1]["error"]["code"] == "NOT_FOUND_OR_FORBIDDEN", lines
    assert lines[2]["status"] == 404 and lines[2]["error"]["code"] == "NOT_FOUND_OR_FORBIDDEN", lines

with subtest("attach starts A's Host under its execution UID; forward reaches it through the gateway"):
    r = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspaces.attach\",\"workspaceId\":\"{ws_a}\",\"idempotencyKey\":\"a\",\"body\":{{}}}},{{\"methodId\":\"workspace.forward\",\"workspaceId\":\"{ws_a}\",\"body\":{{\"routeId\":\"state.list\"}}}}]'", "/tmp/a5")
    lines = [json.loads(l) for l in r.splitlines() if l.startswith("{")]
    if lines[1]["status"] != 200:
        print(machine.execute(f"ps -eo uid,pid,cgroup:120,args | awk '$1=={ua}'; journalctl -u agentos-machine --no-pager | tail -30; journalctl _UID={ua} --no-pager | tail -30")[1])
    assert lines[1]["status"] == 200, lines
    assert lines[2]["status"] == 200 and "apps" in lines[2]["body"]["data"], lines
    machine.succeed(f"pgrep -u {ua} -f agentos/packages/host/dist/main.js")
    machine.fail(f"pgrep -u {ub} -f agentos/packages/host/dist/main.js")
    # the Host has no TCP port
    machine.fail("ss -ltnp | grep node")

with subtest("a forged forward cannot carry a URL or principal (I12)"):
    r = tty_run(1, f"{RPC} '[{{\"methodId\":\"session.bind\"}},{{\"methodId\":\"workspace.forward\",\"workspaceId\":\"{ws_a}\",\"body\":{{\"routeId\":\"state.list\",\"principal\":\"user:local\"}}}},{{\"methodId\":\"workspace.forward\",\"workspaceId\":\"{ws_a}\",\"body\":{{\"routeId\":\"/api/state\"}}}}]'", "/tmp/a6")
    lines = [json.loads(l) for l in r.splitlines() if l.startswith("{")]
    assert lines[1]["status"] == 400 and lines[2]["status"] == 400, lines

with subtest("machined restart keeps identity, sessions must rebind"):
    machine.succeed("systemctl restart agentos-machine.service")
    machine.wait_for_unit("agentos-machine.service")
    st = json.loads(machine.succeed("agentosctl status"))
    assert st["meta"]["machineInstallId"] == mid
