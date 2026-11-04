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
        (self.t / "dri").mkdir()
        body = script()
        loop = "for c in /dev/dri/card*;"
        self.assertEqual(body.count(loop), 1, body)
        (self.t / "fallback.sh").write_text(unit_path.confine(body.replace(loop, f"for c in {self.t}/dri/card*;"), self.t / "bin", self.t / "real", self.t / "missing"))

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
        # a DRM card exists, so greetd ran its greeter and retried it: the notice reports how often
        (self.t / "dri" / "card0").touch()
        p, calls, log = self.run_fallback("\n")
        self.assertIn("(greetd: start-limit-hit, 5 restarts)", p.stdout)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("login screen gave up: greetd result=start-limit-hit restarts=5", log)
        self.assertIn("cage: unable to create renderer", p.stdout)
        self.assertTrue(p.stdout.startswith("\033c"), p.stdout)            # the VT was cleared first
        self.assertIn("Press Enter", p.stdout)
        self.assertTrue(p.stdout.isascii(), p.stdout)          # the Linux VT font has no CJK glyphs
        self.assertIn("-t agentos-greeter", calls)
        self.assertLess(calls.index("systemctl reset-failed greetd.service"), calls.index("systemctl --no-block start greetd.service"))
        self.assertIn("starting the login screen again", log)

    def test_no_display_device_says_so_and_claims_no_retries(self):
        # greetd's ExecCondition found no card and started the notice at once: nothing was retried
        p, calls, log = self.run_fallback("\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("login screen not started: no display device (/dev/dri/card*)", log)
        self.assertNotIn("gave up", log)
        self.assertIn("no display device was found (/dev/dri/card*)", p.stdout)
        self.assertNotIn("restart", p.stdout.split("Last messages")[0])
        self.assertNotIn("NRestarts", calls)
        self.assertTrue(p.stdout.startswith("\033c"), p.stdout)
        self.assertTrue(p.stdout.isascii(), p.stdout)
        self.assertLess(calls.index("systemctl reset-failed greetd.service"), calls.index("systemctl --no-block start greetd.service"))


def kms_script():
    body = NIX.split('greeterNeedsKms = pkgs.writeShellScript "agentos-greeter-kms" \'\'', 1)[1].split("\n  '';", 1)[0]
    return textwrap.dedent(body).replace("''${", "${")


class GreeterVtTest(unittest.TestCase):
    def test_greetd_never_switches_the_console_to_vt1(self):
        # a crashing greeter's retries must not pull a tty2 user back to VT1 (m22 crash subtest checks it in a VM)
        self.assertIn("services.greetd.settings.terminal.switch = lib.mkIf cfg.graphical false;", NIX)


class GreeterKmsGateTest(unittest.TestCase):
    """greetd switches to VT1 for every greeter it starts; without a DRM card it must not start at all (m21 41894778781:
    the retries kept pulling the console off the tty2 text login)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        (self.t / "bin").mkdir()
        (self.t / "dri").mkdir()
        unit_path.write_fake(self.t / "bin", "logger", '#!/usr/bin/env bash\nshift 2; echo "$*" >> "$T/log"\n')
        unit_path.write_fake(self.t / "bin", "systemctl", '#!/usr/bin/env bash\necho "systemctl $*" >> "$T/calls"\n')
        # each sleep is counted; CARD_AFTER=k makes udev "add" card0 during the k-th wait
        unit_path.write_fake(self.t / "bin", "sleep", '#!/usr/bin/env bash\necho x >> "$T/sleeps"\n'
                             '[ -n "$CARD_AFTER" ] && [ $(wc -l < "$T/sleeps") -ge "$CARD_AFTER" ] && touch "$T/dri/card0"\nexit 0\n')
        body = kms_script()
        self.assertEqual(body.count("/dev/dri/card*"), 2, body)
        loop = "for c in /dev/dri/card*;"
        self.assertEqual(body.count(loop), 1, body)
        (self.t / "kms.sh").write_text(unit_path.confine(body.replace(loop, f"for c in {self.t}/dri/card*;"), self.t / "bin", self.t / "real", self.t / "missing"))

    def tearDown(self):
        self.tmp.cleanup()

    def run_gate(self, **env):
        e = {**os.environ, "T": str(self.t), "HOST_PATH": os.environ["PATH"], "CARD_AFTER": "", **env}
        p = subprocess.run(["bash", str(self.t / "kms.sh")], capture_output=True, text=True, env=e, timeout=60)
        read = lambda n: (self.t / n).read_text() if (self.t / n).exists() else ""
        self.assertEqual(read("missing"), "", "commands the unit's PATH does not provide")
        self.calls = read("calls")
        return p.returncode, read("log"), read("sleeps").count("x")

    def test_is_greetds_exec_condition_as_root(self):
        # ExecCondition, not ExecStartPre: a skipped condition is never restarted (Restart=always included), it is
        # not a failure, and greetd's main process (the VT1 switch) never runs
        g = greetd_block()
        self.assertIn('serviceConfig.ExecCondition = "+${greeterNeedsKms}";', g)
        self.assertIn('serviceConfig.ExecStartPre = [ "+${greeterDefaults}" ];', g)
        self.assertNotIn("greeterNeedsKms}\" \"", g)

    def test_no_card_skips_after_cages_wait_says_why_and_shows_the_notice(self):
        rc, log, sleeps = self.run_gate()
        self.assertEqual(rc, 1)                           # 1..254: ExecCondition skips the unit
        self.assertEqual(self.calls, "systemctl --no-block start agentos-greeter-fallback.service\n")
        self.assertEqual(sleeps, 20)                      # 20 x 0.5 s: as long as Cage waits for a KMS device
        self.assertIn("no display device (/dev/dri/card*)", log)
        self.assertIn("VT1 was not taken", log)

    def test_card_present_or_added_late_lets_greetd_start(self):
        (self.t / "dri" / "card0").touch()
        self.assertEqual(self.run_gate()[:2], (0, ""))
        self.assertEqual(self.calls, "")
        (self.t / "dri" / "card0").unlink()
        rc, log, sleeps = self.run_gate(CARD_AFTER="3")
        self.assertEqual((rc, log, sleeps, self.calls), (0, "", 3, ""))


if __name__ == "__main__":
    unittest.main()
