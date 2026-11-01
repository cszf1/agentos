"""m9's machine-directory drill must hold the broker down against agentos-broker.path, then re-arm the path unit."""
import ast
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

SOCK = "/run/agentos-broker/broker.sock"
SUBTEST = "machine directory lost"

# A model of systemctl, not real systemd. It encodes what m9 run 41220513266 showed on the VM: with machine.secret
# present, a stopped broker whose path unit is still active is started again at once, and while machined is down the
# Type=notify broker stays "activating". The service's ConditionPathExists=machine.secret skips a start (rc 0, inactive)
# when the secret is gone. The broker socket exists only while the service is active.
FAKE_SYSTEMCTL = textwrap.dedent('''\
    #!{python}
    import os, socket, sys
    units, sock, secret = os.environ["FAKE_UNITS"], os.environ["FAKE_SOCK"], os.environ["FAKE_SECRET"]
    def state(u):
        f = os.path.join(units, u)
        return open(f).read() if os.path.exists(f) else "inactive"
    def put(u, s):
        f = os.path.join(units, u)
        if s == "inactive":
            if os.path.exists(f): os.remove(f)
        else:
            open(f, "w").write(s)
    def start(u):
        if u == "agentos-broker.service":
            if not os.path.exists(secret): put(u, "inactive"); return
            put(u, "active" if state("agentos-machine.service") == "active" else "activating")
        else:
            put(u, "active")
    argv = sys.argv[1:]
    verb = argv[0]
    if verb == "show":
        prop = argv[argv.index("-p") + 1]
        assert prop == "ActiveState", prop
        print(state(argv[-1])); sys.exit(0)
    args = [a for a in argv[1:] if not a.startswith("-")]
    if verb == "is-active":
        sys.exit(0 if all(state(u) == "active" for u in args) else 3)
    for u in args:
        if verb == "stop": put(u, "inactive")
        elif verb in ("start", "restart"):
            if verb == "restart": put(u, "inactive")
            start(u)
        else: sys.exit("unmodelled verb " + verb)
    os.execv(sys.executable, [sys.executable, os.environ["FAKE_TICK"]])
''')

# Applied after every systemctl call and every modelled machine event: the path unit's trigger and the socket.
TICK = textwrap.dedent('''\
    import os, socket
    units, sock, secret = os.environ["FAKE_UNITS"], os.environ["FAKE_SOCK"], os.environ["FAKE_SECRET"]
    def state(u):
        f = os.path.join(units, u)
        return open(f).read() if os.path.exists(f) else "inactive"
    b = "agentos-broker.service"
    if state("agentos-broker.path") == "active" and os.path.exists(secret) and state(b) == "inactive":
        open(os.path.join(units, b), "w").write("activating")
    if state(b) == "activating" and state("agentos-machine.service") == "active":
        open(os.path.join(units, b), "w").write("active")
    if state(b) == "active" and not os.path.exists(sock):
        socket.socket(socket.AF_UNIX).bind(sock)
    if state(b) != "active" and os.path.exists(sock):
        os.remove(sock)
''')


