"""m20's D12 disk scan must pass only on a clean, fully read disk: a marker anywhere fails, a scan error fails as an
error with its stderr in the log, and the document portal is read by alice instead of breaking root's scan."""
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

DRIVER = Path(__file__).with_name("m20-sway.py")
SUBTEST = "the real Shell after the e2e"
MARKER = "SECRET-DRAFT-42917"
UID = "10000"
PORTAL = f"/run/user/{UID}/doc"

# mountinfo as on the VM after alice's login: her runtime tmpfs, her document portal (FUSE, no allow_other) and the
# greeter's portal, which is outside the scanned paths.
MOUNTINFO = textwrap.dedent(f"""\
    24 1 253:1 / / rw,relatime shared:1 - ext4 /dev/vda rw
    517 26 0:72 / /run/user/{UID} rw,nosuid,nodev,relatime shared:276 - tmpfs tmpfs rw,size=401812k,mode=700,uid={UID},gid=100
    533 517 0:75 / {PORTAL} rw,nosuid,nodev,relatime shared:284 - fuse.portal portal rw,user_id={UID},group_id=100
    402 26 0:66 / /run/user/999/doc rw,nosuid,nodev,relatime shared:220 - fuse.portal portal rw,user_id=999,group_id=999
""")

# A model of runuser, not the real one: the portal is a mode-0000 directory that only "alice" can open, as root
# cannot open alice's FUSE mount. Unprivileged here, so everything else keeps its own permissions for both users.
FAKE_RUNUSER = textwrap.dedent('''\
    #!{python}
    import os, subprocess, sys
    a = sys.argv[1:]
    if os.environ.get("FAKE_RUNUSER_FAIL"):
        sys.exit("runuser: user alice does not exist or the user entry does not contain all the required fields")
    assert a[:3] == ["-u", "alice", "--"], a
    doc = os.environ["FAKE_PORTAL"]
    os.chmod(doc, 0o755)
    try:
        sys.exit(subprocess.call(a[3:]))
    finally:
        os.chmod(doc, 0)
''')


def driver(path=DRIVER):
    """D12's statements (after the clipboard check) and every module-level definition they reach."""
    tree = ast.parse(path.read_text())
    body = next(n.body for n in ast.walk(tree) if isinstance(n, ast.With) and isinstance(n.items[0].context_expr, ast.Call)
                and isinstance(n.items[0].context_expr.args[0], ast.Constant)
                and str(n.items[0].context_expr.args[0].value).startswith(SUBTEST))
    clip = next(i for i, n in enumerate(body) if isinstance(n, ast.Assert) and "clip" in ast.unparse(n))
    tail = body[clip + 1:]
    defs = {}
    for n in tree.body:
        if isinstance(n, ast.FunctionDef):
            defs[n.name] = n
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    defs[t.id] = n
    used, todo = [], [x.id for s in tail for x in ast.walk(s) if isinstance(x, ast.Name)]
    while todo:
        name = todo.pop()
        if name in defs and defs[name] not in used:
            used.append(defs[name])
            todo += [x.id for x in ast.walk(defs[name]) if isinstance(x, ast.Name)]
    used.sort(key=lambda n: n.lineno)
    return compile(ast.Module(body=used + tail, type_ignores=[]), DRIVER.name, "exec")


class FakeMachine:
    """machine.execute/succeed/copy_from_host on this host, with the guest paths under a temp root and mapped back in
    stdout, so output names guest paths as on the VM. Like the NixOS driver, only stdout is returned."""
    GUEST = re.compile(r"/home/alice|/var/lib/agentos(?![\w-])|/run/user/|/proc/self/mountinfo|/tmp/agentos-")

    def __init__(self, root, env):
        self.root, self.env = root, env

    def path(self, s):
        return self.GUEST.sub(lambda m: str(self.root) + {"/proc/self/mountinfo": "/mountinfo"}.get(m.group(0), m.group(0)), s)

    def execute(self, cmd):
        p = subprocess.run(["bash", "-c", self.path(cmd)], stdout=subprocess.PIPE, text=True, env=self.env)
        return p.returncode, p.stdout.replace(str(self.root), "")

    def succeed(self, cmd):
        rc, out = self.execute(cmd)
        assert rc == 0, f"command failed ({rc}): {cmd}"
        return out

    def copy_from_host(self, src, dst):
        shutil.copyfile(src, self.path(dst))


