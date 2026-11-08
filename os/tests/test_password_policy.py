"""Cross-language contract agreement and real encrypted-container boundary checks."""
import io
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from test_initialization import module

ROOT = Path(__file__).resolve().parents[2]


class PasswordPolicyTest(unittest.TestCase):
    def test_all_validation_constants_agree_on_511_bytes(self):
        sites = {
            "native/crates/machine/src/sys.rs": r"MAX_PASSWORD_BYTES: usize = (\d+)",
            "os/installer/agentos-install.py": r"MAX_PASSWORD_BYTES = (\d+)",
            "desktop/app/shell_controller.cpp": r"password.toUtf8\(\).size\(\) <= (\d+)",
            "os/modules/disk-unlock.sh": r'wc -c\)" -le (\d+)',
            "os/modules/disk-layout.nix": r'wc -c\)" -le (\d+)',
        }
        for path, pattern in sites.items():
            with self.subTest(path=path):
                self.assertEqual(re.findall(pattern, (ROOT / path).read_text()), ["511"])
        gateway = (ROOT / "native/crates/session-gateway/src/pam.rs").read_text()
        self.assertIn("agentos_machine::sys::validate_password(password)", gateway)
        qml = (ROOT / "desktop/qml/TrustedConfirm.qml").read_text() + (ROOT / "desktop/qml/WorkspacesPage.qml").read_text()
        self.assertEqual(qml.count(".passwordValid("), 2)
        self.assertNotIn("colon and newline are not supported", (ROOT / "os/modules/disk-layout.nix").read_text())

    def test_installer_accepts_colons_and_exact_511_bytes_and_rejects_512(self):
        m = module()
        for value in [b"faux:password:", b"x" * 511, ("界" * 170 + ":").encode()]:
            m.validate_password(value)
        for value in [b"x" * 512, ("界" * 170 + ":a").encode(), b"faux\0password", b"faux\npassword"]:
            with self.subTest(size=len(value)):
                m.load = lambda: {"state": "confirmed", "plan": {}}
                m.recheck = mock.Mock()
                m.sh = mock.Mock()
                with mock.patch.object(m.sys, "stdin", mock.Mock(buffer=io.BytesIO(value))):
                    with self.assertRaisesRegex(m.Refuse, "511"):
                        m.cmd_run({"--passphrase-stdin": True})
                m.recheck.assert_not_called()
                m.sh.assert_not_called()

    @unittest.skipUnless(shutil.which("cryptsetup"), "cryptsetup is required")
    def test_real_luks_unlock_preserves_colons_and_exact_511_byte_values(self):
        for password in [b"faux:colon:password:", b"x" * 510 + b":", ("界" * 170 + ":").encode()]:
            with self.subTest(size=len(password)), tempfile.TemporaryDirectory() as root:
                image = Path(root) / "encrypted"
                with image.open("wb") as stream:
                    stream.truncate(32 * 1024**2)
                def call(args, value=password):
                    return subprocess.run(["cryptsetup", *args, str(image)], input=value, capture_output=True, timeout=30)
                result = call(["luksFormat", "--type", "luks2", "--batch-mode", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file=-"])
                self.assertEqual(result.returncode, 0, "LUKS initialization failed")
                self.assertEqual(call(["open", "--test-passphrase", "--key-file=-"]).returncode, 0)
                self.assertNotEqual(call(["open", "--test-passphrase", "--key-file=-"], password[:-1]).returncode, 0)
                self.assertNotIn(password, result.stdout + result.stderr)
