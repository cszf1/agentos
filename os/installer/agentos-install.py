#!/usr/bin/env python3
"""AgentOS offline installer (spec §19.2–19.4, V1-U01/U02).

States: inspecting → plan_ready → confirmed → partitioning → copying → configuring → verifying → installed.
Failures keep the state and step in /run/agentos-install/state.json (and, after partitioning, on the target ESP).

  agentos-install inspect                                  candidate disks (JSON)
  agentos-install plan --disk /dev/disk/by-id/X [--timezone Asia/Taipei]
  agentos-install confirm --plan-hash H --serial SERIAL    the local user types the disk serial (or WWN) shown
  agentos-install run --passphrase-stdin                   partition → copy → configure → verify → installed
  agentos-install status

The plan binds WWN/serial, major:minor, size, the partition-table digest and the install-medium identity. Before the
first destructive write every value is read again; the install medium itself, a mounted/swap/held device, a
changed identity and a disk below 64 GiB are refused. After a crash `run` inspects the real GPT and the install id
on the ESP; it never re-formats a different disk with the same name. The system closure is copied from the ISO's
own store (no network). The LUKS passphrase is read from stdin only, never from argv, and is not written anywhere.
"""
import hashlib, json, os, subprocess, sys, time, uuid

STATE_DIR = "/run/agentos-install"
STATE = f"{STATE_DIR}/state.json"
MIN_BYTES = 64 * 1024**3
SYSTEM = os.environ.get("AGENTOS_SYSTEM", "@SYSTEM@")  # base release toplevel (substituted at build time)
RELEASE = os.environ.get("AGENTOS_RELEASE_FILE", "@RELEASE@")
MNT = "/mnt"
SUBVOLS = ["@root", "@nix", "@home", "@machine", "@broker", "@snapshots"]
MOUNTS = [("@nix", "nix"), ("@home", "home"), ("@machine", "var/lib/agentos-machine"), ("@broker", "var/lib/agentos-broker"), ("@snapshots", "var/lib/agentos-snapshots")]


class Refuse(Exception):
    pass


def sh(*a, input=None, check=True):
    r = subprocess.run(list(a), input=input, capture_output=True)
    if check and r.returncode != 0:
        raise Refuse(f"{a[0]} failed: {r.stderr.decode(errors='replace').strip()[:400]}")
    return r.stdout.decode(errors="replace")


def canon(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def phash(v):
    return "sha256:" + hashlib.sha256(("agentos.install.plan.v1\n" + canon(v)).encode()).hexdigest()


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"state": "inspecting"}


def save(st):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATE)


def install_medium_disks():
    """Disks backing the running installer (ISO / USB / CD): never a target."""
    out = set()
    for mp in ["/iso", "/nix/.ro-store", "/run/rootfsbase"]:
        src = sh("findmnt", "-n", "-o", "SOURCE", "--target", mp, check=False).strip()
        if src.startswith("/dev/"):
            pk = sh("lsblk", "-n", "-o", "PKNAME", src, check=False).strip().splitlines()
            out.add(os.path.realpath(src))
            for p in pk:
                if p.strip():
                    out.add("/dev/" + p.strip())
    for d in os.listdir("/dev/disk/by-label") if os.path.isdir("/dev/disk/by-label") else []:
        if d.startswith("AGENTOS-INSTALL") or d.startswith("nixos-minimal"):
            r = os.path.realpath(f"/dev/disk/by-label/{d}")
            out.add(r)
            pk = sh("lsblk", "-n", "-o", "PKNAME", r, check=False).strip()
            if pk:
                out.add("/dev/" + pk.splitlines()[0])
    return out


