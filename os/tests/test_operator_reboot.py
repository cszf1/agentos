"""Exercise the real reboot helper against subprocesses and the pinned zero-argument driver API."""
import ast
from pathlib import Path
import subprocess
import sys
import unittest


def reboot_helper(events):
    source = Path(__file__).with_name("m19-iso.py")
    fn = next(x for x in ast.parse(source.read_text()).body if isinstance(x, ast.FunctionDef) and x.name == "operator_reboot")
    scope = {
        "NODE": "/bin/node", "PASS": "test-volume-password",
        "wait_screen": lambda *a, **kw: events.append(("screen", a[1])),
        "keyed": lambda *a: events.append(("keyed", a[1])),
        "operator_login": lambda *a: events.append(("tty-login", a[1])),
    }
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), scope)
    return scope["operator_reboot"]


class Process:
    def __init__(self, code, short_timeout=None):
        self.child = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.waits = []
        self.short_timeout = short_timeout

    def wait(self, timeout=None):
        self.waits.append(timeout)
        return self.child.wait(timeout=self.short_timeout if timeout is not None and self.short_timeout is not None else timeout)


class Machine:
    def __init__(self, process):
        self.process = process
        self.cleaned = self.started = False

    def send_chars(self, *_args, **_kwargs):
        pass

    def wait_for_shutdown(self):  # deliberately the real pinned API: no timeout argument
        assert self.process.child.returncode == 0
        self.process.wait()
        self.cleaned = True

    def start(self):
        assert self.cleaned
        self.started = True

    def close(self):
        if self.process and self.process.child.poll() is None:
            self.process.child.kill()
            self.process.child.wait(timeout=10)


class OperatorRebootTest(unittest.TestCase):
    def run_machine(self, machine):
        self.addCleanup(machine.close)
        events = []
        return reboot_helper(events), events

    def test_bounded_wait_then_zero_argument_driver_cleanup_before_start(self):
        m = Machine(Process("raise SystemExit(0)"))
        run, events = self.run_machine(m)
        run(m, "alice", "test-admin-password")
        self.assertEqual(m.process.waits, [180, None])
        self.assertTrue(m.cleaned and m.started)
        self.assertEqual(events[-1], ("tty-login", "alice"))
        self.assertEqual(len(events), 4)

    def test_timeout_never_cleans_or_restarts_a_live_process(self):
        m = Machine(Process("import time; time.sleep(60)", short_timeout=0.03))
        run, events = self.run_machine(m)
        with self.assertRaises(subprocess.TimeoutExpired):
            run(m, "alice", "test-admin-password")
        self.assertEqual(m.process.waits, [180])
        self.assertFalse(m.cleaned or m.started)
        self.assertEqual(events, [])

    def test_nonzero_qemu_exit_is_not_a_successful_operator_reboot(self):
        m = Machine(Process("raise SystemExit(7)"))
        run, events = self.run_machine(m)
        with self.assertRaisesRegex(AssertionError, "exited unsuccessfully"):
            run(m, "alice", "test-admin-password")
        self.assertFalse(m.cleaned or m.started)
        self.assertEqual(events, [])

    def test_missing_process_is_not_a_completed_reboot(self):
        m = Machine(None)
        run, events = self.run_machine(m)
        with self.assertRaisesRegex(AssertionError, "no QEMU process"):
            run(m, "alice", "test-admin-password")
        self.assertFalse(m.cleaned or m.started)
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
