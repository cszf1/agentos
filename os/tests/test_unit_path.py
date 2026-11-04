"""unit_path (the confined PATH the first-boot and greeter-fallback script tests run under) catches a command the
unit's own PATH does not provide, even behind 2>/dev/null, and refuses a fake that would paper over one."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unit_path  # noqa: E402


class UnitPathTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        (self.t / "bin").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_body(self, body):
        s = unit_path.confine(body, self.t / "bin", self.t / "real", self.t / "missing")
        p = subprocess.run(["bash", "-c", s], capture_output=True, text=True, env=dict(os.environ, HOST_PATH=os.environ["PATH"]), timeout=30)
        return p, (self.t / "missing").read_text() if (self.t / "missing").exists() else ""

    def test_a_hidden_missing_command_is_recorded(self):
        p, missing = self.run_body("export PATH=${lib.makeBinPath [ pkgs.systemd pkgs.coreutils pkgs.util-linux ]}\n"
                                   "clear 2>/dev/null || true\nsleep 0\necho done\n")
        self.assertEqual(p.stdout, "done\n")
        self.assertEqual(missing, "clear\n")

    def test_commands_of_the_listed_packages_resolve(self):
        p, missing = self.run_body("export PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.gnugrep ]}\necho x | tr x y | grep -q y && echo ok\n")
        self.assertEqual((p.stdout, missing), ("ok\n", ""))

    def test_a_fake_outside_the_unit_path_is_refused(self):
        unit_path.write_fake(self.t / "bin", "clear", "#!/bin/sh\n")
        with self.assertRaisesRegex(AssertionError, "clear"):
            unit_path.confine("export PATH=${lib.makeBinPath [ pkgs.coreutils ]}\n", self.t / "bin", self.t / "real", self.t / "missing")

    def test_an_unknown_package_is_refused(self):
        with self.assertRaisesRegex(AssertionError, "ncurses"):
            unit_path.packages("export PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.ncurses ]}\n")


if __name__ == "__main__":
    unittest.main()
