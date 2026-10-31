"""Regression for normal encrypted reboots: a log message is not the guest-ready handshake."""
import ast
from pathlib import Path
import socket
import textwrap
import time
import unittest


def unlocker():
    source = Path(__file__).with_name("m6-qcow2.nix")
    script = source.read_text().split("testScript = ''", 1)[1].rsplit("'';", 1)[0]
    tree = ast.parse(textwrap.dedent(script))
    function = next(x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name == "unlock_existing")
    scope = {"_t": time}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), scope)
    return scope["unlock_existing"]


class Guest:
    def __init__(self, ready=False):
        self.shell, self.peer = socket.socketpair()
        self.connected = False
        self.typed = []
        if ready:
            self.peer.sendall(b"guest ready")

    def send_console(self, text):
        self.typed.append(text)
        self.peer.sendall(b"guest ready")

    def connect(self):
        assert self.shell.recv(64) == b"guest ready"
        self.connected = True

    def close(self):
        self.shell.close()
        self.peer.close()


class BootConsoleTest(unittest.TestCase):
    def test_ready_guest_without_the_optional_password_log_gets_no_password(self):
        guest = Guest(ready=True)
        try:
            unlocker()(guest, "test-pass", timeout=2)
            self.assertTrue(guest.connected)
            self.assertEqual(guest.typed, [])
        finally:
            guest.close()

    def test_waiting_guest_is_answered_then_the_real_handshake_is_consumed(self):
        guest = Guest()
        try:
            unlocker()(guest, "test-pass", timeout=3)
            self.assertTrue(guest.connected)
            self.assertEqual(guest.typed, ["test-pass\n"])
        finally:
            guest.close()

    def test_not_ready_is_not_success(self):
        guest = Guest()
        try:
            with self.assertRaisesRegex(Exception, "did not unlock and boot"):
                unlocker()(guest, "test-pass", timeout=0)
            self.assertFalse(guest.connected)
        finally:
            guest.close()


if __name__ == "__main__":
    unittest.main()