def disks():
    j = json.loads(sh("lsblk", "-J", "-b", "-o", "NAME,PATH,TYPE,SIZE,SERIAL,WWN,MODEL,MAJ:MIN,RM,RO,MOUNTPOINTS,FSTYPE,PARTLABEL"))
    swaps = open("/proc/swaps").read()
    media = install_medium_disks()
    res = []
    for d in j["blockdevices"]:
        if d["type"] != "disk" or d["path"].startswith("/dev/zram") or d["path"].startswith("/dev/loop") or d["path"].startswith("/dev/sr"):
            continue
        name = d["name"]
        holders = os.listdir(f"/sys/block/{name}/holders") if os.path.isdir(f"/sys/block/{name}/holders") else []
        mounted, swapping = [], []
        for c in [d] + d.get("children", []):
            for m in c.get("mountpoints") or []:
                if m:
                    mounted.append(m)
            if c["path"] in swaps:
                swapping.append(c["path"])
            ch = os.listdir(f"/sys/class/block/{c['name']}/holders") if os.path.isdir(f"/sys/class/block/{c['name']}/holders") else []
            holders += ch
        ptable = sh("sfdisk", "--dump", d["path"], check=False)
        byid = sorted(x for x in os.listdir("/dev/disk/by-id") if os.path.realpath(f"/dev/disk/by-id/{x}") == d["path"]) if os.path.isdir("/dev/disk/by-id") else []
        problems = []
        if d["path"] in media:
            problems.append("install medium")
        if mounted:
            problems.append("mounted: " + ",".join(mounted))
        if swapping:
            problems.append("swap in use")
        if holders:
            problems.append("held by " + ",".join(sorted(set(holders))))
        if int(d["size"]) < MIN_BYTES:
            problems.append("smaller than 64 GiB")
        if d.get("ro"):
            problems.append("read-only")
        res.append({
            "path": d["path"], "byId": byid, "model": (d.get("model") or "").strip(), "serial": (d.get("serial") or "").strip(),
            "wwn": (d.get("wwn") or "").strip(), "majMin": d["maj:min"], "sizeBytes": int(d["size"]),
            "partitionTableDigest": "sha256:" + hashlib.sha256(ptable.encode()).hexdigest(),
            "partitions": [c.get("partlabel") or c["name"] for c in d.get("children", [])], "problems": problems,
        })
    return res


def medium_identity():
    for p in ["/iso/version.txt", "/etc/agentos-install-medium.json"]:
        if os.path.exists(p):
            return "sha256:" + hashlib.sha256(open(p, "rb").read()).hexdigest()
    return "sha256:" + hashlib.sha256(open("/proc/sys/kernel/random/boot_id").read().encode()).hexdigest()


def find(path):
    real = os.path.realpath(path)
    for d in disks():
        if d["path"] == real:
            return d
    raise Refuse(f"{path} is not a whole disk")


def identity(d):
    return {k: d[k] for k in ["serial", "wwn", "majMin", "sizeBytes", "partitionTableDigest", "model"]}


def cmd_plan(args):
    disk = args["--disk"]
    if not disk.startswith("/dev/disk/by-id/") and not os.environ.get("AGENTOS_INSTALL_ALLOW_PATH"):
        raise Refuse("name the target by /dev/disk/by-id/…; /dev/sdX is not a stable target")
    d = find(disk)
    if d["problems"]:
        raise Refuse(f"target refused: {'; '.join(d['problems'])}")
    tz = args.get("--timezone", "UTC")
    if not os.path.exists(f"/etc/zoneinfo/{tz}") and not os.path.exists(f"/usr/share/zoneinfo/{tz}"):
        if not all(c.isalnum() or c in "/_-+" for c in tz):
            raise Refuse("bad timezone")
    plan = {"formatVersion": 1, "disk": disk, "identity": identity(d), "medium": medium_identity(), "timezone": tz, "system": SYSTEM,
            "erase": "the whole disk", "layout": {"esp": "2 GiB", "luks2": "rest", "btrfs": SUBVOLS}, "installId": str(uuid.uuid4())}
    st = {"state": "plan_ready", "plan": plan, "planHash": phash(plan), "updatedAt": time.time()}
    save(st)
    return {"planHash": st["planHash"], "plan": plan, "confirmWith": "type the disk serial (or WWN when there is no serial)"}


def cmd_confirm(args):
    st = load()
    if st["state"] != "plan_ready":
        raise Refuse(f"state is {st['state']}")
    if args["--plan-hash"] != st["planHash"]:
        raise Refuse("plan hash does not match the plan on screen")
    ident = st["plan"]["identity"]
    want = ident["serial"] or ident["wwn"] or ident["majMin"]
    if args["--serial"] != want:
        raise Refuse("typed serial does not match the target disk")
    st["state"] = "confirmed"
    st["confirmedAt"] = time.time()
    save(st)
    return {"state": "confirmed"}


def recheck(st):
    d = find(st["plan"]["disk"])
    if identity(d) != st["plan"]["identity"]:
        raise Refuse("the target disk changed since the plan (identity/partition table); nothing was written")
    if d["problems"]:
        raise Refuse(f"target refused now: {'; '.join(d['problems'])}")
    if medium_identity() != st["plan"]["medium"]:
        raise Refuse("install medium changed")
    return d