def subtest_body(source=None):
    """The statements of m9's machine-directory subtest, in order."""
    tree = ast.parse(source if source is not None else Path(__file__).with_name("m9-restore.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.With):
            call = node.items[0].context_expr
            if (isinstance(call, ast.Call) and getattr(call.func, "id", None) == "subtest"
                    and isinstance(call.args[0], ast.Constant) and call.args[0].value.startswith(SUBTEST)):
                return node.body
    raise AssertionError("m9 subtest not found: " + SUBTEST)


def events(body):
    """Each call the driver makes, as (kind, argument): succeed/execute/fail/ctl/wait_for_unit."""
    out = []
    for stmt in body:
        for c in ast.walk(stmt):
            if not isinstance(c, ast.Call) or not c.args or not isinstance(c.args[0], ast.Constant):
                continue
            if isinstance(c.func, ast.Attribute) and isinstance(c.func.value, ast.Name) and c.func.value.id == "machine":
                out.append((c.func.attr, c.args[0].value))
            elif isinstance(c.func, ast.Name) and c.func.id == "ctl":
                out.append(("ctl", c.args[0].value))
    return out


class M9BrokerHoldTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="agentos-m9-hold-")
        r = Path(self.root.name)
        (r / "bin").mkdir()
        (r / "units").mkdir()
        fake = r / "bin" / "systemctl"
        fake.write_text(FAKE_SYSTEMCTL.format(python=sys.executable))
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        (r / "tick.py").write_text(TICK)
        self.sock, self.secret = str(r / "broker.sock"), r / "machine.secret"
        self.env = {**os.environ, "PATH": f"{r / 'bin'}:{os.environ['PATH']}", "FAKE_UNITS": str(r / "units"),
                    "FAKE_SOCK": self.sock, "FAKE_SECRET": str(self.secret), "FAKE_TICK": str(r / "tick.py")}
        self.secret.write_text("old identity")
        self.sh("systemctl start agentos-machine.service agentos-session-gateway.service agentos-broker.path agentos-broker.service")
        self.assertEqual(self.state("agentos-broker.service"), "active")

    def tearDown(self):
        self.root.cleanup()

    def sh(self, command):
        return subprocess.run(["bash", "-c", command.replace(SOCK, self.sock).replace("sleep 2;", "")],
                              env=self.env, text=True, capture_output=True)

    def tick(self):
        subprocess.run([sys.executable, self.env["FAKE_TICK"]], env=self.env, check=True)

    def state(self, unit):
        return self.sh(f"systemctl show -p ActiveState --value {unit}").stdout.strip()

    def broker_down(self):
        return self.state("agentos-broker.service") == "inactive" and not os.path.exists(self.sock)

    def drive(self, body, stop_at_removal=False):
        """Replay the subtest's broker-relevant calls on the model; machine data commands become model events."""
        for kind, arg in events(body):
            if "rm -f /var/lib/agentos-machine/machine.sqlite" in arg:
                self.assertTrue(self.broker_down(), ("broker not held down when the machine directory goes",
                                                     self.state("agentos-broker.service"), os.path.exists(self.sock)))
                if stop_at_removal:
                    return
            elif kind == "ctl" and arg == "recover --new-identity":
                self.secret.unlink()                                  # recover moves machine.secret into lost-*
                self.tick()
            elif kind == "execute" and "agentosctl firstboot --admin eve --workspace" in arg:
                self.secret.write_text("new identity")                # first boot of the new identity writes it
                self.tick()
            elif kind == "wait_for_unit":
                self.assertEqual(self.state(arg), "active", arg)
            elif kind == "succeed" and "systemctl" in arg:
                res = self.sh(arg)
                self.assertEqual(res.returncode, 0, (arg, self.state("agentos-broker.service"), res.stderr))

    def test_broker_is_down_when_the_machine_directory_goes(self):
        self.drive(subtest_body(), stop_at_removal=True)

    def test_hold_check_refuses_a_retriggered_broker(self):
        body = subtest_body()
        checks = [arg for kind, arg in events(body) if kind == "succeed" and "ActiveState" in arg]
        self.assertTrue(checks, "the drill has no broker state check")
        hold = checks[0]
        self.sh("systemctl stop agentos-broker.service agentos-machine.service")
        self.assertEqual(self.state("agentos-broker.service"), "activating", "the model must re-trigger a lone stop")
        self.assertNotEqual(self.sh(hold).returncode, 0, ("an activating broker passed", hold))
        self.sh("systemctl start agentos-machine.service")
        self.assertEqual(self.state("agentos-broker.service"), "active")
        self.assertNotEqual(self.sh(hold).returncode, 0, ("an active broker passed", hold))
        self.sh("systemctl stop agentos-broker.path agentos-broker.service")
        self.assertEqual(self.sh(hold).returncode, 0, ("a stopped broker failed", hold))

    def test_whole_subtest_rearms_the_path_and_firstboot_starts_the_broker(self):
        self.drive(subtest_body())
        self.assertEqual(self.state("agentos-broker.path"), "active")
        self.assertTrue(stat.S_ISSOCK(os.stat(self.sock).st_mode))

    def test_without_rearming_the_path_firstboot_never_starts_the_broker(self):
        # The re-arm is load-bearing: the same drill without it leaves the broker down after first boot.
        source = Path(__file__).with_name("m9-restore.py").read_text()
        rearm = '    machine.succeed("systemctl start agentos-broker.path")\n'
        self.assertTrue(rearm in source, "the drill does not re-arm agentos-broker.path")
        with self.assertRaises(AssertionError):
            self.drive(subtest_body(source.replace(rearm, "", 1)))


if __name__ == "__main__":
    unittest.main()
