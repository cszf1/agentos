"""Exercise the actual m23 unlock helper with deterministic console reads."""
import ast
from pathlib import Path
import re
import unittest
from unittest import mock

from test_vm_scripts_lint import assembled_script


class Clock:
    now = 0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Console:
    shell = object()

    def __init__(self, clock, chunks):
        self.clock, self.chunks, self.sent = clock, chunks, []

    @property
    def connected(self):
        return bool(self.sent) and self.clock.now >= 0.8

    def get_console_log(self):
        return "".join(chunk for at, chunk in self.chunks if at <= self.clock.now)

    def send_console(self, text):
        self.sent.append(text)


class ConsoleRequestsTest(unittest.TestCase):
    banner = "Starting password query on /dev/ttyS0"
    prompt = "Please enter passphrase for disk AgentOS:"

    def run_helper(self, chunks, expected):
        source = Path(__file__).with_name("m23-quickstart.nix")
        tree = ast.parse(assembled_script(source))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "unlock_existing")
        clock = Clock()
        machine = Console(clock, chunks)
        namespace = {"re": re, "_t": clock}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
        with mock.patch("select.select", return_value=([], [], [])):
            count = namespace["unlock_existing"](machine, "test-only", timeout=1)
        self.assertEqual(count, expected)
        self.assertEqual(machine.sent, ["test-only\n"] * expected)

    def test_separate_banner_and_prompt_are_one_request(self):
        self.run_helper([(0, self.banner), (0.2, "\n" + self.prompt)], 1)

    def test_prompt_split_at_every_character_is_not_lost(self):
        for split in range(1, len(self.prompt)):
            with self.subTest(split=split):
                self.run_helper([(0, self.prompt[:split]), (0.2, self.prompt[split:])], 1)

    def test_coalesced_banner_and_prompt_are_one_request(self):
        self.run_helper([(0, self.banner + "\n" + self.prompt)], 1)

    def test_actual_prompt_can_arrive_before_its_banner(self):
        self.run_helper([(0, self.prompt), (0.2, "\n" + self.banner)], 1)

    def test_banner_alone_can_answer_a_prompt_without_newline(self):
        self.run_helper([(0, self.banner)], 1)

    def test_two_requests_remain_two_entries(self):
        self.run_helper([(0, self.banner + "\n" + self.prompt), (0.2, "\n" + self.banner + "\n" + self.prompt)], 2)
