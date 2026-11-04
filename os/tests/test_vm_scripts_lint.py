"""VM test scripts must not pipe into a bare `grep -q` (EPIPE under the driver's pipefail)."""
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
BARE = re.compile(r"\|\s*grep\s+-[A-Za-z]*q")
DRAINED = re.compile(r"\|\s*tee -p /dev/null\s*\|\s*grep\s+-[A-Za-z]*q")


def offenders():
    out = []
    for f in sorted(HERE.glob("*.py")):
        if f.name.startswith("test_"):
            continue
        for i, line in enumerate(f.read_text().splitlines(), 1):
            if len(BARE.findall(line)) > len(DRAINED.findall(line)):
                out.append(f"{f.name}:{i}: {line.strip()}")
    return out


class VmScriptsLintTest(unittest.TestCase):
    def test_no_bare_grep_q_after_a_pipe(self):
        bad = offenders()
        self.assertEqual(bad, [], "`cmd | grep -q P` fails under pipefail when grep exits at its first match and cmd "
                         "still writes (EPIPE). Use log_has(cmd, pattern) from lib.py, or "
                         "`cmd | tee -p /dev/null | grep -q P`:\n" + "\n".join(bad))

    def test_the_lint_catches_the_pattern(self):
        self.assertTrue(BARE.search("dmesg | grep -q x") and not DRAINED.search("dmesg | grep -q x"))
        self.assertTrue(DRAINED.search("dmesg | tee -p /dev/null | grep -Eqx x"))


if __name__ == "__main__":
    unittest.main()
