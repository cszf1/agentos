"""The full slow-reader workload must reach the VM without putting its JSON in a shell argv."""
import ast
import base64
import json
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import tempfile
import unittest
import uuid


class Machine:
    def __init__(self, fail_copy=False):
        self.sources = []
        self.commands = []
        self.fail_copy = fail_copy

    def copy_from_host(self, source, target):
        self.sources.append(Path(source))
        if self.fail_copy:
            raise OSError("copy failed")
        shutil.copyfile(source, target)

    def succeed(self, command):
        self.commands.append(command)
        return subprocess.run(["/bin/bash", "-c", command], check=True, capture_output=True, text=True).stdout


def functions(machine, directory):
    source = Path(__file__).with_name("m20-sway.py")
    scope = {
        "json": json, "base64": base64, "uuid": uuid, "shlex": shlex, "tempfile": tempfile,
        "machine": machine, "D": str(directory), "burst": {},
        "ws": "00000000-0000-4000-8000-000000000001", "bob": "00000000-0000-4000-8000-000000000002",
        "hsql": lambda sql: "0" if "COUNT(*)" in sql else "4",
    }

    members = source.with_name("members_lib.py")
    fwd = next(x for x in ast.parse(members.read_text()).body if isinstance(x, ast.FunctionDef) and x.name == "fwd")
    exec(compile(ast.Module(body=[fwd], type_ignores=[]), str(members), "exec"), scope)
    fns = [x for x in ast.parse(source.read_text()).body if isinstance(x, ast.FunctionDef) and x.name in ("handle", "copy_text_to_guest")]
    exec(compile(ast.Module(body=fns, type_ignores=[]), str(source), "exec"), scope)
    return scope


class BurstTransferTest(unittest.TestCase):
    def test_full_302_request_workload_round_trips_without_a_large_shell_argument(self):
        with tempfile.TemporaryDirectory() as d:
            m = Machine()
            scope = functions(m, d)
            app = "00000000-0000-4000-8000-000000000003"
            reply = scope["handle"](1, {"kind": "do", "what": "burst-prepare", "appId": app})
            dst = Path(reply["file"])
            data = dst.read_bytes()
            requests = json.loads(data)
            self.assertGreater(len(base64.b64encode(data)), 128 * 1024)
            self.assertEqual(len(requests), 302)
            self.assertEqual(scope["burst"]["n"], 302)
            self.assertEqual(requests[0]["methodId"], "session.bind")
            self.assertEqual(requests[-1]["methodId"], "members.revoke")
            self.assertEqual(requests[-1]["idempotencyKey"], scope["burst"]["rid"])
            self.assertEqual([x["body"]["body"]["data"]["title"] for x in requests[1:-1]], [f"burst-{i}" for i in range(300)])
            self.assertEqual(stat.S_IMODE(dst.stat().st_mode), 0o644)
            self.assertTrue(m.sources)
            self.assertTrue(all(not p.exists() for p in m.sources))
            self.assertTrue(all(len(c.encode()) < 4096 for c in m.commands))

    def test_unicode_bytes_and_quoted_destination_are_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            m = Machine()
            scope = functions(m, d)
            text = '{"title":"引号 \' 与换行\\n <b>纯文本</b>"}\n'
            dst = Path(d) / "burst 'quoted'.json"
            scope["copy_text_to_guest"](str(dst), text)
            self.assertEqual(dst.read_bytes(), text.encode("utf-8"))
            self.assertEqual(stat.S_IMODE(dst.stat().st_mode), 0o644)
            self.assertTrue(all(not p.exists() for p in m.sources))

    def test_copy_error_removes_the_host_temp_and_never_reports_success(self):
        with tempfile.TemporaryDirectory() as d:
            m = Machine(fail_copy=True)
            scope = functions(m, d)
            dst = Path(d) / "burst.json"
            with self.assertRaisesRegex(OSError, "copy failed"):
                scope["copy_text_to_guest"](str(dst), "payload")
            self.assertFalse(dst.exists())
            self.assertTrue(m.sources)
            self.assertTrue(all(not p.exists() for p in m.sources))
            self.assertEqual(m.commands, [])


if __name__ == "__main__":
    unittest.main()
