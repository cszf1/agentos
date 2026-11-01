"""The standalone release has no test agent: use real screen OCR, bounded by elapsed time."""
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
from types import SimpleNamespace
import unittest
from unittest import mock
from pnm import pnm_rgb


class Clock:
    now = 0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def helpers(clock):
    source = Path(__file__).with_name("m19-iso.py")
    tree = ast.parse(source.read_text())
    functions = [x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name in ("wait_screen", "keyed", "wait_console")]
    scope = {"time": clock, "re": re, "json": json, "screen_text": lambda m: m.get_screen_text_variants()}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), scope)
    return scope["wait_screen"], scope["keyed"], scope["wait_console"]


def ocr_function(runner):
    source = Path(__file__).with_name("m19-iso.py")
    fn = next(x for x in ast.parse(source.read_text()).body if isinstance(x, ast.FunctionDef) and x.name == "screen_text")
    scope = {"os": os, "subprocess": SimpleNamespace(run=runner, CalledProcessError=subprocess.CalledProcessError),
             "PNGTOPNM": "pngtopnm", "pnm_rgb": pnm_rgb}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), scope)
    return scope["screen_text"]


class Screen:
    process = None

    def __init__(self, clock, variants, cost=0):
        self.clock, self.variants, self.cost = clock, variants, cost
        self.calls = 0

    def get_screen_text_variants(self):
        self.calls += 1
        self.clock.now += self.cost
        return self.variants


class ScreenWaitTest(unittest.TestCase):
    def test_match_in_any_actual_ocr_variant(self):
        clock = Clock()
        screen = Screen(clock, ["unrelated", "administrator login:"])
        with contextlib.redirect_stdout(io.StringIO()):
            helpers(clock)[0](screen, "administrator login", timeout=5)
        self.assertEqual(screen.calls, 1)

    def test_operator_error_fails_immediately_instead_of_waiting_twenty_minutes(self):
        clock = Clock()
        screen = Screen(clock, ["AssertionError\nAOS-DRILL-FAILED\nstack trace"], cost=4)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(AssertionError, "operator failed.*AOS-TRIAL-ARMED"):
            helpers(clock)[0](screen, "AOS-TRIAL-ARMED", timeout=1200, failure_regex=r"(?m)^AOS-DRILL-FAILED\s*$")
        self.assertEqual(screen.calls, 1)
        self.assertEqual(clock.now, 4)

    def test_operator_error_beats_a_success_match_in_another_ocr_variant(self):
        clock = Clock()
        screen = Screen(clock, ["AOS-TRIAL-ARMED", "AOS-DRILL-FAILED"])
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(AssertionError, "operator failed"):
            helpers(clock)[0](screen, "AOS-TRIAL-ARMED", timeout=5, failure_regex=r"(?m)^AOS-DRILL-FAILED\s*$")
        self.assertEqual(screen.calls, 1)

    def test_expensive_ocr_counts_against_the_deadline(self):
        clock = Clock()
        screen = Screen(clock, ["Please enter passphrase"], cost=4)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(AssertionError, "last OCR.*passphrase"):
            helpers(clock)[0](screen, "administrator login", timeout=5)
        self.assertEqual(clock.now, 5)
        self.assertEqual(screen.calls, 1)

    def test_no_match_cannot_be_success(self):
        clock = Clock()
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(AssertionError, "did not show"):
            helpers(clock)[0](Screen(clock, ["login:"]), "administrator login", timeout=3)
        self.assertEqual(clock.now, 3)

    def test_console_backlog_does_not_cost_one_second_per_old_line(self):
        clock = Clock()
        class Console:
            process = None
            def get_console_log(self):
                return "boot output\n" * 10000 + "__install_RC=0__"
        log = helpers(clock)[2](Console(), "__install_RC=0__", timeout=1)
        self.assertTrue(log.endswith("__install_RC=0__"))
        self.assertEqual(clock.now, 0)

    def test_console_old_receipt_cannot_satisfy_a_new_command(self):
        clock = Clock()
        old = "__inspect_RC=0__"
        class Console:
            process = None
            def get_console_log(self):
                return old
        with self.assertRaisesRegex(AssertionError, "console never showed"):
            helpers(clock)[2](Console(), "__inspect_RC=0__", timeout=1, start=len(old))
        self.assertGreaterEqual(clock.now, 1)

    def test_secret_typing_keeps_identical_keys_and_waits_for_release(self):
        class Keyboard:
            def __init__(self):
                self.sent = []

            def send_key(self, key, delay):
                self.sent.append((key, delay))

        keyboard = Keyboard()
        helpers(Clock())[1](keyboard, "battery A-\n")
        self.assertEqual([key for key, _ in keyboard.sent], ["b", "a", "t", "t", "e", "r", "y", "spc", "shift-a", "minus", "ret"])
        self.assertTrue(all(delay > 0.1 for _, delay in keyboard.sent))


class OcrPipelineTest(unittest.TestCase):
    machine = SimpleNamespace(out_dir="/unused", screenshot=lambda _: None)

    def test_uniform_boot_frame_is_not_ready_and_does_not_trim(self):
        calls = []
        def run(cmd, **kwargs):
            calls.append(cmd)
            return SimpleNamespace(stdout=b"P6\n2 1\n255\n" + bytes([17, 23, 29]) * 2)
        with mock.patch("shutil.which", return_value="magick"):
            self.assertEqual(ocr_function(run)(self.machine), [""] * 6)
        self.assertEqual([c[0] for c in calls], ["pngtopnm"])

    def test_minimal_magick_only_reads_pnm_and_writes_8bit_pgm(self):
        calls = []
        raw = b"P5\n2 1\n255\n\x00\xff"
        def run(cmd, **kwargs):
            calls.append(cmd)
            if cmd[0] == "pngtopnm":
                return SimpleNamespace(stdout=raw)
            if cmd[0] == "magick":
                if "-negate" in cmd:
                    self.assertIn("neg.pgm", cmd[-1])
                else:
                    self.assertIn("pnm:-", cmd)
                    self.assertIn("-sample", cmd)
                    self.assertIn("300%", cmd)
                    self.assertEqual(cmd[-3:-1], ["-depth", "8"])
                    self.assertTrue(cmd[-1].endswith("zoom.pgm"))
                    self.assertEqual(kwargs["input"], raw)
                return SimpleNamespace(stdout=b"")
            self.assertEqual(cmd[0], "tesseract")
            return SimpleNamespace(stdout="administrator login:")
        with mock.patch("shutil.which", return_value="magick"):
            self.assertEqual(ocr_function(run)(self.machine), ["administrator login:"] * 6)
        self.assertEqual(len(calls), 9)

    def test_conversion_failure_keeps_stderr_and_is_not_readiness(self):
        def run(cmd, **kwargs):
            raise subprocess.CalledProcessError(1, cmd, stderr=b"codec unavailable")
        with mock.patch("shutil.which", return_value="magick"), self.assertRaisesRegex(RuntimeError, "OCR command failed:.*codec unavailable"):
            ocr_function(run)(self.machine)


if __name__ == "__main__":
    unittest.main()