@unittest.skipIf(os.geteuid() == 0, "models root's EACCES on alice's portal with file modes, which root ignores")
class M20DiskScanTest(unittest.TestCase):
    code = driver()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="agentos-d12-")
        r = self.root = Path(self.tmp.name)
        for d in ["bin", "tmp", "home/alice/.config/agentos", "var/lib/agentos/db", f"run/user/{UID}/systemd", "run/user/999"]:
            (r / d).mkdir(parents=True)
        (r / "home/alice/.config/agentos/shell.json").write_text('{"layout": "default"}')
        (r / "var/lib/agentos/db/os.sqlite").write_bytes(b"SQLite format 3\0" + b"\0" * 5000 + b"records")
        (r / f"run/user/{UID}/agentos-session.state").write_text("ready")
        (r / f"run/user/{UID}/doc/by-app").mkdir(parents=True)
        (r / f"run/user/{UID}/doc/by-app/notes.txt").write_text("portal document")
        (r / "mountinfo").write_text(MOUNTINFO)
        fake = r / "bin" / "runuser"
        fake.write_text(FAKE_RUNUSER.format(python=sys.executable))
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.portal = r / f"run/user/{UID}/doc"
        self.env = {**os.environ, "PATH": f"{r / 'bin'}:{os.environ['PATH']}", "FAKE_PORTAL": str(self.portal)}

    def tearDown(self):
        for p in self.root.rglob("*"):
            if not p.is_symlink():
                p.chmod(0o755 if p.is_dir() else 0o644)
        self.tmp.cleanup()

    def d12(self, env=None):
        """Run D12 with the portal closed to root; returns (AssertionError or None, the log)."""
        self.portal.chmod(0)
        ns = {"machine": FakeMachine(self.root, {**self.env, **(env or {})}), "marker": MARKER, "alice_uid": UID,
              "json": json, "os": os, "re": re, "shlex": shlex, "tempfile": tempfile}
        log = io.StringIO()
        try:
            with contextlib.redirect_stdout(log):
                exec(self.code, ns)
        except AssertionError as e:
            return e, log.getvalue()
        finally:
            self.portal.chmod(0o755)
        return None, log.getvalue()

    def test_clean_disk_with_the_portal_mounted_passes(self):
        err, log = self.d12()
        self.assertIsNone(err, log)
        self.assertIn(PORTAL, log)

    def test_marker_anywhere_in_scope_fails_as_on_disk_and_names_the_file(self):
        for rel in ["home/alice/.cache/draft.txt", "var/lib/agentos/db/wal.bin", f"run/user/{UID}/shell-draft",
                    f"run/user/{UID}/doc/by-app/draft.txt"]:
            with self.subTest(rel):
                f = self.root / rel
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(b"\0prefix " + MARKER.encode() + b" suffix\0")
                try:
                    err, log = self.d12()
                finally:
                    f.unlink()
                self.assertIsNotNone(err, log)
                self.assertIn("on disk", str(err))
                self.assertIn(rel, str(err))

    def test_marker_split_across_read_chunks_is_found(self):
        f = self.root / "var/lib/agentos/db/big.bin"
        f.write_bytes(b"x" * ((1 << 20) - 5) + MARKER.encode())
        err, log = self.d12()
        self.assertIsNotNone(err, log)
        self.assertIn("big.bin", str(err))

    def test_unreadable_file_for_root_fails_as_a_scan_error_not_as_clean_or_on_disk(self):
        f = self.root / "var/lib/agentos/db/locked.bin"
        f.write_text("x")
        f.chmod(0)
        err, log = self.d12()
        self.assertIsNotNone(err, log)
        self.assertNotIn("on disk", str(err))
        self.assertIn("scan failed", str(err))
        self.assertIn("locked.bin: Permission denied", str(err))

    def test_alice_permission_error_inside_the_portal_is_reported(self):
        f = self.portal / "by-app" / "sealed.txt"
        f.write_text("x")
        f.chmod(0)
        err, log = self.d12()
        self.assertIsNotNone(err, log)
        self.assertIn("scan failed", str(err))
        self.assertIn("alice", str(err))
        self.assertIn("sealed.txt: Permission denied", str(err))

    def test_marker_and_an_error_together_still_fail_and_name_the_file(self):
        (self.root / "home/alice/draft").write_text(MARKER)
        locked = self.root / "var/lib/agentos/db/locked.bin"
        locked.write_text("x")
        locked.chmod(0)
        err, log = self.d12()
        self.assertIsNotNone(err, log)
        self.assertIn("home/alice/draft", str(err))
        self.assertIn("locked.bin: Permission denied", log)

    def test_scan_command_failure_is_an_error_and_its_stderr_is_logged(self):
        err, log = self.d12({"FAKE_RUNUSER_FAIL": "1"})
        self.assertIsNotNone(err, log)
        self.assertNotIn("on disk", str(err))
        self.assertIn("does not exist", str(err))
        self.assertIn("does not exist", log)

    def test_missing_scan_root_is_an_error(self):
        shutil.rmtree(self.root / "var/lib/agentos")
        err, log = self.d12()
        self.assertIsNotNone(err, log)
        self.assertIn("scan failed", str(err))
        self.assertIn("No such file or directory", str(err))


if __name__ == "__main__":
    unittest.main(verbosity=2)
