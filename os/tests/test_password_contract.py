"""Run the production initial-password branch with harmless ask-password and cryptsetup adapters."""
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
LAYOUT = (ROOT / "os/modules/disk-layout.nix").read_text()
BRANCH = LAYOUT.split("        valid_account_password() {", 1)[1].split("\n      else\n", 1)[0]
BRANCH = "valid_account_password() {" + textwrap.dedent(BRANCH).replace("''${", "${")


class PasswordContractTest(unittest.TestCase):
    def test_password_boundaries_before_any_luks_mutation(self):
        cases = [("safe:password", False), ("x" * 511, True), ("x" * 512, True), ("x" * 513, False),
                 ("界" * 170 + "ab", True), ("界" * 171, False), ("safe\npassword", False)]
        for password, accepted in cases:
            with self.subTest(bytes=len(password.encode()), accepted=accepted), tempfile.TemporaryDirectory() as td:
                script = '''set -e
handoff=0; real=faux; key=faux; f="$T/key"
systemd-ask-password() { printf '%s' "$PASSWORD"; }
cryptsetup() { printf '%s\\n' "$1" >> "$T/crypto"; }
''' + BRANCH
                result = subprocess.run(["bash", "-c", script], env=dict(os.environ, T=td, PASSWORD=password), capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
                crypto = Path(td, "crypto")
                self.assertEqual(crypto.exists(), accepted)
                if accepted:
                    self.assertEqual(Path(td, "key").read_bytes(), password.encode())
                    self.assertEqual(crypto.read_text().splitlines(), ["config", "luksAddKey"])
                self.assertNotIn(password, result.stdout + result.stderr)
