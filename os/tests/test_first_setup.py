"""The console first-boot script (os/modules/agentos.nix, agentos-first-setup) against a fake agentosctl: an
attempt interrupted after install.ensure comes back, a closed first boot never shows the entry again, the VT only
ever gets ASCII, a problem stays on screen until Enter, and a resumed attempt offers the login name typed before."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
NIX = (ROOT / "os/modules/agentos.nix").read_text()
DIR_RS = (ROOT / "native/crates/machine/src/dir.rs").read_text()
MARKER = re.search(r'pub const FIRST_BOOT_CLOSED: &str = "([^"]+)";', DIR_RS).group(1)

FAKE_CTL = r"""#!/usr/bin/env bash
echo "$*" >> "$T/calls"
case "$1" in
  status) if [ -e "$T/status" ]; then cat "$T/status"; else echo "agentosctl: MIGRATION_REQUIRED: machine is not installed" >&2; exit 1; fi ;;
  firstboot)
    cat > "$T/password"
    if [ -e "$T/provision-then-refuse" ]; then   # the account was created, then the attempt broke off
      sed -i 's/"users": 0/"users": 1/' "$T/status"; rm "$T/provision-then-refuse"
      echo "agentosctl: CONFLICT: provisioningId reused with a different request" >&2; exit 1
    fi
    if [ -e "$T/refuse-once" ]; then cat "$T/refuse-once" >&2; rm "$T/refuse-once"; exit 1; fi
    if [ -e "$T/refuse" ]; then cat "$T/refuse" >&2; exit 1; fi
    : > "$T/machine/MARKER"; echo '{"firstBoot": "closed"}' ;;
