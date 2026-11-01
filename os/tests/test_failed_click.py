"""A missed real click must retain the live Wayland frame before Qt unwinds the client."""
import ast
import contextlib
import io
import json
from pathlib import Path
import unittest


def handler(capture):
    source = Path(__file__).with_name("m20-sway.py")
    fn = next(x for x in ast.parse(source.read_text()).body if isinstance(x, ast.FunctionDef) and x.name == "handle")
    machine = object()
    scope = {"json": json, "machine": machine, "log_failure_screen": capture}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), scope)
    return machine, scope["handle"]


class FailedClickTest(unittest.TestCase):
    def test_capture_live_frame_and_target_diagnostics_without_synthesizing_input(self):
        captured = []
        machine, run = handler(lambda *args: captured.append(args))
        args = {"kind": "failed-click", "objectName": "confirmReject", "targetAlive": True, "x": 450, "nowY": 520}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(run(1, args), {})
        self.assertEqual(captured, [(machine, "sway-live-failed-click")])
        self.assertIn('"objectName": "confirmReject"', out.getvalue())
        self.assertEqual(args["kind"], "failed-click")

    def test_capture_failure_is_not_reported_as_success(self):
        def failed(*_):
            raise RuntimeError("PNG capture failed")
        _, run = handler(failed)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "PNG capture failed"):
            run(1, {"kind": "failed-click", "targetAlive": False})


if __name__ == "__main__":
    unittest.main()
