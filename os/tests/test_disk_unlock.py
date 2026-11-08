"""Run the production initrd provider and completed-rekey script with harmless device adapters."""
import os
import re
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
LAYOUT = (ROOT / "os/modules/disk-layout.nix").read_text()
UNLOCK = (ROOT / "os/modules/disk-unlock.sh").read_text()
REKEY = textwrap.dedent(LAYOUT.split("    script = ''", 1)[1].split("\n    '';", 1)[0]).replace("''${", "${")
ADAPTERS = r'''
findmnt() { printf '%s\n' "$RAM_TYPE"; }
systemd-ask-password() { echo request >> "$T/requests"; cat "$T/answer"; }
cryptsetup() {
  printf '%s\n' "$*" >> "$T/argv"
  if [ "$1" = luksDump ]; then echo "Label:          ${LUKS_LABEL-agentos-luks}"; return; fi
  local key=""
  for arg in "$@"; do case "$arg" in --key-file=*) key=${arg#--key-file=} ;; esac; done
  if [ "$key" = "$T/etc/agentos-template-disk.key" ] || [ "$key" = "$T/etc/agentos/template-disk.key" ]; then
    [ -e "$T/template" ]; return
  fi
  cmp -s "$key" "$T/expected"
}
'''


class DiskUnlockTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        for name in ("run", "etc/agentos", "var/lib/agentos-machine", "dev/disk/by-partlabel"):
            (self.t / name).mkdir(parents=True)
        (self.t / "dev/disk/by-partlabel/agentos-luks").touch()
        (self.t / "etc/agentos-template-disk.key").write_text("public-template")
        (self.t / "etc/agentos/template-disk.key").write_text("public-template")
        (self.t / "etc/agentos-first-setup-handoff").touch()
        (self.t / "etc/agentos/first-setup-handoff").touch()
        self.password = b"faux-recovery-password"
        (self.t / "expected").write_bytes(self.password)
        (self.t / "answer").write_bytes(self.password + b"\n")

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, script, ram_type="tmpfs", label="agentos-luks"):
        for prefix in ("/run/", "/etc/", "/var/lib/", "/dev/disk/"):
            script = script.replace(prefix, str(self.t) + prefix)
        result = subprocess.run(["bash", "-c", ADAPTERS + script], capture_output=True,
                                env=dict(os.environ, T=str(self.t), RAM_TYPE=ram_type, LUKS_LABEL=label), timeout=10)
        exposed = result.stdout + result.stderr
        if (self.t / "argv").exists():
            exposed += (self.t / "argv").read_bytes()
        self.assertNotIn(self.password, exposed)
        return result

    def test_provider_counts_utf8_bytes_and_allows_colons_before_key_writes(self):
        cases = [(b"x" * 511, True), (("界" * 170 + ":").encode(), True), (b"faux:password:", True),
                 (b"x" * 512, False), (("界" * 170 + ":a").encode(), False)]
        for password, accepted in cases:
            with self.subTest(size=len(password), accepted=accepted):
                (self.t / "expected").write_bytes(password)
                (self.t / "answer").write_bytes(password + b"\n")
                result = self.run_script(UNLOCK)
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
                key = self.t / "run/agentos-disk-unlock/key"
                self.assertEqual(key.exists(), accepted)
                if accepted:
                    self.assertEqual(key.read_bytes(), password)
                self.assertNotIn(password, result.stdout + result.stderr)

    def test_post_rekey_boot_preserves_the_single_verified_entry_for_setup(self):
        result = self.run_script(UNLOCK)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.t / "requests").read_text().splitlines(), ["request"])
        handoff = self.t / "run/agentos-first-setup/password"
        key = self.t / "run/agentos-disk-unlock/key"
        self.assertEqual(handoff.read_bytes(), self.password)
        self.assertEqual(handoff.stat().st_mode & 0o777, 0o600)
        self.assertEqual(handoff.parent.stat().st_mode & 0o777, 0o700)
        result = self.run_script("set -e\n" + REKEY)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(key.exists())
        self.assertEqual(handoff.read_bytes(), self.password)
        self.assertEqual((self.t / "requests").read_text().splitlines(), ["request"])

    def test_installed_disk_without_label_unlocks_but_hands_nothing_to_first_setup(self):
        # the installer's disks carry no LUKS label: their administrator is set up on the console
        result = self.run_script(UNLOCK, label="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.t / "run/agentos-disk-unlock/key").read_bytes(), self.password)
        self.assertFalse((self.t / "run/agentos-first-setup/password").exists())

    def test_interrupted_rekey_label_hands_off(self):
        result = self.run_script(UNLOCK, label="agentos-rekey-pending")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.t / "run/agentos-first-setup/password").read_bytes(), self.password)

    def test_pending_rekey_reuses_the_verified_initrd_password_without_another_prompt(self):
        self.assertEqual(self.run_script(UNLOCK).returncode, 0)
        branch = REKEY.split('echo "agentos: the first-boot disk re-key was interrupted; enter the disk passphrase to finish it"', 1)[1]
        branch = branch.split('\nfi\nif [ "$(cryptsetup luksDump', 1)[0]
        setup = 'set -e; real=faux; f="$T/pending-key"; unlock=/run/agentos-disk-unlock/key\n'
        validator = re.search(r"valid_account_password\(\) \{.*?\n\s*\}", REKEY, re.S).group()
        result = self.run_script(validator + "\n" + setup + branch)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.t / "pending-key").read_bytes(), self.password)
        self.assertEqual((self.t / "requests").read_text().splitlines(), ["request"])
        self.assertEqual((self.t / "run/agentos-first-setup/password").read_bytes(), self.password)

    def test_nongraphical_unlock_never_creates_an_account_handoff(self):
        (self.t / "etc/agentos-first-setup-handoff").unlink()
        self.assertEqual(self.run_script(UNLOCK).returncode, 0)
        self.assertFalse((self.t / "run/agentos-first-setup/password").exists())

    def test_closed_setup_removes_both_volatile_password_files(self):
        self.assertEqual(self.run_script(UNLOCK).returncode, 0)
        (self.t / "var/lib/agentos-machine/first-boot-closed").touch()
        self.assertEqual(self.run_script("set -e\n" + REKEY).returncode, 0)
        self.assertFalse((self.t / "run/agentos-first-setup/password").exists())
        self.assertFalse((self.t / "run/agentos-disk-unlock/key").exists())

    def test_public_template_key_never_becomes_the_account_password(self):
        (self.t / "template").touch()
        self.assertEqual(self.run_script(UNLOCK).returncode, 0)
        self.assertFalse((self.t / "requests").exists())
        self.assertEqual((self.t / "run/agentos-disk-unlock/key").read_text(), "public-template")
        self.assertFalse((self.t / "run/agentos-first-setup/password").exists())

    def test_rejected_answers_never_survive_the_provider(self):
        (self.t / "answer").write_bytes(b"faux-wrong-password\n")
        self.assertNotEqual(self.run_script(UNLOCK).returncode, 0)
        self.assertEqual(len((self.t / "requests").read_text().splitlines()), 5)
        self.assertFalse((self.t / "run/agentos-disk-unlock/key").exists())
        self.assertFalse((self.t / "run/agentos-first-setup/password").exists())

    def test_rekey_refuses_non_ram_runtime_before_password_custody(self):
        result = self.run_script("set -e\n" + REKEY, ram_type="ext4")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.t / "requests").exists())
        self.assertFalse((self.t / "run/agentos-first-setup/password").exists())

    def test_non_ram_runtime_is_refused_before_any_secret_is_written(self):
        self.assertNotEqual(self.run_script(UNLOCK, ram_type="ext4").returncode, 0)
        self.assertFalse((self.t / "requests").exists())
        self.assertFalse((self.t / "run/agentos-disk-unlock/key").exists())
