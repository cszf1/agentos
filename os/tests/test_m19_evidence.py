"""m19's installed-disk evidence must fail on a command error and must prove the Shell ran, from the disk."""
import ast
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

JOURNAL = "/ev/var/log/journal"
SUBTEST = "evidence from the installed disk"

# Fakes, not the real tools. journalctl reads "IDENT<TAB>MESSAGE" lines from <-D dir>/entries and prints MESSAGE
# (-o cat), filtered by -t; a missing directory is an error, as for the real one. logger appends such a line;
# pgrep -c prints FAKE_PGREP and exits 1 when it is 0.
FAKES = {
    "journalctl": textwrap.dedent('''\
        #!{python}
        import os, sys
        a = sys.argv[1:]
        d = a[a.index("-D") + 1]
        if not os.path.isdir(d):
            sys.exit(f"Failed to open journal directory {{d}}: No such file or directory")
        if "--list-boots" in a:
            print(open(os.path.join(d, "boots")).read(), end=""); sys.exit(0)
        ident = a[a.index("-t") + 1] if "-t" in a else None
        for line in open(os.path.join(d, "entries")):
            i, m = line.rstrip("\\n").split("\\t", 1)
            if ident in (None, i): print(m)
    '''),
    "logger": textwrap.dedent('''\
        #!{python}
        import os, sys
        a = sys.argv[1:]
        open(os.path.join(os.environ["FAKE_JOURNAL"], "entries"), "a").write(a[a.index("-t") + 1] + "\\t" + a[-1] + "\\n")
    '''),
    "pgrep": textwrap.dedent('''\
        #!{python}
        import os, sys
        assert sys.argv[1:] == ["-c", "-u", "alice", "-f", "bin/agentos-shell"], sys.argv
        n = os.environ["FAKE_PGREP"]; print(n); sys.exit(0 if int(n) else 1)
    '''),
}

# Message text (-o cat) of the alice session from the m20 41314773240 console journal, the same AgentOS module: login,
# logind and the user manager, but no line from Sway, the session agent or the Shell.
SESSION_JOURNAL = [
    ("greetd", "pam_unix(greetd:session): session opened for user alice(uid=10000) by (uid=0)"),
    ("systemd-logind", "New session '7' of user 'alice' with class 'user' and type 'wayland'."),
    ("systemd", "Started Session 7 of User alice."),
    ("systemd", "Started D-Bus User Message Bus."),
    ("systemd", "Starting Portal service..."),
    ("systemd", "Started AgentOS Host for workspace 8f1e5c08-25f4-473c-aca1-40cc5b4b6e65."),
]
GOOD = {"boots": 4, "firstSetup": 1, "greetdSession": 1, "regreetLast": 1, "regreetSession": 1, "hostStarted": 4,
        "shellStarted": 1, "passwordInJournal": 0, "rootLocked": 1, "luksKeyslots": 1}


def driver():
    """The evidence pieces of m19-iso.py: module helpers, the subtest's checks, its read loop and its ev asserts."""
    tree = ast.parse(Path(__file__).with_name("m19-iso.py").read_text())
    helpers = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name.startswith("evidence_"))
               or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "SHELL_PROBE" for t in n.targets))]
    body = next(n.body for n in ast.walk(tree) if isinstance(n, ast.With) and isinstance(n.items[0].context_expr, ast.Call)
                and isinstance(n.items[0].context_expr.args[0], ast.Constant)
                and str(n.items[0].context_expr.args[0].value).startswith(SUBTEST))
    setup = [n for n in body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") in ("J", "checks")]
    loop = next(n for n in body if isinstance(n, ast.For) and getattr(n.target, "elts", None)
                and [e.id for e in n.target.elts] == ["k", "c"])
    asserts = [n for n in body if isinstance(n, ast.Assert)
               and any(isinstance(x, ast.Name) and x.id == "ev" for x in ast.walk(n))]
    mod = lambda nodes: compile(ast.Module(body=nodes, type_ignores=[]), "m19-iso.py", "exec")
    return mod(helpers), mod(setup), mod([loop]), mod(asserts)


class M19EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="agentos-m19-ev-")
        r = Path(self.root.name)
        (r / "bin").mkdir()
        for name, src in FAKES.items():
            f = r / "bin" / name
            f.write_text(src.format(python=sys.executable))
            f.chmod(f.stat().st_mode | stat.S_IXUSR)
        self.journal = r / "journal"
        self.env = {**os.environ, "PATH": f"{r / 'bin'}:{os.environ['PATH']}", "FAKE_JOURNAL": str(self.journal), "FAKE_PGREP": "1"}
        self.helpers, self.setup, self.loop, self.asserts = driver()
        self.ns = {"re": re}
        exec(self.helpers, self.ns)
        exec(self.setup, self.ns)

    def tearDown(self):
        self.root.cleanup()

    def write_journal(self, entries):
        self.journal.mkdir(exist_ok=True)
        (self.journal / "boots").write_text("".join(f"{-i} boot{i}\n" for i in range(4)))
        (self.journal / "entries").write_text("".join(f"{i}\t{m}\n" for i, m in entries))

    def bash(self, command):
        return subprocess.run(["bash", "-c", command.replace(JOURNAL, str(self.journal))], env=self.env, text=True,
                              capture_output=True)

    def run_console(self, m, cmd, tag, timeout=900):
        # The ISO's serial console echoes the typed command before its output, as in the m19 log.
        p = self.bash(f"{cmd}; echo __{tag}_RC=$?__")
        log = f"[root@nixos:~]# {cmd}; echo __{tag}_RC=$?__\n" + p.stdout + p.stderr
        return int(re.findall(f"__{tag}_RC=([0-9]+)__", log)[-1]), log

    def read(self, *keys):
        ns = {**self.ns, "run": self.run_console, "iso2": None, "ev": {},
              "checks": {k: self.ns["checks"][k] for k in keys}}
        exec(self.loop, ns)
        return ns["ev"]

    def check_ev(self, ev):
        exec(self.asserts, {"ev": ev})

    def test_a_command_error_fails_the_drill(self):
        # no journal directory on the disk: journalctl fails, grep -c still prints 0
        with self.assertRaises(AssertionError):
            print("read on a failed journalctl:", self.read("firstSetup"))

    def test_a_genuine_zero_and_a_count_are_read(self):
        self.write_journal(SESSION_JOURNAL * 4)
        self.assertEqual(self.read("passwordInJournal", "hostStarted", "boots"),
                         {"passwordInJournal": 0, "hostStarted": 4, "boots": 4})

    def test_the_session_journal_alone_does_not_show_the_shell(self):
        self.write_journal(SESSION_JOURNAL)
        self.assertEqual(self.read("shellStarted"), {"shellStarted": 0})

    def test_the_probe_records_a_running_shell_and_the_evidence_counts_it(self):
        self.write_journal(SESSION_JOURNAL)
        p = self.bash(self.ns["SHELL_PROBE"])
        self.assertEqual(p.returncode, 0, p.stderr)
        ev = self.read("shellStarted")
        self.assertEqual(ev, {"shellStarted": 1})
        self.check_ev({**GOOD, **ev})

    def test_a_probe_without_the_shell_fails_the_drill(self):
        self.write_journal(SESSION_JOURNAL)
        self.env["FAKE_PGREP"] = "0"
        self.bash(self.ns["SHELL_PROBE"])
        ev = self.read("shellStarted")
        self.assertEqual(ev, {"shellStarted": 0})
        with self.assertRaises(AssertionError):
            self.check_ev({**GOOD, **ev})


if __name__ == "__main__":
    unittest.main()
