"""greetd's bounded retry and the VT1 notice when it gives up (os/modules/agentos.nix, agentos-greeter-fallback):
the reason is logged, the last greeter lines are shown, and Enter starts the login screen again."""
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unit_path  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NIX = (ROOT / "os/modules/agentos.nix").read_text()

FAKES = {
    "systemctl": r"""#!/usr/bin/env bash
echo "systemctl $*" >> "$T/calls"
case "$*" in
  "show -p Result --value greetd.service") echo start-limit-hit ;;
  "show -p NRestarts --value greetd.service") echo 5 ;;
esac
""",
    "journalctl": '#!/usr/bin/env bash\necho "journalctl $*" >> "$T/calls"\necho "cage: unable to create renderer"\necho "greeter ended rc=1"\n',
    "logger": '#!/usr/bin/env bash\nshift 2; echo "$*" >> "$T/log"\n',
}


def script():
    body = NIX.split('greeterFallback = pkgs.writeShellScript "agentos-greeter-fallback" \'\'', 1)[1].split("\n  '';", 1)[0]
    body = textwrap.dedent(body).replace("''${", "${")
    rest = unit_path.EXPORT.sub("", body)
    assert "${lib" not in rest and "${pkgs" not in rest, "unexpected Nix interpolation in the fallback script"
    return body


def greetd_block():
    return NIX.split("    greetd = lib.mkIf cfg.graphical {", 1)[1].split("\n    };", 1)[0]


class GreeterFallbackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        (self.t / "bin").mkdir()
        for name, text in FAKES.items():
            unit_path.write_fake(self.t / "bin", name, text)
        (self.t / "fallback.sh").write_text(unit_path.confine(script(), self.t / "bin", self.t / "real", self.t / "missing"))

    def tearDown(self):
        self.tmp.cleanup()

    def run_fallback(self, typed):
        env = dict(os.environ, T=str(self.t), HOST_PATH=os.environ["PATH"])
        p = subprocess.run(["bash", str(self.t / "fallback.sh")], input=typed, capture_output=True, text=True, env=env, timeout=60)
        read = lambda n: (self.t / n).read_text() if (self.t / n).exists() else ""
        self.assertEqual(read("missing"), "", "commands the unit's PATH does not provide")
        return p, read("calls"), read("log")

    def test_greetd_retries_a_bounded_number_of_times_then_hands_over(self):
        g = greetd_block()
        self.assertIn('serviceConfig.Restart = lib.mkForce "always";', g)
        self.assertRegex(g, r"serviceConfig\.RestartSec = [1-9]\d*;")
        self.assertRegex(g, r"unitConfig\.StartLimitBurst = [1-9]\d*;")
        self.assertRegex(g, r"unitConfig\.StartLimitIntervalSec = [1-9]\d*;")
        self.assertIn('unitConfig.OnFailure = [ "agentos-greeter-fallback.service" ];', g)

    def test_gave_up_logs_the_reason_shows_the_greeter_output_and_retries_on_enter(self):
        p, calls, log = self.run_fallback("\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("login screen gave up: greetd result=start-limit-hit restarts=5", log)
        self.assertIn("cage: unable to create renderer", p.stdout)
        self.assertTrue(p.stdout.startswith("\033c"), p.stdout)            # the VT was cleared first
        self.assertIn("Press Enter", p.stdout)
        self.assertTrue(p.stdout.isascii(), p.stdout)          # the Linux VT font has no CJK glyphs
        self.assertIn("-t agentos-greeter", calls)
        self.assertLess(calls.index("systemctl reset-failed greetd.service"), calls.index("systemctl --no-block start greetd.service"))
        self.assertIn("starting the login screen again", log)


if __name__ == "__main__":
    unittest.main()
