"""The standalone release has no test agent: use real screen OCR, bounded by elapsed time."""
import ast
import contextlib
import io
import json
from pathlib import Path
import re
import unittest


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


if __name__ == "__main__":
    unittest.main()
