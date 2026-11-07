"""agentos-install auto (the ISO installs by itself): which disks it installs to and when it stops without writing.
Offline: the installer is loaded as a module with its disk listing, plan/confirm/run and every command faked."""
import importlib.util
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SRC = Path(__file__).resolve().parents[1] / "installer" / "agentos-install.py"
GIB = 1024**3


def load():
    spec = importlib.util.spec_from_file_location("agentos_install", SRC)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def disk(path="/dev/vda", size=64 * GIB, parts=(), problems=(), byid=("virtio-A1",)):
    return {"path": path, "byId": list(byid), "model": "", "serial": "A1", "wwn": "", "majMin": "253:0", "sizeBytes": size,
            "partitionTableDigest": "sha256:x", "partitions": list(parts), "problems": list(problems)}


class AutoInstallTest(unittest.TestCase):
    def setUp(self):
        self.m = load()
        self.calls = []
        self.m.logger = lambda msg: None
        self.m.kmsg = lambda msg: self.calls.append(("kmsg", msg))
        self.m.time.sleep = lambda s: None
        self.m.cmd_plan = lambda a: self.calls.append(("plan", a)) or {"planHash": "h", "plan": {"confirmToken": "A1", "identity": self.m.identity(disk())}}
        self.m.cmd_confirm = lambda a: self.calls.append(("confirm", a)) or {"state": "confirmed"}
        self.m.cmd_run = lambda a: self.calls.append(("run", a)) or {"state": "installed", "installId": "i"}
        self.m.disk_has_data = lambda d: bool(d["partitions"])
        cmdline = tempfile.NamedTemporaryFile("w", delete=False)
        cmdline.write("init=/x console=ttyS0\n")
        cmdline.close()
        self.addCleanup(os.unlink, cmdline.name)
        self.cmdline = cmdline.name
        real_open = open
        self.m.open = lambda p, *a, **k: real_open(cmdline.name if p == "/proc/cmdline" else p, *a, **k)
        self.run_ = mock.patch.object(self.m.subprocess, "run", side_effect=lambda *a, **k: self.calls.append(("sh", a[0])) or mock.Mock(returncode=0))
        self.run_.start()
        self.addCleanup(self.run_.stop)

    def auto(self, ds, countdown=True):
        self.m.disks = lambda: ds
        self.m.countdown = lambda n: self.calls.append(("countdown", n)) or countdown
        out = io.StringIO()
        with redirect_stdout(out):
            rc = self.m.cmd_auto({"--no-reboot": True})
        return rc, out.getvalue()

    def wrote(self):
        return [c for c in self.calls if c[0] in ("plan", "confirm", "run")]

    def test_one_empty_disk_installs_quick_after_the_10_s_countdown(self):
        rc, out = self.auto([disk(), disk("/dev/sr0", problems=["install medium"])])
        self.assertEqual(rc, 0, out)
        self.assertIn(("countdown", 10), self.calls)
        plan = [c[1] for c in self.calls if c[0] == "plan"]
        self.assertEqual(plan, [{"--disk": "/dev/disk/by-id/virtio-A1", "--quick": True, "--timezone": "UTC"}])
        self.assertEqual([c[0] for c in self.wrote()], ["plan", "confirm", "run"])
        self.assertIn(("kmsg", "installed i"), self.calls)
        self.assertIn("AgentOS is installed", out)

    def test_a_key_during_the_countdown_cancels_before_anything_is_planned(self):
        rc, out = self.auto([disk()], countdown=False)
        self.assertEqual(rc, 1)
        self.assertEqual(self.wrote(), [])
        self.assertIn("Cancelled. Nothing was changed.", out)
        self.assertIn(("kmsg", "cancelled"), self.calls)

    def test_no_disk_two_disks_data_small_or_installed_stop_without_a_countdown(self):
        cases = {
            "no disk": [],
            "two disks": [disk(), disk("/dev/vdb", byid=("virtio-B1",))],
            "data": [disk(parts=["sda1"])],
            "small": [disk(size=20 * GIB, problems=["smaller than 64 GiB"])],
            "installed": [disk(parts=["agentos-esp", "agentos-luks"])],
        }
        for name, ds in cases.items():
            with self.subTest(name):
                self.calls.clear()
                rc, out = self.auto(ds)
                self.assertEqual(self.wrote(), [], out)
                self.assertNotIn(("countdown", 10), self.calls, out)
                self.assertEqual(rc, 0 if name == "installed" else 1, out)
        rc, out = self.auto([disk(size=20 * GIB, problems=["smaller than 64 GiB"])])
        self.assertIn("at least 64 GB", out)
        rc, out = self.auto([disk(parts=["agentos-esp", "agentos-luks"])])
        self.assertIn("already installed", out)

    def test_a_disk_without_a_by_id_name_is_named_by_path(self):
        rc, out = self.auto([disk("/dev/sda", byid=())])
        self.assertEqual(rc, 0, out)
        self.assertEqual([c[1]["--disk"] for c in self.calls if c[0] == "plan"], ["/dev/sda"])
        self.assertEqual(os.environ.pop("AGENTOS_INSTALL_ALLOW_PATH", None), "1")

    def test_off_on_the_kernel_command_line(self):
        with open(self.cmdline, "w") as f:
            f.write("console=tty0 agentos.autoinstall=0\n")
        rc, out = self.auto([disk()])
        self.assertEqual((rc, out, self.wrote()), (0, "", []))

    def test_a_refused_install_says_why_and_how_to_go_on_by_hand(self):
        def refuse(a):
            raise self.m.Refuse("cryptsetup failed: boom")
        self.m.cmd_run = refuse
        rc, out = self.auto([disk()])
        self.assertEqual(rc, 1)
        self.assertIn("The install stopped: cryptsetup failed: boom", out)
        self.assertIn("sudo agentos-install inspect", out)


