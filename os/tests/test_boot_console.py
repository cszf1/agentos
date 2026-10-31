"""Encrypted reboots require the complete guest handshake, not readable firmware output or an optional log."""
import ast
from pathlib import Path
import socket
import textwrap
import time
import unittest

MARKER = b"Spawning backdoor root shell..."


def unlocker():
    source = Path(__file__).with_name("m6-qcow2.nix")
    script = source.read_text().split("testScript = ''", 1)[1].rsplit("'';", 1)[0]
    tree = ast.parse(textwrap.dedent(script))
    function = next(x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name == "unlock_existing")
    scope = {"_t": time}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), scope)
    return scope["unlock_existing"]


class Guest:
    def __init__(self, ready=False, preamble=b"", fragment=False):
        self.shell, self.peer = socket.socketpair()
        self.connected = False
        self.typed = []
        self.fragment = fragment
        self.ask = not ready
        if preamble:
            self.peer.sendall(preamble)
        if ready:
            self.peer.sendall(MARKER[:12] if fragment else MARKER)

    def get_console_log(self):
        if self.fragment:
            self.peer.sendall(MARKER[12:])
            self.fragment = False
        return "Please enter passphrase for disk: Starting password query on /dev/ttyS0.\n" if self.ask else ""

    def send_console(self, text):
        self.typed.append(text)
        self.ask = False
        self.peer.sendall(MARKER)

    def connect(self):
        assert self.shell.recv(1024) == MARKER
        self.connected = True

    def close(self):
        self.shell.close()
        self.peer.close()


class BootConsoleTest(unittest.TestCase):
    def check_guest(self, guest, typed):
        try:
            unlocker()(guest, "test-pass", timeout=3)
            self.assertTrue(guest.connected)
            self.assertEqual(guest.typed, typed)
        finally:
            guest.close()

    def test_ready_guest_without_the_optional_password_log_gets_no_password(self):
        self.check_guest(Guest(ready=True), [])

    def test_waiting_guest_is_answered_then_the_real_handshake_is_consumed(self):
        self.check_guest(Guest(), ["test-pass\n"])

    def test_uefi_output_is_not_a_guest_ready_handshake(self):
        self.check_guest(Guest(preamble=b"UEFI Boot in 5s.\r\n"), ["test-pass\n"])

    def test_partial_handshake_is_preserved_and_gets_no_password(self):
        self.check_guest(Guest(ready=True, preamble=b"firmware\r\n", fragment=True), [])

    def test_large_firmware_preamble_does_not_hide_the_handshake(self):
        self.check_guest(Guest(ready=True, preamble=b"x" * 80000), [])

    def test_closed_channel_is_not_success(self):
        guest = Guest()
        guest.peer.close()
        try:
            with self.assertRaisesRegex(Exception, "channel closed"):
                unlocker()(guest, "test-pass", timeout=2)
            self.assertFalse(guest.connected)
            self.assertEqual(guest.typed, [])
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
