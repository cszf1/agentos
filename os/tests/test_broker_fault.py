"""m20's broker outage must outlast agentos-broker.path, which re-starts the service as soon as it stops."""
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

# A model of systemctl, not real systemd: it encodes what m20 run 41314773240 showed on the VM. With the path unit's
# PathExists condition holding, a stopped service whose path unit is still active is started again once the stop job
# completes; the service's RuntimeDirectory socket follows its state.
FAKE_SYSTEMCTL = textwrap.dedent('''\
    #!{python}
    import os, socket, sys
    state, sock = os.environ["FAKE_UNITS"], os.environ["FAKE_SOCK"]
    def active(u): return os.path.exists(os.path.join(state, u))
    def set_active(u, on):
        f = os.path.join(state, u)
        if on: open(f, "w").close()
        elif os.path.exists(f): os.remove(f)
    verb, args = sys.argv[1], [a for a in sys.argv[2:] if not a.startswith("-")]
    if verb == "is-active":
        sys.exit(0 if all(active(u) for u in args) else 3)
    for u in args: set_active(u, verb == "start")
    if active("agentos-broker.path") and not active("agentos-broker.service"):
        set_active("agentos-broker.service", True)
    if active("agentos-broker.service") and not os.path.exists(sock):
        socket.socket(socket.AF_UNIX).bind(sock)
    if not active("agentos-broker.service") and os.path.exists(sock):
        os.remove(sock)
''')


def driver_commands(what):
    """The shell commands m20's driver runs for one `do` request, in order."""
    tree = ast.parse(Path(__file__).with_name("m20-sway.py").read_text())
    branch = next(n for n in ast.walk(tree) if isinstance(n, ast.If) and isinstance(n.test, ast.Compare)
                  and isinstance(n.test.left, ast.Name) and n.test.left.id == "w"
                  and isinstance(n.test.comparators[0], ast.Constant) and n.test.comparators[0].value == what)
    return [c.args[0].value for c in ast.walk(ast.Module(body=branch.body, type_ignores=[]))
            if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and c.func.attr == "succeed"]


class BrokerFaultTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="agentos-broker-fault-")
        r = Path(self.root.name)
        (r / "bin").mkdir()
        (r / "units").mkdir()
        fake = r / "bin" / "systemctl"
        fake.write_text(FAKE_SYSTEMCTL.format(python=sys.executable))
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.sock = str(r / "broker.sock")
        self.env = {**os.environ, "PATH": f"{r / 'bin'}:{os.environ['PATH']}", "FAKE_UNITS": str(r / "units"), "FAKE_SOCK": self.sock}
        self.run_cmd("systemctl start agentos-broker.service agentos-broker.path")

    def tearDown(self):
        self.root.cleanup()

    def run_cmd(self, command):
        return subprocess.run(["bash", "-c", command.replace(SOCK, self.sock).replace("sleep 2;", "")], env=self.env, text=True, capture_output=True)

    def is_active(self, unit):
        return self.run_cmd(f"systemctl is-active --quiet {unit}").returncode == 0

    def test_stop_holds_the_broker_down_against_the_path_unit(self):
        for command in driver_commands("broker-stop"):
            result = self.run_cmd(command)
            self.assertEqual(result.returncode, 0, (command, result.stderr))
        self.assertFalse(self.is_active("agentos-broker.service"))
        self.assertFalse(os.path.exists(self.sock))

    def test_stop_command_fails_when_the_broker_comes_back(self):
        result = self.run_cmd("systemctl stop agentos-broker.service")
        self.assertEqual(result.returncode, 0)
        self.assertTrue(self.is_active("agentos-broker.service"), "the modelled path unit must re-trigger a lone service stop")
        check = driver_commands("broker-stop")[-1]
        self.assertNotEqual(self.run_cmd(check).returncode, 0, "the driver's outage check must refuse a re-started broker")

    def test_start_restores_service_and_path(self):
        for command in driver_commands("broker-stop") + driver_commands("broker-start"):
            self.assertEqual(self.run_cmd(command).returncode, 0, command)
        self.assertTrue(self.is_active("agentos-broker.service"))
        self.assertTrue(self.is_active("agentos-broker.path"))
        self.assertTrue(stat.S_ISSOCK(os.stat(self.sock).st_mode))


if __name__ == "__main__":
    unittest.main()