def part(dev, n):
    return f"{dev}p{n}" if dev[-1].isdigit() else f"{dev}{n}"


def wait_for(p, t=30):
    for _ in range(t * 10):
        if os.path.exists(p):
            return
        time.sleep(0.1)
    raise Refuse(f"{p} did not appear")


def step(st, name):
    st["state"] = name
    st["step"] = name
    st["updatedAt"] = time.time()
    save(st)
    if os.environ.get("AGENTOS_FAULT_POINT") == f"install.{name}":
        os.kill(os.getpid(), 9)


def esp_marker(st):
    return {"installId": st["plan"]["installId"], "planHash": st["planHash"], "identity": st["plan"]["identity"]}


def resume_check(st):
    """After a crash past partitioning: the disk must carry OUR install id; otherwise refuse (never re-format)."""
    dev = os.path.realpath(st["plan"]["disk"])
    esp = part(dev, 1)
    if not os.path.exists(esp):
        return False
    sh("mkdir", "-p", "/run/agentos-install/esp")
    r = subprocess.run(["mount", "-o", "ro", esp, "/run/agentos-install/esp"], capture_output=True)
    if r.returncode != 0:
        return False
    try:
        m = json.load(open("/run/agentos-install/esp/EFI/agentos/install.json"))
        return m.get("installId") == st["plan"]["installId"]
    except Exception:
        return False
    finally:
        subprocess.run(["umount", "/run/agentos-install/esp"])


