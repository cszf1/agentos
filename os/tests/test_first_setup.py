"""The console first-boot script (os/modules/agentos.nix, agentos-first-setup) against a fake agentosctl: an
attempt interrupted after install.ensure comes back, a closed first boot never shows the entry again, the VT only
ever gets ASCII, a problem stays on screen until Enter, and a resumed attempt offers the login name typed before."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unit_path  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NIX = (ROOT / "os/modules/agentos.nix").read_text()
DIR_RS = (ROOT / "native/crates/machine/src/dir.rs").read_text()
CLEAR = "\033c"   # what the script prints to clear the VT
MARKER = re.search(r'pub const FIRST_BOOT_CLOSED: &str = "([^"]+)";', DIR_RS).group(1)

FAKE_CTL = r"""#!/usr/bin/env bash
echo "$*" >> "$T/calls"
case "$1" in
  status) if [ -e "$T/status" ]; then cat "$T/status"; else echo "agentosctl: MIGRATION_REQUIRED: machine is not installed" >&2; exit 1; fi ;;
  firstboot)
    cat > "$T/password"
    bytes=$(wc -c < "$T/password")
    if [ "$bytes" -eq 0 ] || [ "$bytes" -gt 512 ] || grep -q ':' "$T/password"; then
      echo "agentosctl: INVALID_REQUEST: unsupported password" >&2; exit 1
    fi
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
    rest = unit_path.EXPORT.sub("", body)
    assert "${lib" not in rest and "${pkgs" not in rest, "unexpected Nix interpolation in the setup script"
    return (body.replace("/var/lib/agentos-machine", str(machine_dir)).replace("/var/lib/agentos-first-setup", str(setup_dir))
            .replace("/run/agentos-first-setup", str(setup_dir.parent / "run")))


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
                           "logger": '#!/usr/bin/env bash\nshift 2; echo "$*" >> "$T/log"\n'}.items():
            unit_path.write_fake(bin_, name, text)
        (self.t / "setup").mkdir()
        (self.t / "run").mkdir(mode=0o700)
        body = script(self.t / "machine", self.t / "setup")
        (self.t / "setup.sh").write_text(unit_path.confine(body, bin_, self.t / "real", self.t / "missing"))

    def tearDown(self):
        self.tmp.cleanup()

    def run_setup(self, typed=""):
        env = dict(os.environ, T=str(self.t), HOST_PATH=os.environ["PATH"])
        p = subprocess.run(["bash", str(self.t / "setup.sh")], input=typed, capture_output=True, text=True, env=env, timeout=30)
        read = lambda n: (self.t / n).read_text() if (self.t / n).exists() else ""
        self.assertEqual(read("missing"), "", "commands the unit's PATH does not provide")
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

    def test_vm_checks_wait_for_prompts_the_console_prints(self):
        # m5-desktop, m20-sway and lib.answer_first_boot type into tty1 after wait_until_tty_matches(...); m19-iso after an OCR wait_screen.
        # A reworded prompt must fail here, not after a KVM run times out.
        p, _, _ = self.run_setup("bea\npw-2\npw-2\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        for check in ("m5-desktop.py", "m20-sway.py", "lib.py"):      # lib.py: answer_first_boot (m21, m22)
            text = (ROOT / "os/tests" / check).read_text()
            text = text.split("def answer_first_boot", 1)[1] if check == "lib.py" else text.split("first-boot-closed", 1)[0]
            waits = re.findall(r'wait_until_tty_matches\("1", "([^"]+)"', text)
            self.assertEqual(len(waits), 4, (check, waits))
            for w in waits:
                self.assertRegex(p.stdout, w, check)
        waits = re.findall(r'wait_screen\((?:target|dest), r?"(\(\?i\)[^"]*(?:login|password|workspace)[^"]*)"',
                           (ROOT / "os/tests/m19-iso.py").read_text())
        self.assertEqual(len(waits), 8, waits)
        for w in waits:
            self.assertRegex(p.stdout, w)

    def test_quick_start_uses_the_handed_over_password_and_asks_nothing(self):
        # VM images: the disk re-key asked for one password and left it in /run; first setup creates "admin" with it
        (self.t / "run/password").write_text("quick-pw-1")
        p, calls, log = self.run_setup("")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("Administrator login", p.stdout)
        self.assertNotIn("Password", p.stdout)
        self.assertIn("firstboot --admin admin --workspace \u6211\u7684\u5de5\u4f5c\u533a", calls)
        self.assertEqual((self.t / "password").read_text(), "quick-pw-1")
        self.assertFalse((self.t / "run/password").exists(), "the handed-over password was not removed")
        self.assertIn("quick start", log)
        self.assertNotIn("quick-pw-1", p.stdout + log)
        self.assertTrue(p.stdout.isascii(), p.stdout)

    def test_quick_start_never_truncates_overlong_passwords(self):
        original = "x" * 513
        (self.t / "run/password").write_text(original)
        p, calls, log = self.run_setup("\nbea\npw-2\npw-2\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("Quick setup failed", p.stdout)
        self.assertIn("firstboot --admin bea", calls)
        self.assertNotIn(original, p.stdout + log)
        self.assertFalse((self.t / "run/password").exists())

    def test_quick_start_preserves_512_bytes(self):
        original = "界" * 170 + "ab"
        self.assertEqual(len(original.encode()), 512)
        (self.t / "run/password").write_text(original)
        p, calls, log = self.run_setup("")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual((self.t / "password").read_text(), original)
        self.assertNotIn(original, p.stdout + log)

    def test_quick_start_refused_falls_back_to_the_console_and_drops_the_password(self):
        (self.t / "run/password").write_text("quick-pw-1")
        (self.t / "status").write_text(status("open"))
        (self.t / "refuse-once").write_text("agentosctl: CONFLICT: something\n")
        p, calls, log = self.run_setup("\nbea\npw-2\npw-2\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse((self.t / "run/password").exists())
        self.assertIn("Quick setup failed", p.stdout)
        self.assertIn("Administrator login", p.stdout)
        self.assertIn("firstboot --admin bea --workspace Home", calls)
        self.assertEqual((self.t / "password").read_text(), "pw-2")

    def test_quick_start_on_a_closed_machine_still_drops_the_password(self):
        (self.t / "run/password").write_text("quick-pw-1")
        (self.t / f"machine/{MARKER}").write_text("closed\n")
        p, calls, _ = self.run_setup("")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(calls, "")
        self.assertFalse((self.t / "run/password").exists())

    def test_disk_rekey_hands_the_password_over_only_on_graphical_systems(self):
        layout = (ROOT / "os/modules/disk-layout.nix").read_text()
        self.assertEqual(len(re.findall(r'(?:> |cp "\$f" )/run/agentos-first-setup/password', layout)), 2)   # fresh template and resumed re-key
        self.assertIn("[ -e /etc/agentos/first-setup-handoff ]", layout)
        self.assertIn('environment.etc."agentos/first-setup-handoff" = lib.mkIf cfg.graphical', NIX)

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
        rounds = p.stdout.split(CLEAR)[1:]
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
        first, second = p.stdout.split(CLEAR)[1:]
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