esac
"""


def script(machine_dir, setup_dir):
    body = NIX.split('firstSetup = pkgs.writeShellScript "agentos-first-setup" \'\'', 1)[1].split("\n  '';", 1)[0]
    body = textwrap.dedent(body).replace("''${", "${")
    body = re.sub(r"export PATH=\$\{lib\.makeBinPath \[[^]]*\]\}", 'export PATH="$FAKEBIN:$PATH"', body)
    assert "${lib" not in body and "${pkgs" not in body, "unexpected Nix interpolation in the setup script"
    return body.replace("/var/lib/agentos-machine", str(machine_dir)).replace("/var/lib/agentos-first-setup", str(setup_dir))


def status(state, users=0):
    # agentosctl prints serde_json pretty output
    return ('{\n  "machine": {\n    "meta": {\n      "firstBootState": "%s",\n      "machineInstallId": "m"\n    },\n'
            '    "users": %d\n  }\n}\n' % (state, users))


class FirstSetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        (self.t / "machine").mkdir()
        bin_ = self.t / "bin"
        bin_.mkdir()
        for name, text in {"agentosctl": FAKE_CTL.replace("MARKER", MARKER),
                           "logger": '#!/usr/bin/env bash\nshift 2; echo "$*" >> "$T/log"\n',
                           "clear": "#!/bin/sh\necho '<CLEAR>'\n"}.items():
            (bin_ / name).write_text(text)
            (bin_ / name).chmod(0o755)
        (self.t / "setup").mkdir()
        (self.t / "setup.sh").write_text(script(self.t / "machine", self.t / "setup"))

    def tearDown(self):
        self.tmp.cleanup()

    def run_setup(self, typed=""):
        env = dict(os.environ, T=str(self.t), FAKEBIN=str(self.t / "bin"))
        p = subprocess.run(["bash", str(self.t / "setup.sh")], input=typed, capture_output=True, text=True, env=env, timeout=30)
        read = lambda n: (self.t / n).read_text() if (self.t / n).exists() else ""
        return p, read("calls"), read("log")

    def test_unit_condition_is_the_marker_machined_writes(self):
        self.assertIn(f'ConditionPathExists = "!/var/lib/agentos-machine/{MARKER}";', NIX)
        self.assertNotIn('ConditionPathExists = "!/var/lib/agentos-machine/machine.secret"', NIX)

    def test_attempt_interrupted_after_ensure_is_offered_again_and_completes(self):
        (self.t / "machine/machine.secret").write_text("s")
        (self.t / "status").write_text(status("open"))
        p, calls, log = self.run_setup("alice\npw-1\npw-1\nHome\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("Administrator login", p.stdout)
        self.assertIn("firstboot --admin alice --workspace Home", calls)
        self.assertEqual((self.t / "password").read_text(), "pw-1")
        self.assertIn("did not finish; resuming", log)
        self.assertIn("first boot completed for administrator alice", log)

    def test_fresh_machine_asks_for_the_administrator(self):
        p, calls, _ = self.run_setup("bea\npw-2\npw-2\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("firstboot --admin bea --workspace Home", calls)

    def test_closed_marker_never_shows_the_entry(self):
        (self.t / "machine/machine.secret").write_text("s")
        (self.t / f"machine/{MARKER}").write_text("closed\n")
        (self.t / "status").write_text(status("open"))
        p, calls, _ = self.run_setup("mallory\nx\nx\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("Administrator login", p.stdout)
        self.assertEqual(calls, "")

    def test_closed_state_without_marker_never_shows_the_entry(self):
        (self.t / "machine/machine.secret").write_text("s")
        (self.t / "status").write_text(status("closed"))
        p, calls, log = self.run_setup("mallory\nx\nx\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("Administrator login", p.stdout)
        self.assertNotIn("firstboot", calls)
        self.assertIn("not waiting for first boot", log)

    def test_already_closed_refusal_ends_the_prompt(self):
        (self.t / "status").write_text(status("open"))
        (self.t / "refuse").write_text("agentosctl: first boot is already closed on this machine\n")
        p, calls, log = self.run_setup("alice\npw-1\npw-1\nHome\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(calls.count("firstboot"), 1)
        self.assertIn("first boot is already closed", log)

    def test_console_text_is_ascii(self):
        # the Linux VT font has no CJK glyphs: anything else shows as boxes
        body = NIX.split('firstSetup = pkgs.writeShellScript "agentos-first-setup" \'\'', 1)[1].split("\n  '';", 1)[0]
        self.assertTrue(body.isascii(), [l for l in body.splitlines() if not l.isascii()])
        (self.t / "refuse-once").write_text("agentosctl: \u5931\u8d25 CONFLICT \u2192 x\n")
        (self.t / "status").write_text(status("open"))
        p, _, _ = self.run_setup("Bad Name\n\nalice\npw-1\npw-2\n\nalice\npw-1\npw-1\nHome\n\nalice\npw-1\npw-1\nHome\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(p.stdout.isascii(), p.stdout)
        self.assertIn("Setup failed: agentosctl: ", p.stdout)
        self.assertIn("CONFLICT", p.stdout)

    def test_problems_stay_until_enter_then_the_screen_clears(self):
        self.assertNotRegex(NIX.split('firstSetup = pkgs.writeShellScript', 1)[1].split("\n  '';", 1)[0], r"sleep [35]")
        p, calls, _ = self.run_setup("Bad Name\n\nbea\npw-1\npw-2\n\nbea\npw-2\npw-2\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        rounds = p.stdout.split("<CLEAR>")[1:]
        self.assertEqual(len(rounds), 3, p.stdout)
        self.assertIn("may only use lowercase letters", rounds[0])
        self.assertTrue(rounds[0].rstrip().endswith("Press Enter to try again."), rounds[0])
        self.assertIn("did not match", rounds[1])
        self.assertTrue(rounds[1].rstrip().endswith("Press Enter to try again."), rounds[1])
        self.assertNotIn("did not match", rounds[2])
        self.assertEqual(calls.count("firstboot --admin bea --workspace Home"), 1)
        self.assertEqual((self.t / "password").read_text(), "pw-2")

    def test_resumed_attempt_offers_the_login_name_but_never_the_password(self):
        (self.t / "machine/machine.secret").write_text("s")
        (self.t / "status").write_text(status("open"))
        (self.t / "provision-then-refuse").write_text("")
        p, calls, log = self.run_setup("alice\nsecret-pw-1\nsecret-pw-1\nHome\n\n\nsecret-pw-2\nsecret-pw-2\nHome\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        first, second = p.stdout.split("<CLEAR>")[1:]
        self.assertIn("Administrator login: ", first)
        self.assertIn("CONFLICT", first)
        self.assertIn('already created the administrator account "alice"', second)
        self.assertIn("Administrator login [alice]: ", second)
        self.assertEqual(calls.count("firstboot --admin alice --workspace Home"), 2)
        self.assertEqual((self.t / "password").read_text(), "secret-pw-2")
        self.assertNotIn("secret-pw", p.stdout + log + (self.t / "setup/admin-login").read_text())

    def test_console_restarted_after_an_interrupt_offers_the_earlier_login(self):
        (self.t / "machine/machine.secret").write_text("s")
        (self.t / "setup/admin-login").write_text("alice\n")
        (self.t / "status").write_text(status("open", users=1))
        p, calls, _ = self.run_setup("\npw-3\npw-3\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("Administrator login [alice]: ", p.stdout)
        self.assertIn("firstboot --admin alice --workspace Home", calls)

    def test_remembered_name_without_an_account_is_not_offered(self):
        (self.t / "machine/machine.secret").write_text("s")
        (self.t / "setup/admin-login").write_text("alice\n")
        (self.t / "status").write_text(status("open", users=0))
        p, calls, _ = self.run_setup("bea\npw-1\npw-1\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("alice", p.stdout)
        self.assertIn("firstboot --admin bea --workspace Home", calls)


if __name__ == "__main__":
    unittest.main()