class DiskDetectorTest(unittest.TestCase):
    def setUp(self):
        self.m = load()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name, "disk")
        with self.path.open("wb") as f:
            f.truncate(24 * 1024**2)
        self.d = disk(str(self.path), self.path.stat().st_size)
        self.probe = mock.patch.object(self.m.subprocess, "run", return_value=mock.Mock(returncode=2))
        self.probe.start()
        self.addCleanup(self.probe.stop)

    def test_interior_data_is_not_blank(self):
        self.assertFalse(self.m.disk_has_data(self.d))
        with self.path.open("r+b") as f:
            f.seek(8 * 1024**2 + 13)
            f.write(b"EXISTING RAW DATA")
        self.assertTrue(self.m.disk_has_data(self.d))

    def test_short_read_unreadable_or_probe_failure_refuses(self):
        self.d["sizeBytes"] += 1
        self.assertTrue(self.m.disk_has_data(self.d))
        self.path.unlink()
        self.assertTrue(self.m.disk_has_data(self.d))
        with mock.patch.object(self.m.subprocess, "run", return_value=mock.Mock(returncode=4)):
            self.assertTrue(self.m.disk_has_data(self.d))

    def test_countdown_mutation_is_rejected_by_real_detector(self):
        self.m.disks = lambda: [self.d]
        self.m.logger = lambda msg: None
        self.m.kmsg = lambda msg: None
        self.m.cmd_plan = mock.Mock()
        real_open = open
        self.m.open = lambda p, *a, **kw: io.StringIO("") if p == "/proc/cmdline" else real_open(p, *a, **kw)
        def mutate(n):
            with self.path.open("r+b") as f:
                f.seek(12 * 1024**2)
                f.write(b"written during countdown")
            return True
        self.m.countdown = mutate
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.m.cmd_auto({}), 1)
        self.m.cmd_plan.assert_not_called()
        self.assertIn("after the countdown", output.getvalue())

    def test_identity_change_after_countdown_is_refused(self):
        self.m.disks = mock.Mock(side_effect=[[self.d], [dict(self.d, serial="replacement")]])
        self.m.logger = lambda msg: None
        self.m.kmsg = lambda msg: None
        self.m.cmd_plan = mock.Mock()
        self.m.countdown = lambda n: True
        real_open = open
        self.m.open = lambda p, *a, **kw: io.StringIO("") if p == "/proc/cmdline" else real_open(p, *a, **kw)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.m.cmd_auto({}), 1)
        self.m.cmd_plan.assert_not_called()


class QuickPlanTest(unittest.TestCase):
    def test_quick_plan_is_template_style_with_its_own_install_id(self):
        m = load()
        with tempfile.TemporaryDirectory() as d:
            key = Path(d, "k")
            key.write_text("agentos-qcow2-template-disk-key-v1\n")
            m.TEMPLATE_KEY = str(key)
            m.STATE_DIR = d
            m.STATE = f"{d}/state.json"
            m.find = lambda p: disk()
            m.medium_identity = lambda: "sha256:m"
            os.environ.pop("AGENTOS_INSTALL_TEMPLATE_BUILD", None)
            a = m.cmd_plan({"--disk": "/dev/disk/by-id/virtio-A1", "--quick": True, "--timezone": "UTC"})
            b = m.cmd_plan({"--disk": "/dev/disk/by-id/virtio-A1", "--quick": True, "--timezone": "UTC"})
            self.assertTrue(a["plan"]["quick"])
            self.assertNotIn("template", a["plan"])
            self.assertEqual(a["plan"]["templateLuksGiB"], 16)
            self.assertNotEqual(a["plan"]["installId"], b["plan"]["installId"])
            os.unlink(key)
            with self.assertRaises(m.Refuse):
                m.cmd_plan({"--disk": "/dev/disk/by-id/virtio-A1", "--quick": True, "--timezone": "UTC"})


if __name__ == "__main__":
    unittest.main()
