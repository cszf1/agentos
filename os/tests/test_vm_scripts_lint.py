"""VM test scripts: no bare pipe into `grep -q` (EPIPE under the driver's pipefail), and no undefined name in the
script the driver really runs (each .nix testScript: its string parts and readFile'd files, in that order)."""
import re
import shutil
import subprocess
import tempfile
import textwrap
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
    def test_m23_powercut_marker_targets_kernel_log_with_console_priority(self):
        source = (HERE / "m23-quickstart.nix").read_text()
        start = re.search(r'pkgs.writeShellScript "powercut-before-admin-once"\s*', source)
        self.assertIsNotNone(start)
        script, _ = nix_string(source, start.end())
        marker = "agentos-test: rekey complete, admin setup held"
        lines = [line.strip() for line in script.splitlines() if marker in line]
        self.assertEqual(len(lines), 1)
        self.assertIn("> /dev/kmsg", lines[0])
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "kmsg"
            subprocess.run(["sh", "-eu", "-c", lines[0].replace("/dev/kmsg", str(target))], check=True)
            self.assertEqual(target.read_text(), "<2>" + marker + "\n")
        self.assertIn('wait_console(m, "' + marker + '", timeout=300)', source)

    def test_no_bare_grep_q_after_a_pipe(self):
        bad = offenders()
        self.assertEqual(bad, [], "`cmd | grep -q P` fails under pipefail when grep exits at its first match and cmd "
                         "still writes (EPIPE). Use log_has(cmd, pattern) from lib.py, or "
                         "`cmd | tee -p /dev/null | grep -q P`:\n" + "\n".join(bad))

    def test_the_lint_catches_the_pattern(self):
        self.assertTrue(BARE.search("dmesg | grep -q x") and not DRAINED.search("dmesg | grep -q x"))
        self.assertTrue(DRAINED.search("dmesg | tee -p /dev/null | grep -Eqx x"))


# globals the NixOS test driver gives the script (test-driver test_symbols), besides one name per node
DRIVER = {"start_all", "test_script", "machines", "vlans", "driver", "log", "os", "create_machine", "subtest",
          "run_tests", "join_all", "retry", "serial_stdout_off", "serial_stdout_on", "polling_condition", "Machine", "t"}


def _interp_end(src, j):
    depth, j = 1, j + 2
    while depth:
        depth += {"{": 1, "}": -1}.get(src[j], 0)
        j += 1
    return j


def nix_string(src, i):
    """The nix string at src[i] ("..." or two-quote indented), with each ${...} as `x`; returns (text, end)."""
    out = []
    if src.startswith(IND, i):
        j = i + 2
        while True:
            if src.startswith(IND + "'", j):
                out.append(IND); j += 3
            elif src.startswith(IND + "$", j) or src.startswith(IND + "\\", j):
                out.append(src[j + 2]); j += 3
            elif src.startswith(IND, j):
                return textwrap.dedent("".join(out).lstrip("\n")), j + 2
            elif src.startswith("${", j):
                out.append("x"); j = _interp_end(src, j)
            else:
                out.append(src[j]); j += 1
    j = i + 1
    while src[j] != '"':
        if src[j] == "\\":
            out.append({"n": "\n", "t": "\t"}.get(src[j + 1], src[j + 1])); j += 2
        elif src.startswith("${", j):
            out.append("x"); j = _interp_end(src, j)
        else:
            out.append(src[j]); j += 1
    return "".join(out), j + 1


IND = "'" * 2
READFILE = re.compile(r"builtins\.readFile\s+\./([\w.-]+)")


def assembled_script(nix, files=None):
    """The testScript a .nix file assembles, string parts and readFile'd files in order; None when it has none.
    `files` maps a file name to replacement text (to lint an older version of one file)."""
    src = nix.read_text()
    m = re.search(r"^\s*testScript\s*=\s*", src, re.M)
    if not m:
        return None
    i, parts = m.end(), []
    while True:
        while src[i] in " \t\n+":
            i += 1
        if src[i] == ";":
            return "".join(parts)
        if src[i] == '"' or src.startswith(IND, i):
            text, i = nix_string(src, i)
            parts.append(text)
            continue
        r = READFILE.match(src, i)
        assert r, f"{nix.name}: cannot read the testScript at {src[i:i + 60]!r}"
        name = r.group(1)
        parts.append((files or {}).get(name) or (nix.parent / name).read_text())
        i = r.end()


def node_names(nix):
    src = nix.read_text()
    return set(re.findall(r"\bnodes\.(\w+)", src)) | set(re.findall(r"^\s*(\w+)\s*=\s*node\s*;", src, re.M))


def undefined_names(nix, script):
    pyflakes = shutil.which("pyflakes")
    assert pyflakes, "pyflakes is not on PATH (CI: pipx install pyflakes; nix: nix shell nixpkgs#python3Packages.pyflakes)"
    with tempfile.NamedTemporaryFile("w", suffix=".py") as f:
        f.write(script)
        f.flush()
        res = subprocess.run([pyflakes, f.name], capture_output=True, text=True)
    assert "syntax" not in res.stderr.lower() and "invalid" not in res.stderr.lower(), f"{nix.name}: {res.stderr}"
    known = DRIVER | node_names(nix)
    bad = []
    for line in res.stdout.splitlines():
        m = re.search(r":(\d+):(?:\d+:?)? undefined name '(\w+)'", line)
        if m and m.group(2) not in known:
            src = script.splitlines()[int(m.group(1)) - 1].strip()
            bad.append(f"{nix.name}: assembled line {m.group(1)}: undefined name {m.group(2)!r}: {src}")
    return bad


class VmScriptNamesTest(unittest.TestCase):
    def test_every_assembled_test_script_defines_its_names(self):
        bad, n = [], 0
        for nix in sorted(HERE.glob("*.nix")):
            script = assembled_script(nix)
            if script is not None:
                n += 1
                bad += undefined_names(nix, script)
        self.assertGreaterEqual(n, 20)
        self.assertEqual(bad, [], "a VM script uses a name nothing defines (pyflakes over the assembled testScript; "
                         "a NameError there only shows in the VM run):\n" + "\n".join(bad))

    def test_the_names_lint_sees_lib_first_and_catches_a_missing_import(self):
        nix = HERE / "m16-fetch.nix"
        script = assembled_script(nix)
        self.assertLess(script.index("def log_has"), script.index("U06:"))     # lib.py first, as the builder does
        without = (HERE / "m16-fetch.py").read_text().replace("\nimport re\n", "\n", 1)
        bad = undefined_names(nix, assembled_script(nix, {"m16-fetch.py": without}))
        self.assertTrue(bad and all("'re'" in b for b in bad), bad)
        self.assertEqual(undefined_names(nix, "PNG = 1\nmachine.succeed('x')\nsubtest\n"), [])
        self.assertEqual(len(undefined_names(nix, "nope(1)\n")), 1)


if __name__ == "__main__":
    unittest.main()
