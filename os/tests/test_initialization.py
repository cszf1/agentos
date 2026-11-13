"""Production state observer and journal, with harmless block-tool/mount adapters."""
import copy
import io
from contextlib import redirect_stdout
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

SRC = Path(__file__).resolve().parents[1] / "installer/agentos-install.py"


def module():
    spec = importlib.util.spec_from_file_location("init_installer", SRC)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class Harness:
    def __init__(self, root):
        self.m = module()
        self.p = self.m.initialization
        self.root = Path(root)
        self.dev = str(self.root / "disk")
        with open(self.dev, "wb") as stream:
            stream.truncate(16 * self.p.MIB)
        self.disk = {"path": self.dev, "byId": ["virtio-A1"], "serial": "A1", "wwn": "", "model": "test",
                     "sizeBytes": 64 * 1024**3, "majMin": "253:0", "partitionTableDigest": "blank", "problems": []}
        self.spec = self.p.plan_spec(self.disk, 4, 512)
        plan = {"disk": "/dev/disk/by-id/virtio-A1", "identity": self.m.identity(self.disk), "medium": "medium", "system": "system",
                "installId": "faux-install-id", "initialization": self.spec, "quick": True, "templateLuksGiB": 4}
        self.state = {"state": "partitioning", "plan": plan, "planHash": self.m.phash(plan)}
        self.stage = 0
        self.foreign = None
        self.unknown = False
        self.calls = []
        self.esp_failure = None
        self.ops = types.SimpleNamespace(sh=self.command, find=lambda path: self.disk, disks=lambda: [self.disk],
                                         medium_identity=lambda: "medium", SYSTEM="system", phash=self.m.phash,
                                         save=lambda state: None, esp_write_state=self.persist_esp,
                                         check_init_esp=lambda *args: None, wait_for=lambda path: None,
                                         progress=lambda text: None, kmsg=lambda text: None, time=self.m.time)
        self.run = self.p.Initialization(self.state, self.ops)
        self.run.dev = self.dev
        self.run.p1 = str(self.root / "esp")
        self.run.p2 = str(self.root / "luks")
        self.run.mapper = str(self.root / "mapper")
        for path in (self.run.p1, self.run.p2, self.run.mapper):
            Path(path).touch()
        self.run.top = str(self.root / "top")
        Path(self.run.top).mkdir()

    def persist_esp(self, state):
        self.calls.append(("esp-checkpoint", state["initCheckpoint"]["phase"]))
        if self.esp_failure == state["initCheckpoint"]["phase"]:
            raise OSError("faux persistence failure")

    def seed(self, phase, observed):
        self.stage = observed
        names = self.p.SUBVOLS if observed == 6 else self.p.SUBVOLS[:2] if observed == 5 else []
        for name in names:
            Path(self.run.top, name).mkdir()
        sequence = self.p.PHASES.index(phase) + 1
        record = {"version": 1, "sequence": sequence, "previous": None if sequence == 1 else "0" * 64, "phase": phase,
                  "plan": self.state["plan"], "planHash": self.state["planHash"]}
        self.p.write_journal(self.dev, record)
        self.state["initCheckpoint"] = record
        self.run.record = record

    def zeros(self, path, size, excluded):
        if path == self.dev:
            return not self.unknown
        if path == self.run.p1:
            return self.stage < 2
        if path == self.run.p2:
            return self.stage < 3 or (excluded == [(0, self.spec["dataOffset"])] and self.stage == 3)
        raise AssertionError((path, size, excluded))

    def mutate(self, name):
        expected = self.p.read_journal(self.dev)
        assert expected["phase"] == name + "-before", expected
        assert expected["plan"]["initialization"] == self.spec
        self.calls.append(("mutation", name))

    def command(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ("findmnt", "--kernel"):
            return json.dumps({"filesystems": []})
        if args[:2] == ("blockdev", "--getss"):
            return "512\n"
        if args[:2] == ("sfdisk", "--json"):
            if self.stage == 0:
                return ""
            spec = self.spec
            parts = [{"start": spec["espStart"] // 512, "size": spec["espSize"] // 512,
                      "uuid": "foreign" if self.foreign == "gpt" else spec["espPart"], "type": self.p.ESP_TYPE, "name": "agentos-esp"},
                     {"start": (spec["espStart"] + spec["espSize"]) // 512, "size": spec["luksSize"] // 512,
                      "uuid": spec["luksPart"], "type": self.p.LUKS_TYPE, "name": "agentos-luks"}]
            return json.dumps({"partitiontable": {"label": "gpt", "id": spec["gpt"], "sectorsize": 512, "partitions": parts}})
        if args[:2] == ("sgdisk", "--verify"):
            return "No problems found."
        if args[:2] == ("sgdisk", "--clear"):
            self.mutate("gpt")
            self.stage = 1
        elif args[0] == "mkfs.vfat":
            self.mutate("esp")
            self.assert_flag(args, "-i", self.spec["fat"])
            self.stage = 2
        elif args[:2] == ("cryptsetup", "luksFormat"):
            self.mutate("luks")
            self.assert_flag(args, "--uuid", self.spec["luks"])
            self.stage = 3
        elif args[0] == "mkfs.btrfs":
            self.mutate("fs")
            self.assert_flag(args, "-U", self.spec["btrfs"])
            self.stage = 4
        elif args[:3] == ("btrfs", "subvolume", "create"):
            self.mutate("subvol")
            Path(args[3]).mkdir()
            self.stage = 6
        elif args[:2] == ("cryptsetup", "luksDump"):
            return json.dumps({"segments": {"0": {"type": "crypt", "offset": str(self.spec["dataOffset"])}}})
        elif args[0] == "blkid":
            path = args[-1]
            if path == self.run.p1 and self.stage >= 2:
                return f'TYPE=vfat\nUUID={self.spec["fat"][:4]}-{self.spec["fat"][4:]}\n'
            if path == self.run.p2 and self.stage >= 3:
                value = "foreign-luks" if self.foreign == "luks" else self.spec["luks"]
                return f"TYPE=crypto_LUKS\nUUID={value}\n"
            if path == self.run.mapper and self.stage >= 4:
                value = "foreign-fs" if self.foreign == "fs" else self.spec["btrfs"]
                return f"TYPE=btrfs\nUUID={value}\n"
        return ""

    @staticmethod
    def assert_flag(args, flag, value):
        assert args[args.index(flag) + 1] == value


class InitializationTest(unittest.TestCase):
    def test_reused_luks_is_announced_on_kernel_log_without_formatting(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.seed("luks-before", 3)
            h.ops.kmsg = mock.Mock()
            with mock.patch.object(h.p, "zero_except", side_effect=h.zeros):
                h.run.run(b"public-faux-template")
            h.ops.kmsg.assert_called_once_with(f"reusing precommitted LUKS UUID {h.spec['luks']}")
            self.assertFalse(any(call[:2] == ("cryptsetup", "luksFormat") for call in h.calls))

    def test_luks_format_is_announced_on_kernel_log_before_the_command(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.seed("luks-before", 2)
            h.ops.kmsg = mock.Mock()
            message = f"formatting precommitted LUKS UUID {h.spec['luks']}"
            def command(*args, **kwargs):
                if args[:2] == ("cryptsetup", "luksFormat"):
                    h.ops.kmsg.assert_called_once_with(message)
                return h.command(*args, **kwargs)
            h.ops.sh = command
            with mock.patch.object(h.p, "zero_except", side_effect=h.zeros):
                h.run.run(b"public-faux-template")
            h.ops.kmsg.assert_called_once_with(message)
            self.assertEqual(sum(call[:2] == ("cryptsetup", "luksFormat") for call in h.calls), 1)

    def test_each_before_and_after_boundary_resumes_only_missing_writes(self):
        cases = [(phase, observed) for phase, allowed in module().initialization.ALLOWED.items() for observed in sorted(allowed)]
        for phase, observed in cases:
            with self.subTest(phase=phase, observed=observed), tempfile.TemporaryDirectory() as root:
                h = Harness(root)
                h.seed(phase, observed)
                with mock.patch.object(h.p, "zero_except", side_effect=h.zeros):
                    h.run.run(b"public-faux-template")
                self.assertEqual(h.state["state"], "copying")
                self.assertEqual(h.p.read_journal(h.dev)["phase"], "copying")
                mutations = [call[1] for call in h.calls if call[0] == "mutation"]
                if observed >= 1:
                    self.assertNotIn("gpt", mutations)
                if observed >= 3:
                    self.assertNotIn("luks", mutations, "matching LUKS was reformatted")
                if observed >= 4:
                    self.assertNotIn("fs", mutations, "matching Btrfs was reformatted")

    def test_fresh_install_precommits_all_identities_before_every_write(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.state["state"] = "confirmed"
            with mock.patch.object(h.p, "zero_except", side_effect=h.zeros):
                h.run.run(b"public-faux-template", fresh=True)
            self.assertEqual(h.state["state"], "copying")
            self.assertEqual({call[1] for call in h.calls if call[0] == "mutation"}, set(h.p.STAGES))
            self.assertIn(("esp-checkpoint", "copying"), h.calls)

    def test_identity_guid_unknown_container_and_data_mismatches_never_initialize(self):
        for scenario in ("disk", "byid", "size", "model", "duplicate", "medium", "gpt", "luks", "fs", "data", "outside", "phase-ahead"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as root:
                h = Harness(root)
                h.seed("subvol-before", 4)
                if scenario == "disk":
                    h.disk["serial"] = "another-disk"
                elif scenario == "byid":
                    h.disk["byId"] = ["virtio-B"]
                elif scenario == "size":
                    h.disk["sizeBytes"] += 512
                elif scenario == "model":
                    h.disk["model"] = "foreign-model"
                elif scenario == "duplicate":
                    clone = str(h.root / "clone")
                    shutil.copyfile(h.dev, clone)
                    other = dict(h.disk, path=clone, byId=["virtio-B"])
                    h.ops.disks = lambda: [h.disk, other]
                elif scenario == "medium":
                    h.ops.medium_identity = lambda: "different-medium"
                elif scenario == "data":
                    Path(h.run.top, "foreign-data").write_text("preserve")
                elif scenario == "outside":
                    h.unknown = True
                elif scenario == "phase-ahead":
                    h.stage = 2
                else:
                    h.foreign = scenario
                with mock.patch.object(h.p, "zero_except", side_effect=h.zeros), self.assertRaises(h.p.Unsafe):
                    h.run.run(b"public-faux-template")
                self.assertFalse(any(call[0] == "mutation" for call in h.calls))

    def test_cmd_run_never_copies_payload_after_an_esp_barrier_failure(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.seed("gpt-before", 0)
            key = h.root / "public-template"
            key.write_bytes(b"public-faux-template")
            h.m.TEMPLATE_KEY = str(key)
            h.m.load = lambda: h.state
            h.m.init_protocol = lambda state: h.run
            h.m.sh = h.command
            h.esp_failure = "copying"
            with mock.patch.object(h.p, "zero_except", side_effect=h.zeros):
                with self.assertRaisesRegex(h.m.Refuse, "durably persist"):
                    h.m.cmd_run({})
            self.assertFalse(any(call[0] == "nixos-install" for call in h.calls))

    def test_operator_key_override_is_rejected_before_any_new_protocol_write(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.seed("gpt-before", 0)
            h.m.load = lambda: h.state
            h.m.sh = mock.Mock()
            with self.assertRaisesRegex(h.m.Refuse, "public template key"):
                h.m.cmd_run({"--passphrase-stdin": True})
            h.m.sh.assert_not_called()

    def test_raw_checkpoint_fsync_failure_prevents_the_first_partition_write(self):
        for fail_at in (1, 2):
            with self.subTest(fsync=fail_at), tempfile.TemporaryDirectory() as root:
                h = Harness(root)
                count = 0
                real_fsync = os.fsync
                def fsync(fd):
                    nonlocal count
                    count += 1
                    if count == fail_at:
                        raise OSError("faux fsync failure")
                    real_fsync(fd)
                with mock.patch.object(h.p, "zero_except", side_effect=h.zeros), mock.patch.object(os, "fsync", side_effect=fsync):
                    with self.assertRaisesRegex(h.p.Unsafe, "durably persist"):
                        h.run.run(b"public-faux-template", fresh=True)
                self.assertFalse(any(call[0] == "mutation" for call in h.calls))

    def test_esp_checkpoint_failure_prevents_the_next_write_and_copy_barrier(self):
        for phase in ("esp-after", "luks-before", "copying"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as root:
                h = Harness(root)
                h.seed("esp-before", 1)
                h.esp_failure = phase
                with mock.patch.object(h.p, "zero_except", side_effect=h.zeros), self.assertRaisesRegex(h.p.Unsafe, "durably persist"):
                    h.run.run(b"public-faux-template")
                if phase != "copying":
                    self.assertFalse(any(call[:2] == ("cryptsetup", "luksFormat") for call in h.calls))


class JournalTest(unittest.TestCase):
    def test_torn_or_ambiguous_copies_refuse_without_fallback(self):
        for scenario in ("torn", "missing", "different-plan", "unlinked-sequence"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as root:
                h = Harness(root)
                h.seed("gpt-before", 0)
                old = h.p.read_journal(h.dev)
                if scenario == "torn":
                    with open(h.dev, "r+b") as stream:
                        stream.seek(h.p.SLOTS[1] + 80)
                        stream.write(b"broken")
                else:
                    new = copy.deepcopy(old)
                    new.update(sequence=3 if scenario == "unlinked-sequence" else 2, phase="gpt-after", previous=h.p.digest(old))
                    if scenario == "different-plan":
                        new["plan"]["installId"] = "foreign"
                        new["planHash"] = h.m.phash(new["plan"])
                    data = bytes(h.p.SLOT_SIZE) if scenario == "missing" else h.p.encode(new)
                    with open(h.dev, "r+b") as stream:
                        stream.seek(h.p.SLOTS[1])
                        stream.write(data)
                with self.assertRaises(h.p.Unsafe):
                    h.p.read_journal(h.dev)

    def test_by_id_resolution_cannot_move_after_driver_creation(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.run.dev = str(Path(root) / "reused-device-path")
            with self.assertRaisesRegex(h.p.Unsafe, "ownership"):
                h.run.bind()
            self.assertEqual(h.calls, [])

    def test_torn_checkpoint_still_has_a_successful_read_only_inspection_command(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.seed("gpt-before", 0)
            with open(h.dev, "r+b") as stream:
                stream.seek(h.p.SLOTS[1] + 80)
                stream.write(b"torn")
            h.m.find = lambda path: h.disk
            h.m.save = mock.Mock()
            disk = h.state["plan"]["disk"]
            inspection = h.m.cmd_recover({"--disk": disk})
            self.assertTrue(inspection["readOnly"])
            self.assertFalse(inspection["automaticResume"])
            self.assertIn("checkpoint", inspection["recover"]["checkpointError"])
            with self.assertRaisesRegex(h.m.Refuse, "Inspect with: sudo agentos-install recover --disk"):
                h.m.cmd_recover({"--disk": disk, "--resume": True})
            h.m.save.assert_not_called()

    def test_adjacent_chained_copy_and_empty_disk_are_recognized(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            self.assertIsNone(h.p.read_journal(h.dev))
            h.seed("gpt-before", 0)
            old = h.p.read_journal(h.dev)
            new = dict(old, sequence=2, phase="gpt-after", previous=h.p.digest(old))
            with open(h.dev, "r+b") as stream:
                stream.seek(h.p.SLOTS[0])
                stream.write(h.p.encode(new))
            self.assertEqual(h.p.read_journal(h.dev), new)

    def test_real_zero_detector_checks_interior_and_short_reads(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            size = Path(h.dev).stat().st_size
            excluded = [(offset, offset + h.p.SLOT_SIZE) for offset in h.p.SLOTS]
            h.seed("gpt-before", 0)
            self.assertTrue(h.p.zero_except(h.dev, size, excluded))
            with open(h.dev, "r+b") as stream:
                stream.seek(12 * h.p.MIB)
                stream.write(b"unknown existing bytes")
            self.assertFalse(h.p.zero_except(h.dev, size, excluded))
            self.assertFalse(h.p.zero_except(h.dev, size + 1, excluded))


class InstallTargetTest(unittest.TestCase):
    def test_run_refuses_foreign_mount_before_rechecking_or_writing_the_disk(self):
        with tempfile.TemporaryDirectory() as root:
            m = module()
            key = Path(root) / "key"
            key.write_bytes(b"public-faux-template")
            m.TEMPLATE_KEY = str(key)
            m.load = lambda: {"state": "confirmed", "plan": {"disk": "/dev/vda", "quick": True}}
            m.recheck = mock.Mock(side_effect=AssertionError("the installer reached the disk plan"))
            m.sh = mock.Mock(return_value=json.dumps({"filesystems": [
                {"target": f"{m.MNT}/nix", "source": "tmpfs", "fstype": "tmpfs", "fsroot": "/"},
            ]}))
            with self.assertRaisesRegex(m.Refuse, "mount"):
                m.cmd_run({})
            m.recheck.assert_not_called()

    def test_resume_refuses_mapper_backed_by_another_disk_before_using_it(self):
        with tempfile.TemporaryDirectory() as root:
            m = module()
            key = Path(root) / "key"
            key.write_bytes(b"public-faux-template")
            m.TEMPLATE_KEY = str(key)
            m.load = lambda: {"state": "copying", "plan": {"disk": "/dev/vda", "quick": True}}
            m.resume_check = mock.Mock(side_effect=AssertionError("the installer began resuming the copy"))
            m.sh = mock.Mock(side_effect=[json.dumps({"filesystems": []}), "  type: LUKS2\n  device: /dev/vdb2\n"])
            exists = os.path.exists
            with mock.patch.object(os.path, "exists", side_effect=lambda p: p == "/dev/mapper/agentos-root" or exists(p)):
                with self.assertRaisesRegex(m.Refuse, "mapper|mapping"):
                    m.cmd_run({})
            m.resume_check.assert_not_called()

    def test_resume_accepts_matching_subvolumes_but_refuses_another_filesystem_root(self):
        m = module()
        mounts = [
            {"target": m.MNT, "source": m.ROOT_MAPPER, "fstype": "btrfs", "fsroot": "/@root", "vfs-options": "rw,relatime"},
            {"target": f"{m.MNT}/nix", "source": m.ROOT_MAPPER, "fstype": "btrfs", "fsroot": "/@nix", "vfs-options": "rw,relatime"},
            {"target": f"{m.MNT}/boot", "source": "/dev/vda1", "fstype": "vfat", "fsroot": "/", "vfs-options": "rw"},
        ]
        m.sh = lambda *args, **kwargs: json.dumps({"filesystems": mounts})
        self.assertEqual(m.check_install_mounts("/dev/vda", True), {mount["target"] for mount in mounts})
        mounts[1]["fsroot"] = "/@home"
        with self.assertRaisesRegex(m.Refuse, f"unexpected mount at {m.MNT}/nix"):
            m.check_install_mounts("/dev/vda", True)

    def test_resume_reads_the_verified_esp_mount_without_a_second_mount(self):
        with tempfile.TemporaryDirectory() as root:
            m = module()
            m.MNT = root
            esp = Path(root) / "boot/EFI/agentos"
            esp.mkdir(parents=True)
            marker = esp / "install.json"
            st = {"plan": {"disk": "/dev/vda", "installId": "current-install"}}
            m.subprocess = mock.Mock()
            for install_id in ("current-install", "foreign-install"):
                marker.write_text(json.dumps({"installId": install_id}))
                self.assertEqual(m.resume_check(st, {f"{root}/boot"}), install_id == "current-install")
            m.subprocess.run.assert_not_called()


class EspProofTest(unittest.TestCase):
    def test_unknown_or_torn_esp_contents_refuse(self):
        for scenario in ("unknown", "torn", "stale", "matching", "previous"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as root:
                h = Harness(root)
                h.seed("esp-after", 2)
                h.m.INIT_ESP_RO = str(h.root / "esp-ro")
                base = Path(h.m.INIT_ESP_RO)
                (base / "EFI/agentos").mkdir(parents=True)
                state = base / h.m.ESP_STATE
                current = copy.deepcopy(h.state)
                if scenario == "previous":
                    old = dict(current["initCheckpoint"], phase="esp-before", sequence=3, previous="0" * 64)
                    h.state["initCheckpoint"]["previous"] = h.p.digest(old)
                    current["initCheckpoint"] = old
                state.write_text(json.dumps(current))
                if scenario == "unknown":
                    (base / "foreign-user-file").write_text("preserve")
                elif scenario == "torn":
                    state.write_text("{")
                elif scenario == "stale":
                    current["initCheckpoint"]["sequence"] = 19
                    state.write_text(json.dumps(current))
                h.m.sh = lambda *args, **kwargs: ""
                if scenario in ("matching", "previous"):
                    h.m.check_init_esp(h.state, "faux-esp")
                else:
                    with self.assertRaises(h.m.Refuse):
                        h.m.check_init_esp(h.state, "faux-esp")

    def test_missing_esp_or_mount_failure_is_not_silently_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.state["plan"]["disk"] = h.dev
            h.m.STATE_DIR = str(h.root / "state")
            with self.assertRaisesRegex(h.m.Refuse, "ESP is missing"):
                h.m.esp_write_state(h.state)
            Path(h.dev + "1").touch()
            with mock.patch.object(h.m.subprocess, "run", return_value=types.SimpleNamespace(returncode=1)):
                with self.assertRaisesRegex(h.m.Refuse, "cannot mount"):
                    h.m.esp_write_state(h.state)


class EspPersistenceTest(unittest.TestCase):
    def test_fsync_and_unmount_errors_are_safe_refusals(self):
        for scenario in ("fsync", "umount"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as root:
                h = Harness(root)
                h.state["plan"]["disk"] = h.dev
                h.state["planHash"] = h.m.phash(h.state["plan"])
                h.m.STATE_DIR = str(h.root / "state")
                Path(h.dev + "1").touch()
                def command(args, **kwargs):
                    rc = 1 if args[0] == "mountpoint" or (scenario == "umount" and args[0] == "umount") else 0
                    return types.SimpleNamespace(returncode=rc)
                with mock.patch.object(h.m.subprocess, "run", side_effect=command):
                    if scenario == "fsync":
                        with mock.patch.object(os, "fsync", side_effect=OSError("faux sync failure")):
                            with self.assertRaisesRegex(h.m.Refuse, "durably persist"):
                                h.m.esp_write_state(h.state)
                    else:
                        with self.assertRaisesRegex(h.m.Refuse, "flush/unmount"):
                            h.m.esp_write_state(h.state)


class DiskToolTest(unittest.TestCase):
    def test_real_sgdisk_preserves_the_journal_and_writes_every_precommitted_guid(self):
        if not shutil.which("sgdisk") or not shutil.which("sfdisk"):
            self.skipTest("requires pinned gptfdisk and util-linux")
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            with open(h.dev, "r+b") as stream:
                stream.truncate(h.disk["sizeBytes"])
            h.seed("gpt-before", 0)
            h.run.apply("gpt", b"public-faux-template")
            command = next(call for call in h.calls if call[:2] == ("sgdisk", "--clear"))
            result = subprocess.run(command, capture_output=True, check=False, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(h.p.read_journal(h.dev)["phase"], "gpt-before")
            h.ops.sh = lambda *args, **kwargs: subprocess.run(args, check=False, capture_output=True, text=True, timeout=30, env=dict(os.environ, LC_ALL="C")).stdout
            self.assertTrue(h.run.gpt())
            self.assertEqual(h.p.read_journal(h.dev)["plan"]["initialization"], h.spec)

    def test_real_fat_luks_and_btrfs_tools_use_the_explicit_identities(self):
        tools = ("mkfs.vfat", "cryptsetup", "mkfs.btrfs", "blkid")
        if not all(shutil.which(tool) for tool in tools):
            self.skipTest("requires pinned filesystem tools")
        for stage, observed, size, kind, identifier in (
                ("esp", 1, 2048 * 1024**2, "vfat", "fat"),
                ("luks", 2, 64 * 1024**2, "crypto_LUKS", "luks"),
                ("fs", 3, 256 * 1024**2, "btrfs", "btrfs")):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as root:
                h = Harness(root)
                h.seed(stage + "-before", observed)
                password = b"public-faux-template"
                h.run.apply(stage, password)
                prefix = {"esp": ("mkfs.vfat",), "luks": ("cryptsetup", "luksFormat"), "fs": ("mkfs.btrfs",)}[stage]
                command = next(call for call in h.calls if call[:len(prefix)] == prefix)
                path = h.run.p1 if stage == "esp" else h.run.p2 if stage == "luks" else h.run.mapper
                with open(path, "r+b") as stream:
                    stream.truncate(size)
                result = subprocess.run(command, input=password if stage == "luks" else None, capture_output=True, check=False, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                probe = subprocess.run(["blkid", "-p", "-o", "export", path], capture_output=True, text=True, check=True, timeout=30).stdout
                actual = dict(line.split("=", 1) for line in probe.splitlines() if "=" in line)
                expected = h.spec[identifier]
                if stage == "esp":
                    expected = expected[:4] + "-" + expected[4:]
                self.assertEqual(actual["TYPE"], kind)
                self.assertEqual(actual["UUID"].lower(), expected)
                if stage == "luks":
                    check = subprocess.run(["cryptsetup", "open", "--test-passphrase", "--key-file=-", path], input=password, capture_output=True, timeout=30)
                    self.assertEqual(check.returncode, 0, check.stderr)
                    meta = json.loads(subprocess.run(["cryptsetup", "luksDump", "--dump-json-metadata", path], check=True, capture_output=True, text=True, timeout=30).stdout)
                    self.assertEqual(meta["segments"]["0"]["offset"], str(h.spec["dataOffset"]))
                    self.assertTrue(h.p.zero_except(path, size, [(0, h.spec["dataOffset"])]))

    def test_lock_is_exclusive_and_inherited_by_the_actual_disk_command_child(self):
        with tempfile.TemporaryDirectory() as root:
            m = module()
            m.STATE_DIR = root
            with m.installer_lock(True):
                fd = m.INSTALL_LOCK_FD
                with self.assertRaisesRegex(m.Refuse, "still running"):
                    with m.installer_lock(True):
                        self.fail("concurrent installer entered")
                self.assertEqual(m.INSTALL_LOCK_FD, fd)
                output = m.sh(sys.executable, "-c", "import os,sys; os.fstat(int(sys.argv[1])); print('inherited')", str(fd))
                self.assertEqual(output.strip(), "inherited")
            self.assertIsNone(m.INSTALL_LOCK_FD)
            with m.installer_lock(True):
                self.assertIsNotNone(m.INSTALL_LOCK_FD)


class AutomaticRouteTest(unittest.TestCase):
    def test_new_checkpoint_is_adopted_without_countdown_or_new_destructive_plan(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.seed("gpt-before", 0)
            m = h.m
            m.disks = lambda: [h.disk]
            m.find = lambda path: h.disk
            m.init_protocol = lambda state: h.run
            m.save = mock.Mock()
            m.cmd_plan = mock.Mock()
            m.countdown = mock.Mock()
            m.cmd_run = mock.Mock(return_value={"state": "installed", "installId": "faux-install-id"})
            m.finish_auto = mock.Mock(return_value=0)
            m.logger = m.kmsg = lambda text: None
            realpath = os.path.realpath
            resolve = lambda path: h.dev if path == h.state["plan"]["disk"] else realpath(path)
            with mock.patch.object(os.path, "realpath", side_effect=resolve), redirect_stdout(io.StringIO()):
                self.assertEqual(m.cmd_auto({"--no-reboot": True}), 0)
            m.cmd_plan.assert_not_called()
            m.countdown.assert_not_called()
            m.cmd_run.assert_called_once_with({})
            m.finish_auto.assert_called_once()

    def test_direct_recover_failure_prints_a_read_only_command_that_is_accepted(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.seed("gpt-before", 0)
            h.disk["serial"] = "foreign"
            h.m.find = lambda path: h.disk
            h.m.init_protocol = lambda state: h.run
            h.m.save = mock.Mock()
            disk = h.state["plan"]["disk"]
            with self.assertRaisesRegex(h.m.Refuse, "Inspect with: sudo agentos-install recover --disk /dev/disk/by-id/virtio-A1"):
                h.m.cmd_recover({"--disk": disk, "--resume": True})
            h.m.save.assert_not_called()
            self.assertTrue(h.m.cmd_recover({"--disk": disk})["readOnly"])

    def test_by_id_repointing_refuses_before_adoption_or_run(self):
        with tempfile.TemporaryDirectory() as root:
            h = Harness(root)
            h.seed("gpt-before", 0)
            m = h.m
            m.disks = lambda: [h.disk]
            m.cmd_recover = mock.Mock()
            m.cmd_run = mock.Mock()
            m.cmd_plan = mock.Mock()
            m.logger = m.kmsg = lambda text: None
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(m.cmd_auto({}), 1)
            self.assertIn("sudo agentos-install recover --disk /dev/disk/by-id/virtio-A1", output.getvalue())
            m.cmd_recover.assert_not_called()
            m.cmd_run.assert_not_called()
            m.cmd_plan.assert_not_called()
