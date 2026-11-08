"""Version 1 quick-install initialization. Raw journal slots precede the first partition."""
import hashlib
import json
import os
import struct
import uuid

MIB = 1024**2
SLOTS = (4 * MIB, 8 * MIB)
SLOT_SIZE = 64 * 1024
MAGIC = b"AGENTOS-INIT-V1\0\0"
STAGES = ("gpt", "esp", "luks", "fs", "subvol")
PHASES = tuple(f"{stage}-{side}" for stage in STAGES for side in ("before", "after")) + ("copying",)
ALLOWED = {
    "gpt-before": {0, 1}, "gpt-after": {1},
    "esp-before": {1, 2}, "esp-after": {2},
    "luks-before": {2, 3}, "luks-after": {3},
    "fs-before": {3, 4}, "fs-after": {4},
    "subvol-before": {4, 5, 6}, "subvol-after": {6}, "copying": {6},
}
SUBVOLS = ("@root", "@nix", "@home", "@machine", "@broker", "@snapshots")
ESP_TYPE = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
LUKS_TYPE = "ca7d7ccb-63ed-4c53-861c-1742536059cc"


class Unsafe(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


SPEC_KEYS = {"gpt", "espPart", "luksPart", "luks", "btrfs", "version", "sector", "espStart", "espSize", "luksSize", "dataOffset", "fat"}


def validate_spec(spec):
    try:
        if not isinstance(spec, dict) or set(spec) != SPEC_KEYS:
            raise ValueError()
        for name in ("gpt", "espPart", "luksPart", "luks", "btrfs"):
            if not isinstance(spec[name], str):
                raise ValueError()
            uuid.UUID(spec[name])
        if any(type(spec[name]) is not int for name in ("version", "sector", "espStart", "espSize", "luksSize", "dataOffset")):
            raise ValueError()
        if spec["version"] != 1 or not isinstance(spec["fat"], str) or len(spec["fat"]) != 8:
            raise ValueError()
        int(spec["fat"], 16)
    except (ValueError, KeyError, TypeError):
        raise Unsafe("invalid version 1 identity specification") from None


def plan_spec(disk, gib, sector):
    if sector not in (512, 4096) or not 4 <= gib <= 60:
        raise Unsafe("unsupported initialization geometry")
    ids = {name: str(uuid.uuid4()) for name in ("gpt", "espPart", "luksPart", "luks", "btrfs")}
    ids.update(version=1, sector=sector, espStart=16 * MIB, espSize=2048 * MIB,
               luksSize=gib * 1024**3, dataOffset=16 * MIB, fat=uuid.uuid4().hex[:8])
    if ids["espStart"] + ids["espSize"] + ids["luksSize"] + MIB > disk["sizeBytes"]:
        raise Unsafe("disk cannot hold the precommitted layout")
    return ids


def encode(record):
    data = canonical(record)
    header = MAGIC + struct.pack(">I", len(data)) + hashlib.sha256(data).digest()
    if len(header) + len(data) > SLOT_SIZE:
        raise Unsafe("initialization checkpoint is too large")
    return (header + data).ljust(SLOT_SIZE, b"\0")


def decode(data):
    h = len(MAGIC) + 4 + 32
    if len(data) != SLOT_SIZE or not data.startswith(MAGIC):
        raise Unsafe("torn initialization checkpoint")
    n = struct.unpack(">I", data[len(MAGIC):len(MAGIC) + 4])[0]
    body = data[h:h + n]
    if not 0 < n <= SLOT_SIZE - h or any(data[h + n:]) or hashlib.sha256(body).digest() != data[h - 32:h]:
        raise Unsafe("torn initialization checkpoint")
    try:
        record = json.loads(body)
        if set(record) != {"version", "sequence", "previous", "phase", "plan", "planHash"}:
            raise ValueError()
        if type(record["version"]) is not int or record["version"] != 1 or type(record["sequence"]) is not int or record["phase"] not in ALLOWED:
            raise ValueError()
        if record["sequence"] != PHASES.index(record["phase"]) + 1:
            raise ValueError()
        previous = record["previous"]
        if record["sequence"] == 1:
            if previous is not None:
                raise ValueError()
        elif not isinstance(previous, str) or len(previous) != 64 or any(c not in "0123456789abcdef" for c in previous):
            raise ValueError()
        plan = record["plan"]
        if not isinstance(plan, dict) or not all(key in plan for key in ("disk", "identity", "medium", "system", "installId", "initialization", "quick", "templateLuksGiB")):
            raise ValueError()
        if not isinstance(plan["disk"], str) or not isinstance(plan["identity"], dict) or not isinstance(plan["initialization"], dict):
            raise ValueError()
        validate_spec(plan["initialization"])
        for key in ("serial", "wwn", "model", "sizeBytes"):
            if key not in plan["identity"]:
                raise ValueError()
        if record["planHash"] != "sha256:" + hashlib.sha256(b"agentos.install.plan.v1\n" + canonical(record["plan"])).hexdigest():
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise Unsafe("invalid initialization checkpoint") from None
    return record


def read_journal(dev):
    try:
        with open(dev, "rb", buffering=0) as stream:
            copies = []
            for offset in SLOTS:
                stream.seek(offset)
                copies.append(stream.read(SLOT_SIZE))
    except OSError as error:
        raise Unsafe("cannot read initialization checkpoint") from error
    if not any(data.startswith(MAGIC) for data in copies):
        return None
    records = [decode(data) for data in copies]
    low, high = sorted(records, key=lambda value: value["sequence"])
    if low == high:
        return high
    if high["sequence"] != low["sequence"] + 1 or high.get("previous") != digest(low) or high["planHash"] != low["planHash"]:
        raise Unsafe("ambiguous initialization checkpoint copies")
    return high


def write_journal(dev, record):
    data = encode(record)
    fd = os.open(os.path.realpath(dev), os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        for offset in SLOTS:
            written = 0
            while written < len(data):
                n = os.pwrite(fd, data[written:], offset + written)
                if n <= 0:
                    raise Unsafe("short initialization checkpoint write")
                written += n
            os.fsync(fd)
    finally:
        os.close(fd)


def zero_except(dev, size, excluded):
    cursor = 0
    ranges = []
    for start, end in sorted(excluded):
        if start < cursor or not 0 <= start <= end <= size:
            raise Unsafe("invalid proof range")
        ranges.append((cursor, start))
        cursor = end
    ranges.append((cursor, size))
    zeros = bytes(8 * MIB)
    try:
        with open(dev, "rb", buffering=0) as stream:
            for start, end in ranges:
                stream.seek(start)
                while start < end:
                    n = min(len(zeros), end - start)
                    data = stream.read(n)
                    if len(data) != n or data != zeros[:n]:
                        return False
                    start += n
    except OSError as error:
        raise Unsafe("cannot prove the initialization range is empty") from error
    return True


def flush(path):
    fd = os.open(os.path.realpath(path), os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def partition(dev, number):
    return f"{dev}p{number}" if dev[-1].isdigit() else f"{dev}{number}"


def adopt(record):
    return {"state": "copying" if record["phase"] == "copying" else "partitioning",
            "plan": record["plan"], "planHash": record["planHash"],
            "gptLabelId": record["plan"]["initialization"]["gpt"], "initCheckpoint": record}


class Initialization:
    def __init__(self, state, ops):
        self.st = state
        self.ops = ops
        self.plan = state["plan"]
        self.spec = self.plan["initialization"]
        self.record = state.get("initCheckpoint")
        self.dev = os.path.realpath(self.plan["disk"])
        self.p1, self.p2 = partition(self.dev, 1), partition(self.dev, 2)
        self.mapper = "/dev/mapper/agentos-root"
        self.top = "/run/agentos-install/init-top"

    def command(self, *args, **kwargs):
        return self.ops.sh(*args, **kwargs)

    def bind(self):
        def require(condition):
            if not condition:
                raise Unsafe("new-install ownership or medium identity does not match")
        p, s = self.plan, self.spec
        try:
            validate_spec(s)
            require(s["version"] == 1 and s["sector"] in (512, 4096))
            require(s["espStart"] == 16 * MIB and s["espSize"] == 2048 * MIB and s["dataOffset"] == 16 * MIB)
            require(s["luksSize"] == p["templateLuksGiB"] * 1024**3 and 4 <= p["templateLuksGiB"] <= 60)
            require(s["espStart"] + s["espSize"] + s["luksSize"] + MIB <= p["identity"]["sizeBytes"])
            require(len(s["fat"]) == 8 and int(s["fat"], 16) >= 0)
            require(p.get("quick") is True and not p.get("template"))
            require(os.path.dirname(p["disk"]) == "/dev/disk/by-id")
            require(p["identity"]["serial"] or p["identity"]["wwn"])
            require(self.st["planHash"] == self.ops.phash(p))
            require(p["system"] == self.ops.SYSTEM and p["medium"] == self.ops.medium_identity())
            current = self.ops.find(p["disk"])
            require(not current["problems"])
            require(current["path"] == self.dev)
            require(os.path.basename(p["disk"]) in current["byId"])
            require(all(current[key] == p["identity"][key] for key in ("serial", "wwn", "sizeBytes", "model")))
            require(int(self.command("blockdev", "--getss", self.dev).strip()) == s["sector"])
            matching = [disk for disk in self.ops.disks() if os.path.basename(p["disk"]) in disk["byId"]]
            require(len(matching) == 1 and matching[0]["path"] == current["path"])
            for disk in self.ops.disks():
                if disk["path"] != current["path"]:
                    other = read_journal(disk["path"])
                    require(not other or other["plan"]["installId"] != p["installId"])
        except (AssertionError, KeyError, TypeError, ValueError):
            raise Unsafe("new-install ownership or medium identity does not match") from None

    def checkpoint(self, phase, esp):
        self.record = {"version": 1, "sequence": (self.record or {}).get("sequence", 0) + 1,
                       "previous": digest(self.record) if self.record else None,
                       "phase": phase, "plan": self.plan, "planHash": self.st["planHash"]}
        self.st["initCheckpoint"] = self.record
        try:
            self.ops.save(self.st)
            write_journal(self.dev, self.record)
            if esp:
                self.ops.esp_write_state(self.st)
        except OSError:
            raise Unsafe("cannot durably persist the initialization checkpoint") from None
        self.fault(phase)

    def fault(self, phase):
        point = f"install.init.{phase}"
        if os.environ.get("AGENTOS_FAULT_POINT") == point:
            self.ops.progress(f"fault window {point}")
            os.kill(os.getpid(), 9)
        try:
            with open("/proc/cmdline") as stream:
                cmdline = stream.read().split()
        except OSError:
            cmdline = []
        if f"agentos.install-fault={point}" in cmdline:
            self.ops.kmsg(f"fault window {point}")
            while True:
                self.ops.time.sleep(60)

    def raw_blank(self, path, size, offset=0):
        return zero_except(path, size, [(0, offset)] if offset else [])

    def gpt(self):
        try:
            table = json.loads(self.command("sfdisk", "--json", self.dev, check=False))["partitiontable"]
        except (ValueError, KeyError, TypeError):
            return False
        s = self.spec
        starts = (s["espStart"], s["espStart"] + s["espSize"])
        sizes = (s["espSize"], s["luksSize"])
        parts = table.get("partitions", [])
        valid = table.get("label") == "gpt" and table.get("id", "").lower() == s["gpt"] and table.get("sectorsize") == s["sector"] and len(parts) == 2
        for index, p in enumerate(parts):
            if index >= 2:
                break
            valid = valid and p.get("start") == starts[index] // s["sector"] and p.get("size") == sizes[index] // s["sector"]
            valid = valid and p.get("uuid", "").lower() == s[("espPart", "luksPart")[index]]
            valid = valid and p.get("type", "").lower() == (ESP_TYPE, LUKS_TYPE)[index]
            valid = valid and p.get("name") == ("agentos-esp", "agentos-luks")[index]
        if not valid or "No problems found." not in self.command("sgdisk", "--verify", self.dev, check=False):
            raise Unsafe("foreign or incomplete GPT; no partitioning write was retried")
        return True

    def filesystem(self, path):
        result = self.command("blkid", "-p", "-o", "export", path, check=False)
        return dict(line.split("=", 1) for line in result.splitlines() if "=" in line)

    def esp(self):
        values = self.filesystem(self.p1)
        s = self.spec
        expected = s["fat"][:4] + "-" + s["fat"][4:]
        if values.get("TYPE") != "vfat" or values.get("UUID", "").lower() != expected:
            if self.raw_blank(self.p1, s["espSize"]):
                return False
            raise Unsafe("foreign or torn ESP filesystem")
        self.ops.check_init_esp(self.st, self.p1)
        return True

    def luks(self, password):
        values = self.filesystem(self.p2)
        s = self.spec
        if values.get("TYPE") != "crypto_LUKS" or values.get("UUID", "").lower() != s["luks"]:
            if self.raw_blank(self.p2, s["luksSize"]):
                return False
            raise Unsafe("foreign, unknown or torn LUKS header; it was not reformatted")
        try:
            meta = json.loads(self.command("cryptsetup", "luksDump", "--dump-json-metadata", self.p2))
        except ValueError:
            raise Unsafe("unreadable LUKS header metadata") from None
        segments = meta.get("segments", {})
        if len(segments) != 1 or segments.get("0", {}).get("type") != "crypt" or segments["0"].get("offset") != str(s["dataOffset"]):
            raise Unsafe("unexpected LUKS header layout")
        self.command("cryptsetup", "open", "--test-passphrase", "--key-file=-", self.p2, input=password)
        self.command("cryptsetup", "open", "--key-file=-", self.p2, "agentos-root", input=password)
        return True

    def subvolumes(self):
        self.command("mkdir", "-p", self.top)
        self.command("mount", "-o", "ro,nologreplay,subvolid=5", self.mapper, self.top)
        try:
            names = set(os.listdir(self.top))
            if not names <= set(SUBVOLS):
                raise Unsafe("unknown data in the initialized filesystem")
            for name in names:
                self.command("btrfs", "subvolume", "show", f"{self.top}/{name}")
                if os.listdir(f"{self.top}/{name}"):
                    raise Unsafe("initialized subvolume contains unknown data")
            return names
        finally:
            self.command("umount", self.top)

    def observe(self, password):
        s = self.spec
        size = self.plan["identity"]["sizeBytes"]
        slots = [(offset, offset + SLOT_SIZE) for offset in SLOTS]
        if not self.gpt():
            if not zero_except(self.dev, size, slots):
                raise Unsafe("unknown data or torn GPT outside the checkpoint")
            return 0
        sector = s["sector"]
        entries = (128 * 128 + sector - 1) // sector
        excluded = [(0, (2 + entries) * sector), *slots,
                    (s["espStart"], s["espStart"] + s["espSize"] + s["luksSize"]),
                    (size - (entries + 1) * sector, size)]
        if not zero_except(self.dev, size, excluded):
            raise Unsafe("unknown data outside the precommitted partitions")
        esp = self.esp()
        luks = self.luks(password)
        if not esp:
            if luks:
                raise Unsafe("initialized LUKS without its expected ESP")
            return 1
        if not luks:
            return 2
        self.ops.progress(f"reusing precommitted LUKS UUID {s['luks']}")
        self.ops.kmsg(f"reusing precommitted LUKS UUID {s['luks']}")
        values = self.filesystem(self.mapper)
        if values.get("TYPE") != "btrfs" or values.get("UUID", "").lower() != s["btrfs"]:
            if not values.get("TYPE") and self.raw_blank(self.p2, s["luksSize"], s["dataOffset"]):
                return 3
            raise Unsafe("foreign or torn inner filesystem; it was not reformatted")
        names = self.subvolumes()
        return 6 if names == set(SUBVOLS) else 5 if names else 4

    def apply(self, stage, password):
        s = self.spec
        if stage == "gpt":
            self.command("sgdisk", "--clear", "-U", s["gpt"],
                         f"-n1:{s['espStart'] // s['sector']}:+2GiB", "-t1:ef00", "-c1:agentos-esp",
                         f"-n2:0:+{self.plan['templateLuksGiB']}GiB", "-t2:8309", "-c2:agentos-luks",
                         "-u", f"1:{s['espPart']}", "-u", f"2:{s['luksPart']}", self.dev)
            self.command("partprobe", self.dev)
            self.command("udevadm", "settle")
            self.ops.wait_for(self.p1)
            self.ops.wait_for(self.p2)
            if not self.gpt():
                raise Unsafe("new GPT did not match the precommit")
        elif stage == "esp":
            self.command("mkfs.vfat", "-F", "32", "-n", "AGENTOS-ESP", "-i", s["fat"], self.p1)
            if not self.esp():
                raise Unsafe("new ESP did not match the precommit")
        elif stage == "luks":
            self.ops.kmsg(f"formatting precommitted LUKS UUID {s['luks']}")
            self.command("cryptsetup", "luksFormat", "--type", "luks2", "--batch-mode", "--uuid", s["luks"],
                         "--offset", str(s["dataOffset"] // 512), "--pbkdf", "argon2id", "--pbkdf-force-iterations", "4",
                         "--pbkdf-memory", "65536", "--pbkdf-parallel", "1", "--key-file=-", self.p2, input=password)
            if not self.luks(password):
                raise Unsafe("new LUKS did not match the precommit")
        elif stage == "fs":
            self.command("mkfs.btrfs", "-U", s["btrfs"], "-L", "agentos-root", self.mapper)
            values = self.filesystem(self.mapper)
            if values.get("TYPE") != "btrfs" or values.get("UUID", "").lower() != s["btrfs"]:
                raise Unsafe("new Btrfs did not match the precommit")
        else:
            names = self.subvolumes()
            self.command("mount", "-o", "subvolid=5", self.mapper, self.top)
            try:
                for name in SUBVOLS:
                    if name not in names:
                        self.command("btrfs", "subvolume", "create", f"{self.top}/{name}")
                self.command("sync", "-f", self.top)
            finally:
                self.command("umount", self.top)
            if self.subvolumes() != set(SUBVOLS):
                raise Unsafe("subvolume initialization did not finish")
        flush(self.dev if stage == "gpt" else self.p1 if stage == "esp" else self.p2 if stage == "luks" else self.mapper)
        self.fault(stage + "-written")

    def run(self, password, fresh=False):
        self.bind()
        if fresh:
            if read_journal(self.dev) is not None or not zero_except(self.dev, self.plan["identity"]["sizeBytes"], []):
                raise Unsafe("new initialization requires a completely zero disk")
            self.st["state"] = "partitioning"
            self.st["gptLabelId"] = self.spec["gpt"]
            self.checkpoint("gpt-before", False)
            observed = 0
        else:
            record = read_journal(self.dev)
            if not record or record["planHash"] != self.st["planHash"]:
                raise Unsafe("missing or mismatched precommitted initialization checkpoint")
            self.record = record
            self.st["initCheckpoint"] = record
            observed = self.observe(password)
            if observed not in ALLOWED[record["phase"]]:
                raise Unsafe("observed initialization state is not proven by its checkpoint phase")
            write_journal(self.dev, record)
            if observed >= 2:
                self.ops.esp_write_state(self.st)
            if record["phase"] == "copying":
                self.st["state"] = "copying"
                self.ops.esp_write_state(self.st)
                return
        phase = self.record["phase"]
        start = STAGES.index(phase.split("-")[0])
        if phase.endswith("-after"):
            start += 1
        for index in range(start, len(STAGES)):
            stage = STAGES[index]
            post = (1, 2, 3, 4, 6)[index]
            if self.record["phase"] != stage + "-before":
                self.checkpoint(stage + "-before", observed >= 2)
            if observed < post:
                self.apply(stage, password)
            observed = post
            self.checkpoint(stage + "-after", observed >= 2)
        self.st["state"] = "copying"
        self.checkpoint("copying", True)
