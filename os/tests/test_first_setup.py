"""The console first-boot script (os/modules/agentos.nix, agentos-first-setup) against a fake agentosctl: an
attempt interrupted after install.ensure comes back, a closed first boot never shows the entry again."""
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
    if [ -e "$T/refuse" ]; then cat "$T/refuse" >&2; exit 1; fi
    : > "$T/machine/MARKER"; echo '{"firstBoot": "closed"}' ;;
esac
"""


def script(machine_dir):
    body = NIX.split('firstSetup = pkgs.writeShellScript "agentos-first-setup" \'\'', 1)[1].split("\n  '';", 1)[0]
    body = textwrap.dedent(body).replace("''${", "${")
    body = re.sub(r"export PATH=\$\{lib\.makeBinPath \[[^]]*\]\}", 'export PATH="$FAKEBIN:$PATH"', body)
    assert "${lib" not in body and "${pkgs" not in body, "unexpected Nix interpolation in the setup script"
    return body.replace("/var/lib/agentos-machine", str(machine_dir))


def status(state):
    # agentosctl prints serde_json pretty output
    return '{\n  "meta": {\n    "firstBootState": "%s",\n    "machineInstallId": "m"\n  }\n}\n' % state


class FirstSetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        (self.t / "machine").mkdir()
        bin_ = self.t / "bin"
        bin_.mkdir()
        for name, text in {"agentosctl": FAKE_CTL.replace("MARKER", MARKER),
                           "logger": '#!/usr/bin/env bash\nshift 2; echo "$*" >> "$T/log"\n',
                           "clear": "#!/bin/sh\n"}.items():
            (bin_ / name).write_text(text)
            (bin_ / name).chmod(0o755)
        (self.t / "setup.sh").write_text(script(self.t / "machine"))

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
        self.assertIn("administrator login", p.stdout)
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
        self.assertNotIn("administrator login", p.stdout)
        self.assertEqual(calls, "")

    def test_closed_state_without_marker_never_shows_the_entry(self):
        (self.t / "machine/machine.secret").write_text("s")
        (self.t / "status").write_text(status("closed"))
        p, calls, log = self.run_setup("mallory\nx\nx\n\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("administrator login", p.stdout)
        self.assertNotIn("firstboot", calls)
        self.assertIn("not waiting for first boot", log)

    def test_already_closed_refusal_ends_the_prompt(self):
        (self.t / "status").write_text(status("open"))
        (self.t / "refuse").write_text("agentosctl: first boot is already closed on this machine\n")
        p, calls, log = self.run_setup("alice\npw-1\npw-1\nHome\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(calls.count("firstboot"), 1)
        self.assertIn("first boot is already closed", log)


if __name__ == "__main__":
    unittest.main()