def cmd_run(args):
    st = load()
    if st["state"] not in ("confirmed", "partitioning", "copying", "configuring", "verifying"):
        raise Refuse(f"state is {st['state']}; plan and confirm first")
    pw = sys.stdin.buffer.read().rstrip(b"\n") if "--passphrase-stdin" in args else b""
    if len(pw) < 8:
        raise Refuse("a LUKS passphrase of at least 8 characters is required on stdin")
    dev = os.path.realpath(st["plan"]["disk"])
    if st["state"] == "confirmed":
        recheck(st)
        step(st, "partitioning")
        sh("wipefs", "-a", dev)
        sh("sgdisk", "--zap-all", dev)
        sh("sgdisk", "-n1:1MiB:+2GiB", "-t1:ef00", "-c1:agentos-esp", "-n2:0:0", "-t2:8309", "-c2:agentos-luks", dev)
        sh("partprobe", dev, check=False)
        sh("udevadm", "settle")
        wait_for(part(dev, 1))
        sh("mkfs.vfat", "-F", "32", "-n", "AGENTOS-ESP", part(dev, 1))
        sh("mkdir", "-p", "/run/agentos-install/esp")
        sh("mount", part(dev, 1), "/run/agentos-install/esp")
        os.makedirs("/run/agentos-install/esp/EFI/agentos", exist_ok=True)
        with open("/run/agentos-install/esp/EFI/agentos/install.json", "w") as f:
            json.dump(esp_marker(st), f)
            f.flush()
            os.fsync(f.fileno())
        sh("umount", "/run/agentos-install/esp")
        sh("cryptsetup", "luksFormat", "--type", "luks2", "--batch-mode", "--pbkdf", "argon2id", "--key-file=-", part(dev, 2), input=pw)
    else:
        if not resume_check(st):
            raise Refuse("resume refused: the disk does not carry this install's id (different disk or wiped); start a new plan")
    if not os.path.exists("/dev/mapper/agentos-root"):
        sh("cryptsetup", "open", "--key-file=-", part(dev, 2), "agentos-root", input=pw)
    pw = b"\0" * len(pw)
    if st["state"] == "partitioning":
        sh("mkfs.btrfs", "-f", "-L", "agentos-root", "/dev/mapper/agentos-root")
        sh("mkdir", "-p", "/run/agentos-install/top")
        sh("mount", "/dev/mapper/agentos-root", "/run/agentos-install/top")
        for s in SUBVOLS:
            sh("btrfs", "subvolume", "create", f"/run/agentos-install/top/{s}")
        sh("umount", "/run/agentos-install/top")
        step(st, "copying")
    # mount the target (idempotent)
    if subprocess.run(["mountpoint", "-q", MNT]).returncode != 0:
        sh("mkdir", "-p", MNT)
        sh("mount", "-o", "subvol=@root,compress=zstd:1", "/dev/mapper/agentos-root", MNT)
    for sv, mp in MOUNTS:
        if subprocess.run(["mountpoint", "-q", f"{MNT}/{mp}"]).returncode != 0:
            sh("mkdir", "-p", f"{MNT}/{mp}")
            sh("mount", "-o", f"subvol={sv},compress=zstd:1", "/dev/mapper/agentos-root", f"{MNT}/{mp}")
    if subprocess.run(["mountpoint", "-q", f"{MNT}/boot"]).returncode != 0:
        sh("mkdir", "-p", f"{MNT}/boot")
        sh("mount", "-o", "umask=0077", part(dev, 1), f"{MNT}/boot")
    if st["state"] == "copying":
        # Offline: the closure comes from the ISO's store; no substituters, no channel.
        sh("nixos-install", "--system", SYSTEM, "--root", MNT, "--no-root-passwd", "--no-channel-copy", "--option", "substituters", "")
        step(st, "configuring")
    if st["state"] == "configuring":
        os.makedirs(f"{MNT}/etc/agentos", exist_ok=True)
        release = json.load(open(RELEASE)) if os.path.exists(RELEASE) else {}
        hw = {"formatVersion": 1, "installId": st["plan"]["installId"], "timezone": st["plan"]["timezone"], "disk": st["plan"]["identity"],
              "baseReleaseId": release.get("releaseId"), "baseClosurePath": SYSTEM}
        body = canon(hw)
        hw_hash = "sha256:" + hashlib.sha256(body.encode()).hexdigest()
        with open(f"{MNT}/etc/agentos/install.json", "w") as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(f"{MNT}/etc/agentos/install.json", 0o644)
        st["hardwareConfigHash"] = hw_hash
        step(st, "verifying")
    if st["state"] == "verifying":
        problems = []
        entries = os.listdir(f"{MNT}/boot/loader/entries") if os.path.isdir(f"{MNT}/boot/loader/entries") else []
        if not entries:
            problems.append("no boot entry on the ESP")
        if os.path.realpath(f"{MNT}/nix/var/nix/profiles/system") == "" or not os.path.exists(f"{MNT}{SYSTEM}"):
            problems.append("system closure missing on target")
        shadow = open(f"{MNT}/etc/shadow").read() if os.path.exists(f"{MNT}/etc/shadow") else ""
        for line in shadow.splitlines():
            f = line.split(":")
            if len(f) > 1 and f[1] not in ("!", "*", "!*", "") and not f[1].startswith("!"):
                problems.append(f"account {f[0]} has a password")
            if len(f) > 1 and f[1] == "":
                problems.append(f"account {f[0]} has an empty password")
        for bad in ["root/.ssh/authorized_keys", "etc/ssh/ssh_host_ed25519_key"]:
            if os.path.exists(f"{MNT}/{bad}"):
                problems.append(f"preinstalled ssh material at /{bad}")
        pol = f"{MNT}/etc/agentos/broker/policy.json"
        if os.path.exists(pol) and json.load(open(pol)).get("testMode"):
            problems.append("broker policy has testMode")
        if os.path.exists(f"{MNT}/var/lib/agentos-machine/machine.sqlite"):
            problems.append("machine identity already exists (must be created at first boot)")
        if problems:
            st["problems"] = problems
            save(st)
            raise Refuse("verification failed: " + "; ".join(problems))
        sh("sync")
        step(st, "installed")
    return {"state": "installed", "installId": st["plan"]["installId"], "hardwareConfigHash": st.get("hardwareConfigHash")}


def main():
    a = sys.argv[1:]
    cmd = a[0] if a else "status"
    args = {}
    i = 1
    while i < len(a):
        if a[i].startswith("--"):
            if i + 1 < len(a) and not a[i + 1].startswith("--"):
                args[a[i]] = a[i + 1]
                i += 2
                continue
            args[a[i]] = True
        i += 1
    try:
        if cmd == "inspect":
            out = {"disks": disks(), "medium": medium_identity()}
        elif cmd == "plan":
            out = cmd_plan(args)
        elif cmd == "confirm":
            out = cmd_confirm(args)
        elif cmd == "run":
            out = cmd_run(args)
        elif cmd == "status":
            out = load()
        else:
            raise Refuse("unknown command")
        print(json.dumps({"ok": True, **out}))
    except Refuse as e:
        st = load()
        st["lastError"] = str(e)
        if st.get("state") not in (None, "inspecting"):
            save(st)
        print(json.dumps({"ok": False, "error": str(e), "state": st.get("state")}))
        sys.exit(1)


if __name__ == "__main__":
    main()
