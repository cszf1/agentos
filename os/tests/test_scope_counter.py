"""The security snapshot must count zero matches, not fail on grep=1 or hide genuine read errors."""
import ast
from pathlib import Path
import subprocess
import tempfile
import unittest


def counter_command():
    source = Path(__file__).with_name("m5-desktop.py")
    scope = next(x for x in ast.parse(source.read_text()).body if isinstance(x, ast.FunctionDef) and x.name == "scope")
    values = next(x.value for x in scope.body if isinstance(x, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "v" for t in x.targets))
    call = next(v for k, v in zip(values.keys, values.values) if isinstance(k, ast.Constant) and k.value == "loginUidProcsInWorkspace")
    # machine.succeed(COMMAND).strip(): evaluate only the controlled command f-string, not the VM script.
    expression = call.func.value.args[0]
    return eval(compile(ast.Expression(expression), str(source), "eval"), {}, {"alice_uid": "12345", "ws": "fixture-ws"})


class ScopeCounterTest(unittest.TestCase):
    def run_counter(self, groups, pids=None, pgrep_rc=0):
        with tempfile.TemporaryDirectory(prefix="agentos-proc-counter-") as root:
            for pid, content in groups.items():
                directory = Path(root, pid)
                directory.mkdir()
                if content is None:  # an existing, unreadable-as-a-file path: must not be silently counted as zero
                    (directory / "cgroup").mkdir()
                else:
                    (directory / "cgroup").write_text(content)
            pids = list(groups) if pids is None else pids
            listing = "printf '%s\\n' " + " ".join(pids) if pids else ":"
            if pgrep_rc:
                listing = f"sh -c 'exit {pgrep_rc}'"
            command = counter_command().replace("$(pgrep -u 12345)", f"$({listing})").replace("/proc/", root + "/")
            return subprocess.run(["bash", "-euo", "pipefail", "-c", command], text=True, capture_output=True)

    def test_no_matching_login_process_is_a_valid_zero(self):
        result = self.run_counter({"11": "0::/user.slice/session-2.scope\n"})
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "0"), result.stderr)

    def test_matching_login_process_is_counted_not_discarded(self):
        result = self.run_counter({"11": "0::/agentos-host@fixture-ws.service\n", "12": "0::/other\n"})
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "1"), result.stderr)

    def test_process_that_exited_during_the_snapshot_can_be_skipped(self):
        result = self.run_counter({}, pids=["99"])
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "0"), result.stderr)

    def test_read_error_for_a_still_existing_process_is_not_zero(self):
        result = self.run_counter({"11": None})
        self.assertNotEqual(result.returncode, 0)

    def test_no_login_processes_is_a_valid_zero(self):
        result = self.run_counter({}, pgrep_rc=1)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "0"), result.stderr)

    def test_pgrep_error_is_not_zero(self):
        result = self.run_counter({}, pgrep_rc=2)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
