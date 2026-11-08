#!/usr/bin/env python3
"""AgentOS offline installer (spec §19.2–19.4, V1-U01/U02).

States: inspecting → plan_ready → confirmed → partitioning → copying → configuring → verifying → installed.
Failures keep the state and step in /run/agentos-install/state.json and, once the target is partitioned, in
EFI/agentos/install-state.json on the target's ESP, which survives a power cut (review F05). After a reboot from the
install medium `recover` reads it without writing anything; `recover --resume` adopts it only when the disk's stable
identity (serial or WWN; for a disk without either, model + size + the install id on its ESP and no second disk
carrying that id) still matches. major:minor numbers are never used as an identity across boots.

  agentos-install inspect                                  candidate disks (JSON)
  agentos-install plan --disk /dev/disk/by-id/X [--timezone Asia/Taipei] [--quick]
  agentos-install confirm --plan-hash H --serial SERIAL    the local user types the disk serial (or WWN) shown
  agentos-install run --passphrase-stdin                   partition → copy → configure → verify → installed
  agentos-install status
  agentos-install auto                                     the ISO's own console (tty1) at boot: install to the one
                                                           blank disk after a 10 s countdown any key cancels; stop
                                                           without writing on 0 or 2+ disks or a disk with data
  agentos-install recover --disk /dev/disk/by-id/X [--resume]   after a power cut: read the install state kept on
                                                           the target's ESP (read-only); --resume adopts it so `run`
                                                           continues (review F05)

For disks without a stable by-id name, auto prints a command-local AGENTOS_INSTALL_ALLOW_PATH=1 override for
read-only recovery inspection. Recheck the displayed device path after every reboot.

The plan binds WWN/serial, major:minor, size, the partition-table digest and the install-medium identity. Before the
first destructive write every value is read again; the install medium itself, a mounted/swap/held device, a
changed identity and a disk below 64 GiB are refused. After a crash `run` inspects the real GPT and the install id
on the ESP; it never re-formats a different disk with the same name. The system closure is copied from the ISO's
own store (no network). The LUKS passphrase is read from stdin only, never from argv, and is not written anywhere.
"""
import contextlib, fcntl, hashlib, importlib.util, json, os, re, shlex, subprocess, sys, time, types, uuid

_initializer_path = "@INITIALIZER@"
if _initializer_path.startswith("@"):
    _initializer_path = os.path.join(os.path.dirname(__file__), "initialization.py")
_initializer_spec = importlib.util.spec_from_file_location("agentos_initialization", _initializer_path)
initialization = importlib.util.module_from_spec(_initializer_spec)
_initializer_spec.loader.exec_module(initialization)

STATE_DIR = "/run/agentos-install"
STATE = f"{STATE_DIR}/state.json"
MIN_BYTES = 64 * 1024**3
SYSTEM = os.environ.get("AGENTOS_SYSTEM", "@SYSTEM@")  # base release toplevel (substituted at build time)
RELEASE = os.environ.get("AGENTOS_RELEASE_FILE", "@RELEASE@")
# The public template key (os/modules/template-disk.key). A quick install (--quick, and `auto`) opens LUKS with it like
# the qcow2 template does; the installed system's first boot (agentos-disk-rekey) asks the one password, replaces this
# slot and re-encrypts with a fresh volume key before anything is written, exactly as on a template disk.
TEMPLATE_KEY = os.environ.get("AGENTOS_TEMPLATE_KEY_FILE", "@TEMPLATE_KEY@")
MNT = "/mnt"
SUBVOLS = ["@root", "@nix", "@home", "@machine", "@broker", "@snapshots"]
MOUNTS = [("@nix", "nix"), ("@home", "home"), ("@machine", "var/lib/agentos-machine"), ("@broker", "var/lib/agentos-broker"), ("@snapshots", "var/lib/agentos-snapshots")]


class Refuse(Exception):
    pass


def progress(msg):
    """Progress lines go to stderr (stdout carries only the final JSON result)."""
    sys.stderr.write(f"agentos-install: {msg}\n")
    sys.stderr.flush()


# Every external command has a deadline, so a stuck tool fails the install naming itself instead of hanging it.
SH_TIMEOUT = int(os.environ.get("AGENTOS_INSTALL_CMD_TIMEOUT", "600"))
COPY_TIMEOUT = int(os.environ.get("AGENTOS_INSTALL_COPY_TIMEOUT", "5400"))
INSTALL_LOCK_FD = None


@contextlib.contextmanager
def installer_lock(writing):
    global INSTALL_LOCK_FD
    if not writing:
        yield
        return
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    previous = INSTALL_LOCK_FD
    fd = os.open(f"{STATE_DIR}/lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refuse("another installer or its disk tool is still running; nothing new was written") from None
        INSTALL_LOCK_FD = fd
        yield
    finally:
        os.close(fd)
        INSTALL_LOCK_FD = previous


def sh(*a, input=None, check=True, timeout=None, stream=False, env=None):
    t0 = time.time()
    lim = timeout or SH_TIMEOUT
    progress(f"run {' '.join(a[:3])}{' …' if len(a) > 3 else ''}")
    try:
        r = subprocess.run(list(a), input=input, stdout=subprocess.PIPE, stderr=None if stream else subprocess.PIPE, timeout=lim, env=env,
                           pass_fds=() if INSTALL_LOCK_FD is None else (INSTALL_LOCK_FD,))
    except subprocess.TimeoutExpired:
        progress(f"TIMEOUT {a[0]} after {lim}s")
        raise Refuse(f"{a[0]} did not finish within {lim}s")
    progress(f"done {a[0]} rc={r.returncode} in {time.time() - t0:.1f}s")
    if check and r.returncode != 0:
        err = (r.stderr or b"").decode(errors='replace').strip()[:400]
        raise Refuse(f"{a[0]} failed: {err or 'exit ' + str(r.returncode)}")
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
        if d["type"] != "disk" or d["path"].startswith(("/dev/zram", "/dev/loop", "/dev/sr", "/dev/fd")):
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
    if os.environ.get("AGENTOS_INSTALL_TEMPLATE_BUILD"):
        # the qcow2 build VM has no install medium; the boot-id fallback below made the plan hash in the template ESP's
        # install.json differ every build (build-repro 41145515019). One derived value serves both plan and recheck.
        return "sha256:" + hashlib.sha256(f"agentos-template:{SYSTEM}:medium".encode()).hexdigest()
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


STABLE = ["serial", "wwn", "sizeBytes", "model"]   # what may be compared across boots (never majMin)


def confirm_token(ident):
    """What the local user types to confirm the target: its serial, else its WWN; a disk with neither has no stable
    hardware identity, so the user types its exact size (the plan shows it) behind an explicit marker."""
    return ident["serial"] or ident["wwn"] or f"no-serial:{ident['sizeBytes']}"


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
    plan["confirmToken"] = confirm_token(plan["identity"])
    if "--template" in args:
        # the template is one image for many machines and must build bit for bit the same from the same inputs
        # (V1-O09): every identifier the installer draws itself is derived from the release toplevel instead
        plan["installId"] = tpl_uuid("install")
        # qcow2 template build only (os/packages/qcow2.nix): same layout and closure, LUKS opened by the public
        # template key that first boot replaces; no per-machine install record.
        if not os.environ.get("AGENTOS_INSTALL_TEMPLATE_BUILD"):
            raise Refuse("--template is only for the qcow2 image build")
        plan["template"] = True
        # review F01: only the template's LUKS partition is re-encrypted with a fresh volume key at first boot, so it
        # is kept small and grown to the whole disk afterwards (agentos-disk-rekey)
        gib = int(os.environ.get("AGENTOS_TEMPLATE_LUKS_GIB", "16"))
        if not 4 <= gib <= 60:
            raise Refuse("template LUKS size must be 4..60 GiB")
        plan["layout"] = dict(plan["layout"], luks2=f"{gib} GiB (template; grown to the disk at first boot)")
        plan["templateLuksGiB"] = gib
    elif "--quick" in args:
        # quick install from the ISO: a template-style disk (small LUKS behind the public template key) with this
        # machine's own random identifiers; the first boot asks the one password (see TEMPLATE_KEY)
        if not os.path.exists(TEMPLATE_KEY):
            raise Refuse("this install medium carries no template key; --quick is unavailable")
        gib = int(os.environ.get("AGENTOS_TEMPLATE_LUKS_GIB", "16"))
        if not 4 <= gib <= 60:
            raise Refuse("template LUKS size must be 4..60 GiB")
        plan["quick"] = True
        plan["layout"] = dict(plan["layout"], luks2=f"{gib} GiB (password set and grown to the disk at first boot)")
        plan["templateLuksGiB"] = gib
    if plan.get("quick") and os.path.dirname(disk) == "/dev/disk/by-id" and (d["serial"] or d["wwn"]):
        try:
            sector = int(sh("blockdev", "--getss", d["path"]).strip())
            plan["initialization"] = initialization.plan_spec(d, plan["templateLuksGiB"], sector)
        except (ValueError, TypeError):
            raise Refuse("unsupported new-install geometry; inspect with: " + init_hint(disk)) from None
    st = {"state": "plan_ready", "plan": plan, "planHash": phash(plan), "updatedAt": time.time()}
    save(st)
    return {"planHash": st["planHash"], "plan": plan, "confirmWith": f"type {plan['confirmToken']} (the disk serial, else its WWN, else no-serial:<size in bytes>)"}


def cmd_confirm(args):
    st = load()
    if st["state"] != "plan_ready":
        raise Refuse(f"state is {st['state']}")
    if args["--plan-hash"] != st["planHash"]:
        raise Refuse("plan hash does not match the plan on screen")
    want = st["plan"].get("confirmToken") or confirm_token(st["plan"]["identity"])
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


ESP_STATE = "EFI/agentos/install-state.json"


def esp_write_state(st):
    try:
        _esp_write_state(st)
    except (OSError, ValueError, KeyError, TypeError):
        raise Refuse("cannot durably persist the target ESP checkpoint") from None


def _esp_write_state(st):
    """Keep the install state on the target ESP from partitioning on (review F05): /run is gone after a power cut.
    No secret is in it (the passphrase never is). The template build keeps none (its ESP must be reproducible)."""
    if st["plan"].get("template"):
        return
    dev = os.path.realpath(st["plan"]["disk"])
    esp = part(dev, 1)
    if not os.path.exists(esp):
        raise Refuse("cannot persist checkpoint: target ESP is missing")
    body = json.dumps({"formatVersion": 1, "kind": "agentos-install-state", **{k: st[k] for k in st if k not in ("lastError",)}}, indent=1)
    mounted_here = subprocess.run(["mountpoint", "-q", f"{MNT}/boot"]).returncode == 0
    if mounted_here:
        source = sh("findmnt", "-n", "-o", "SOURCE", "--target", f"{MNT}/boot").strip()
        if os.path.realpath(source) != esp:
            raise Refuse("checkpoint mount is not the target ESP")
    root = f"{MNT}/boot" if mounted_here else f"{STATE_DIR}/esp"
    if not mounted_here:
        os.makedirs(root, exist_ok=True)
        if subprocess.run(["mount", esp, root], capture_output=True).returncode != 0:
            raise Refuse("cannot mount target ESP to persist checkpoint")
    try:
        os.makedirs(f"{root}/EFI/agentos", exist_ok=True)
        if st["plan"].get("initialization"):
            marker_path = f"{root}/EFI/agentos/install.json"
            if not os.path.exists(marker_path):
                with open(marker_path, "x") as marker:
                    json.dump(esp_marker(st), marker)
                    marker.flush()
                    os.fsync(marker.fileno())
            else:
                with open(marker_path) as stream:
                    marker = json.load(stream)
                if not isinstance(marker, dict):
                    raise Refuse("invalid initialization marker")
                if any(marker.get(key) != esp_marker(st)[key] for key in ("installId", "planHash")):
                    raise Refuse("foreign marker on target ESP")
        tmp = f"{root}/{ESP_STATE}.tmp"
        with open(tmp, "w") as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, f"{root}/{ESP_STATE}")
        for directory in (f"{root}/EFI/agentos", f"{root}/EFI", root):
            fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if not mounted_here and subprocess.run(["umount", root]).returncode != 0:
            raise Refuse("cannot flush/unmount target ESP checkpoint")


def step(st, name):
    progress(f"state {name}")
    st["state"] = name
    st["step"] = name
    st["updatedAt"] = time.time()
    save(st)
    if name in ("copying", "configuring", "verifying"):
        esp_write_state(st)
    if os.environ.get("AGENTOS_FAULT_POINT") == f"install.{name}":
        os.kill(os.getpid(), 9)


def tpl_uuid(what):
    """Deterministic identifiers for the qcow2 template build only (same toplevel → same GPT/ESP identifiers)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"agentos-template:{SYSTEM}:{what}"))


TPL_EPOCH = "1980-01-01 00:00:00"   # FAT's first representable time; every template ESP entry carries it


def normalize_template_esp(dev):
    """Rebuild the template's ESP so it is reproducible: same volume id and boot sector (mkfs --invariant), every
    directory and file written in sorted order by mtools under a fixed clock onto a zeroed partition (FAT stores creation and modification
    times the kernel driver would take from the build VM's clock), and no loader random seed (a seed shared by every
    clone of the template is not a seed; the booted machine writes its own)."""
    esp = part(dev, 1)
    src = "/run/agentos-install/esp-copy"
    sh("rm", "-rf", src)
    sh("mkdir", "-p", src)
    sh("cp", "-a", f"{MNT}/boot/.", src)
    sh("umount", f"{MNT}/boot")
    for seed in ("loader/random-seed",):
        if os.path.exists(f"{src}/{seed}"):
            os.remove(f"{src}/{seed}")
    volid = hashlib.sha256(f"agentos-template:{SYSTEM}:esp".encode()).hexdigest()[:8]
    # mkfs does not clear the data area: free clusters kept the first ESP's directory entries (build-VM clock) and
    # loader random seed, so two builds differed with the same files (build-repro 41164440050)
    sh("blkdiscard", "-z", esp)
    sh("mkfs.vfat", "--invariant", "-F", "32", "-n", "AGENTOS-ESP", "-i", volid, esp)
    env = dict(os.environ, MTOOLS_SKIP_CHECK="1", TZ="UTC")
    for root, dirs, files in sorted(os.walk(src)):
        dirs.sort()
        rel = os.path.relpath(root, src)
        if rel != ".":
            sh("faketime", "-f", TPL_EPOCH, "mmd", "-i", esp, "::/" + rel, env=env)
        for f in sorted(files):
            p = os.path.join(root, f)
            sh("touch", "-h", "-d", TPL_EPOCH + " UTC", p)
            dest = "::/" + (f if rel == "." else f"{rel}/{f}")
            sh("faketime", "-f", TPL_EPOCH, "mcopy", "-m", "-o", "-i", esp, p, dest, env=env)
    sh("rm", "-rf", src)


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


def init_protocol(st):
    ops = types.SimpleNamespace(sh=sh, find=find, disks=disks, phash=phash, SYSTEM=SYSTEM,
                                medium_identity=medium_identity, save=save, esp_write_state=esp_write_state,
                                check_init_esp=check_init_esp, wait_for=wait_for, progress=progress, kmsg=kmsg, time=time)
    return initialization.Initialization(st, ops)


def init_hint(disk):
    if os.path.dirname(disk) == "/dev/disk/by-id":
        return shlex.join(["sudo", "agentos-install", "recover", "--disk", disk])
    return shlex.join(["sudo", "env", "AGENTOS_INSTALL_ALLOW_PATH=1", "agentos-install", "recover", "--disk", disk])


INIT_ESP_RO = "/run/agentos-install/init-esp-ro"


def check_init_checkpoint(saved, st):
    if not isinstance(saved, dict):
        raise Refuse("invalid initialization ESP checkpoint")
    old, current = saved.get("initCheckpoint"), st.get("initCheckpoint")
    if not isinstance(old, dict) or not isinstance(current, dict):
        raise Refuse("missing initialization ESP checkpoint identity")
    try:
        initialization.decode(initialization.encode(old))
    except initialization.Unsafe:
        raise Refuse("invalid initialization ESP checkpoint") from None
    if old != current and (initialization.digest(old) != current.get("previous") or old["sequence"] + 1 != current["sequence"]):
        raise Refuse("ESP and raw initialization checkpoints disagree")
    if saved.get("planHash") != st["planHash"] or phash(saved["plan"]) != st["planHash"]:
        raise Refuse("ESP plan does not match initialization checkpoint")


def check_init_esp(st, esp):
    root = INIT_ESP_RO
    sh("mkdir", "-p", root)
    sh("mount", "-o", "ro", esp, root)
    try:
        allowed = {"EFI", "EFI/agentos", "EFI/agentos/install.json", ESP_STATE}
        for directory, dirs, files in os.walk(root):
            for name in dirs + files:
                rel = os.path.relpath(os.path.join(directory, name), root)
                if rel not in allowed:
                    raise Refuse("unknown data or torn checkpoint on initialization ESP")
        marker_path = f"{root}/EFI/agentos/install.json"
        if os.path.exists(marker_path):
            with open(marker_path) as stream:
                marker = json.load(stream)
            if not isinstance(marker, dict):
                raise Refuse("invalid initialization marker")
            if any(marker.get(key) != esp_marker(st)[key] for key in ("installId", "planHash")):
                raise Refuse("foreign initialization marker")
        state_path = f"{root}/{ESP_STATE}"
        if os.path.exists(state_path):
            if os.path.getsize(state_path) > 2 * initialization.SLOT_SIZE:
                raise Refuse("oversized initialization ESP checkpoint")
            with open(state_path) as stream:
                saved = json.load(stream)
            check_init_checkpoint(saved, st)
        elif st["initCheckpoint"]["phase"] not in ("esp-before", "esp-after"):
            raise Refuse("initialization ESP checkpoint disappeared")
    except (ValueError, KeyError, TypeError):
        raise Refuse("torn initialization ESP checkpoint") from None
    finally:
        sh("umount", root)


PARTITIONING_INTERRUPTED = (
    "installation was interrupted during partitioning; it is NOT a completed installation. "
    "Automatic resume is unsafe because LUKS or the filesystem may already be initialized. "
    "Keep the ISO attached. Use recover --disk <disk> to inspect without writing. "
    "Preserve any needed data before explicitly making and confirming a NEW destructive plan; "
    "run will not reformat this checkpoint automatically.")


def cmd_run(args):
    st = load()
    if st["state"] not in ("confirmed", "partitioning", "copying", "configuring", "verifying"):
        raise Refuse(f"state is {st['state']}; plan and confirm first")
    new_init = bool(st.get("plan", {}).get("initialization"))
    if st["state"] == "partitioning" and not new_init:
        raise Refuse(PARTITIONING_INTERRUPTED)
    if new_init and "--passphrase-stdin" in args:
        raise Refuse("version 1 quick initialization requires the public template key; omit --passphrase-stdin")
    if st["plan"].get("quick") and "--passphrase-stdin" not in args:
        with open(TEMPLATE_KEY, "rb") as f:
            pw = f.read().rstrip(b"\n")
    else:
        pw = sys.stdin.buffer.read().rstrip(b"\n") if "--passphrase-stdin" in args else b""
    if len(pw) < 8:
        raise Refuse("a LUKS passphrase of at least 8 characters is required on stdin")
    dev = os.path.realpath(st["plan"]["disk"])
    if new_init and st["state"] in ("confirmed", "partitioning"):
        fresh = st["state"] == "confirmed"
        if fresh:
            recheck(st)
        try:
            init_protocol(st).run(pw, fresh=fresh)
        except initialization.Unsafe as error:
            raise Refuse(f"initialization refused: {error}. Inspect with: {init_hint(st['plan']['disk'])}") from None
        step(st, "copying")
    elif st["state"] == "confirmed":
        recheck(st)
        step(st, "partitioning")
        sh("wipefs", "-a", dev)
        sh("sgdisk", "--zap-all", dev)
        ids = ["-U", tpl_uuid("disk"), "-u", f"1:{tpl_uuid('esp')}", "-u", f"2:{tpl_uuid('luks')}"] if st["plan"].get("template") else []
        small = st["plan"].get("template") or st["plan"].get("quick")
        luks_end = f"+{int(st['plan']['templateLuksGiB'])}GiB" if small else "0"
        sh("sgdisk", "-n1:1MiB:+2GiB", "-t1:ef00", "-c1:agentos-esp", f"-n2:0:{luks_end}", "-t2:8309", "-c2:agentos-luks", *ids, dev)
        sh("partprobe", dev, check=False)
        sh("udevadm", "settle")
        wait_for(part(dev, 1))
        st["gptLabelId"] = gpt_label_id(dev)
        save(st)
        sh("mkfs.vfat", "-F", "32", "-n", "AGENTOS-ESP", part(dev, 1))
        sh("mkdir", "-p", "/run/agentos-install/esp")
        sh("mount", part(dev, 1), "/run/agentos-install/esp")
        os.makedirs("/run/agentos-install/esp/EFI/agentos", exist_ok=True)
        with open("/run/agentos-install/esp/EFI/agentos/install.json", "w") as f:
            json.dump(esp_marker(st), f)
            f.flush()
            os.fsync(f.fileno())
        sh("umount", "/run/agentos-install/esp")
        esp_write_state(st)
        kdf = ["--pbkdf", "argon2id"]
        if st["plan"].get("template") or st["plan"].get("quick"):
            # the template key is public and first boot replaces this slot: no benchmark (fixed small cost) so the
            # build VM never spends its time or memory on it
            kdf += ["--pbkdf-force-iterations", "4", "--pbkdf-memory", "65536", "--pbkdf-parallel", "1"]
        sh("cryptsetup", "luksFormat", "--type", "luks2", "--batch-mode", *kdf, "--key-file=-", part(dev, 2), input=pw)
    else:
        if new_init:
            try:
                protocol = init_protocol(st)
                protocol.bind()
                if not protocol.gpt():
                    raise initialization.Unsafe("precommitted GPT is missing")
                spec = st["plan"]["initialization"]
                for path, kind, value in ((part(dev, 1), "vfat", spec["fat"][:4] + "-" + spec["fat"][4:]),
                                           (part(dev, 2), "crypto_LUKS", spec["luks"])):
                    actual = protocol.filesystem(path)
                    if actual.get("TYPE") != kind or actual.get("UUID", "").lower() != value:
                        raise initialization.Unsafe("copy target filesystem identity changed")
            except initialization.Unsafe as error:
                raise Refuse(f"initialization refused: {error}. Inspect with: {init_hint(st['plan']['disk'])}") from None
        if not resume_check(st):
            raise Refuse("resume refused: the disk does not carry this install's id (different disk or wiped); start a new plan")
    if not os.path.exists("/dev/mapper/agentos-root"):
        sh("cryptsetup", "open", "--key-file=-", part(dev, 2), "agentos-root", input=pw)
    pw = b"\0" * len(pw)
    if new_init:
        actual = init_protocol(st).filesystem("/dev/mapper/agentos-root")
        if actual.get("TYPE") != "btrfs" or actual.get("UUID", "").lower() != st["plan"]["initialization"]["btrfs"]:
            raise Refuse("copy target Btrfs identity changed; refusing to mount it")
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
        if new_init:
            try:
                checkpoint = initialization.read_journal(dev)
            except initialization.Unsafe as error:
                raise Refuse(f"payload copy refused: {error}. Inspect with: {init_hint(st['plan']['disk'])}") from None
            if not checkpoint or checkpoint["phase"] != "copying" or checkpoint["planHash"] != st["planHash"]:
                raise Refuse("payload copy refused: no durable initialization copying barrier")
        esp_write_state(st)
        # Offline: the closure comes from the ISO's store; no substituters, no channel.
        sh("nixos-install", "--system", SYSTEM, "--root", MNT, "--no-root-passwd", "--no-channel-copy", "--option", "substituters", "",
           timeout=COPY_TIMEOUT, stream=True)
        step(st, "configuring")
    if st["state"] == "configuring":
        os.makedirs(f"{MNT}/etc/agentos", exist_ok=True)
        release = json.load(open(RELEASE)) if os.path.exists(RELEASE) else {}
        tpl = bool(st["plan"].get("template"))
        hw = {"formatVersion": 1, "installId": None if tpl else st["plan"]["installId"], "timezone": st["plan"]["timezone"],
              "disk": None if tpl else st["plan"]["identity"], "template": tpl, "quick": bool(st["plan"].get("quick")),
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
        if st["plan"].get("template"):
            normalize_template_esp(dev)
        else:
            marker_path = f"{MNT}/boot/EFI/agentos/install.json"
            with open(marker_path + ".tmp", "w") as f:
                json.dump(dict(esp_marker(st), state="installed"), f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(marker_path + ".tmp", marker_path)
            fd = os.open(os.path.dirname(marker_path), os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            if os.path.exists(f"{MNT}/boot/{ESP_STATE}"):
                os.remove(f"{MNT}/boot/{ESP_STATE}")
        sh("sync")
        step(st, "installed")
    return {"state": "installed", "installId": st["plan"]["installId"], "hardwareConfigHash": st.get("hardwareConfigHash")}


def esp_read(dev):
    """Read-only look at a disk's ESP: (marker, state) or (None, None). Mounted ro; nothing is written."""
    esp = part(dev, 1)
    if not os.path.exists(esp):
        return None, None
    mp = f"/run/agentos-install/ro-{os.path.basename(dev)}"
    os.makedirs(mp, exist_ok=True)
    if subprocess.run(["mount", "-o", "ro", esp, mp], capture_output=True).returncode != 0:
        return None, None
    try:
        def rd(p):
            try:
                with open(f"{mp}/{p}") as stream:
                    value = json.load(stream)
                return value if isinstance(value, dict) else None
            except Exception:
                return None
        return rd("EFI/agentos/install.json"), rd(ESP_STATE)
    finally:
        subprocess.run(["umount", mp])


def gpt_label_id(dev):
    for line in sh("sfdisk", "--dump", dev, check=False).splitlines():
        if line.startswith("label-id:"):
            return line.split(":", 1)[1].strip()
    return ""


def cmd_recover(args):
    disk = args.get("--disk")
    if not disk:
        raise Refuse("recover needs --disk /dev/disk/by-id/…")
    if not disk.startswith("/dev/disk/by-id/") and not os.environ.get("AGENTOS_INSTALL_ALLOW_PATH"):
        raise Refuse("name the target by /dev/disk/by-id/…")
    cur = find(disk)
    try:
        journal = initialization.read_journal(cur["path"])
    except initialization.Unsafe as error:
        if "--resume" not in args:
            return {"recover": {"disk": cur["path"], "checkpointError": str(error)}, "readOnly": True, "automaticResume": False}
        raise Refuse(f"initialization refused: {error}; nothing was written. Inspect with: {init_hint(disk)}") from None
    if journal:
        try:
            return recover_initialization(args, disk, cur, journal)
        except (Refuse, initialization.Unsafe, OSError, ValueError, KeyError, TypeError) as error:
            raise Refuse(f"initialization refused: {error}. Inspect with: {init_hint(disk)}") from None
    marker, st = esp_read(cur["path"])
    found = {"disk": cur["path"], "marker": marker is not None, "state": (st or {}).get("state"), "installId": (marker or {}).get("installId")}
    if "--resume" not in args:
        return {"recover": found, "readOnly": True}
    if not marker or not st or st.get("kind") != "agentos-install-state":
        raise Refuse("no interrupted AgentOS install on this disk (no install state on its ESP); start a new plan")
    if st.get("state") == "partitioning":
        raise Refuse(PARTITIONING_INTERRUPTED)
    if st.get("state") not in ("copying", "configuring", "verifying"):
        raise Refuse(f"the install state on this disk is {st.get('state')}; nothing to resume")
    if marker.get("installId") != st["plan"]["installId"] or marker.get("planHash") != st.get("planHash"):
        raise Refuse("the ESP marker and the install state disagree; refusing")
    want = st["plan"]["identity"]
    now = identity(cur)
    for k in STABLE:
        if now[k] != want[k]:
            raise Refuse(f"this is not the planned disk ({k} differs); refusing")
    if not st.get("gptLabelId") or gpt_label_id(cur["path"]) != st["gptLabelId"]:
        raise Refuse("this disk's partition table is not the one this install wrote (GPT label id differs); refusing")
    # without serial/WWN the ESP install id is what tells same-model disks apart: it must be on exactly one disk
    carriers = []
    for d in disks():
        if d["path"] != cur["path"] and any(p.startswith(("mounted", "install medium", "held")) for p in d["problems"]):
            continue
        m, _ = esp_read(d["path"]) if d["path"] != cur["path"] else (marker, None)
        if m and m.get("installId") == marker["installId"]:
            carriers.append(d["path"])
    if carriers != [cur["path"]]:
        raise Refuse(f"install id {marker['installId']} is on {len(carriers)} disks ({', '.join(carriers)}); cannot tell which one to resume")
    bad = [p for p in cur["problems"] if not p.startswith("smaller")]
    if bad:
        raise Refuse(f"target refused now: {'; '.join(bad)}")
    if medium_identity() != st["plan"]["medium"]:
        raise Refuse("this is not the install medium the plan was made with")
    st.pop("kind", None)
    st.pop("formatVersion", None)
    st["plan"]["identity"] = dict(want, majMin=now["majMin"])
    st["plan"]["disk"] = disk   # this boot's numbers; never compared across boots
    st["recoveredAt"] = time.time()
    save(st)
    return {"recover": found, "readOnly": False, "state": st["state"], "next": "agentos-install run --passphrase-stdin"}


def recover_initialization(args, disk, cur, journal):
    st = initialization.adopt(journal)
    found = {"disk": cur["path"], "recordedTarget": st["plan"]["disk"], "state": st["state"], "phase": journal["phase"], "installId": st["plan"]["installId"]}
    marker, esp_state = esp_read(cur["path"]) if journal["phase"] == "copying" else (None, None)
    completed = marker and marker.get("state") == "installed" and marker.get("planHash") == st["planHash"] and marker.get("installId") == st["plan"]["installId"]
    if completed:
        if "--resume" in args:
            raise Refuse("this installation is complete; nothing to resume")
        return {"recover": dict(found, state="installed"), "readOnly": True}
    if "--resume" not in args:
        return {"recover": found, "readOnly": True}
    if disk != st["plan"]["disk"]:
        raise Refuse("resume requires the checkpoint's stable by-id name; inspect the recorded plan")
    try:
        init_protocol(st).bind()
    except initialization.Unsafe as error:
        raise Refuse(f"initialization refused: {error}") from None
    if journal["phase"] == "copying":
        if not esp_state:
            raise Refuse("copying checkpoint is missing from the ESP; refusing")
        try:
            check_init_checkpoint(esp_state, st)
        except (ValueError, KeyError, TypeError):
            raise Refuse("invalid initialization ESP checkpoint") from None
    save(st)
    return {"recover": found, "readOnly": False, "state": st["state"], "next": "sudo agentos-install run"}


# ---- auto: the ISO's console at boot (os/flake.nix, agentos-auto-install.service on tty1) ----
# Output is for a person at the VM's screen: plain ASCII (the VT font has no CJK glyphs), no JSON.

def say(msg=""):
    print(msg, flush=True)
    logger(msg)


def logger(msg):
    if msg:
        subprocess.run(["logger", "-t", "agentos-auto-install", msg], check=False)


def kmsg(msg):
    """One line on the kernel console too (a serial-console boot shows it; tests wait for these)."""
    try:
        with open("/dev/kmsg", "w") as f:
            f.write(f"<2>agentos-auto-install: {msg}\n")
    except OSError:
        pass


def gib(n):
    return f"{n / 1024**3:.0f} GiB"


def disk_has_data(d):
    """Only a complete zero scan proves blankness. Unknown, unreadable, or short reads refuse auto."""
    if d["partitions"]:
        return True
    if subprocess.run(["blkid", "-p", d["path"]], capture_output=True).returncode != 2:
        return True
    chunk = 8 * 1024**2
    zeros = bytes(chunk)
    remaining = d["sizeBytes"]
    if remaining <= 0:
        return True
    progress(f"checking all {remaining} bytes of {d['path']} for existing data")
    try:
        with open(d["path"], "rb", buffering=0) as f:
            while remaining:
                n = min(chunk, remaining)
                data = f.read(n)
                if len(data) != n or data != zeros[:n]:
                    return True
                remaining -= n
    except OSError:
        return True
    return False


def countdown(seconds):
    """True when it ran out; False when a key was pressed. Without a keyboard tty it cannot be cancelled."""
    import select, termios, tty
    fd = sys.stdin.fileno()
    interactive = os.isatty(fd)
    old = None
    if interactive:
        old = termios.tcgetattr(fd)
        tty.setcbreak(fd)
        termios.tcflush(fd, termios.TCIFLUSH)   # keys typed during boot do not count
    try:
        for i in range(seconds, 0, -1):
            sys.stdout.write(f"\r  Installing in {i:2d} s.  Press any key to cancel. ")
            sys.stdout.flush()
            if interactive:
                if select.select([fd], [], [], 1)[0]:
                    os.read(fd, 64)
                    sys.stdout.write("\n")
                    return False
            else:
                time.sleep(1)
        sys.stdout.write("\n")
        return True
    finally:
        if old is not None:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


MANUAL = ["To install by hand, use the shell on this screen (press Enter):",
          "  sudo agentos-install inspect",
          "  sudo agentos-install plan --disk /dev/disk/by-id/<disk> --quick",
          "  sudo agentos-install confirm --plan-hash <hash> --serial <token>",
          "  sudo agentos-install run",
          "Or power off, leave exactly one empty disk of at least 64 GB attached, and start again."]


def ensure_firmware_entry(dev):
    loader = r"\EFI\systemd\systemd-bootx64.efi"
    guid = sh("blkid", "-s", "PARTUUID", "-o", "value", part(dev, 1)).strip().lower()
    try:
        uuid.UUID(guid)
    except ValueError:
        raise Refuse("cannot identify target ESP GUID; firmware entries were not changed")
    listing = subprocess.run(["efibootmgr", "-v"], capture_output=True)
    if listing.returncode != 0:
        raise Refuse("cannot read firmware entries; firmware entries were not changed")
    output = listing.stdout.decode(errors="replace")
    for line in output.splitlines():
        entry = re.match(r"Boot([0-9A-Fa-f]{4})\*?\s", line)
        device = re.search(r"HD\(1,GPT,([0-9a-f-]+),[^)]*\)/File\(([^)]*)\)", line, re.I)
        if not entry or not device or device[1].lower() != guid or device[2].replace("/", "\\").lower() != loader.lower():
            continue
        boot = entry[1].upper()
        sh("efibootmgr", "-b", boot, "-a")
        order = re.search(r"^BootOrder:\s*([0-9A-Fa-f,]+)", output, re.M)
        if not order:
            raise Refuse("firmware BootOrder unavailable; existing entry was activated but not reordered")
        rest = [x.upper() for x in order[1].split(",") if x.upper() != boot]
        sh("efibootmgr", "-o", ",".join([boot] + rest))
        return "updated"
    sh("efibootmgr", "-q", "-c", "-d", dev, "-p", "1", "-L", "AgentOS", "-l", loader)
    return "created"


def cmd_auto(args):
    with open("/proc/cmdline") as f:
        off = "agentos.autoinstall=0" in f.read().split()
    if off:
        logger("disabled on the kernel command line")
        return 0
    say("")
    say("AgentOS installer")
    say("=================")
    ds = [d for d in disks() if "install medium" not in d["problems"]]
    if not ds:
        say("No disk to install to. Add a virtual disk of at least 64 GB to this VM and start it again.")
        kmsg("stopped: no disk")
        return 1
    if len(ds) > 1:
        say("More than one disk is attached, so nothing is installed automatically and nothing was changed:")
        for d in ds:
            say(f"  {d['path']}  {gib(d['sizeBytes'])}  {d['model'] or ''}")
        for line in MANUAL:
            say(line)
        kmsg(f"stopped: {len(ds)} disks")
        return 1
    d = ds[0]
    journal = None
    try:
        journal = initialization.read_journal(d["path"])
        if journal:
            target = journal["plan"]["disk"]
            if os.path.realpath(target) != d["path"]:
                raise Refuse("the checkpoint's by-id name resolves to a different disk")
            init_protocol(initialization.adopt(journal)).bind()
            if journal["phase"] == "copying":
                marker, _ = esp_read(d["path"])
                if marker and marker.get("state") == "installed" and marker.get("planHash") == journal["planHash"] and marker.get("installId") == journal["plan"]["installId"]:
                    say(f"AgentOS is already installed on {d['path']}. Nothing was changed.")
                    say("Disconnect this ISO from the VM's CD/DVD drive and restart the VM to start AgentOS.")
                    kmsg("stopped: AgentOS already installed")
                    return 0
                raise Refuse("payload copying may have started; inspect and explicitly recover --resume")
            say(f"An interrupted new AgentOS initialization was found on {d['path']}; verifying its precommitted identities.")
            cmd_recover({"--disk": target, "--resume": True})
            kmsg("resuming initialization")
            result = cmd_run({})
            return finish_auto(args, target, result)
    except (initialization.Unsafe, Refuse) as error:
        say(f"Initialization stopped without a new destructive plan: {error}")
        target = "/dev/disk/by-id/" + sorted(d["byId"])[0] if d["byId"] else d["path"]
        say("Inspect without writing: " + init_hint(target))
        kmsg("stopped: initialization proof unavailable")
        return 1
    if "agentos-luks" in d["partitions"]:
        marker, state = esp_read(d["path"])
        if marker and marker.get("state") == "installed" and marker.get("installId") and marker.get("planHash"):
            say(f"AgentOS is already installed on {d['path']}. Nothing was changed.")
            say("Disconnect this ISO from the VM's CD/DVD drive and restart the VM to start AgentOS.")
            kmsg("stopped: AgentOS already installed")
            return 0
        say(f"AgentOS partitions found on {d['path']}, but a completed installation is not proven. Nothing was changed.")
        if state and state.get("state") == "partitioning":
            say(PARTITIONING_INTERRUPTED)
        else:
            say("Keep the ISO attached. Inspect the interrupted or existing installation with:")
            ids = sorted(d["byId"], key=lambda name: name.startswith("wwn-"))
            if ids:
                command = ["sudo", "agentos-install", "recover", "--disk", "/dev/disk/by-id/" + ids[0]]
            else:
                say("No stable by-id name is available. This command allows the displayed path for read-only inspection.")
                say("Device paths can change after reboot. Verify the target again before reusing this command.")
                command = ["sudo", "env", "AGENTOS_INSTALL_ALLOW_PATH=1", "agentos-install", "recover", "--disk", d["path"]]
            say("  " + shlex.join(command))
            say("For copying/configuring/verifying checkpoints, recover --resume can adopt the saved state.")
        kmsg("stopped: AgentOS install incomplete or unverified")
        return 1
    if d["problems"]:
        say(f"The disk {d['path']} ({gib(d['sizeBytes'])}) cannot be used: {'; '.join(d['problems'])}.")
        if any(p.startswith("smaller") for p in d["problems"]):
            say("AgentOS needs a disk of at least 64 GB. Enlarge the VM's disk and start again.")
        kmsg("stopped: disk refused")
        return 1
    if disk_has_data(d):
        say(f"The disk {d['path']} ({gib(d['sizeBytes'])}) is not empty, so it is not erased automatically.")
        say("Nothing was changed.")
        for line in MANUAL:
            say(line)
        kmsg("stopped: disk has data")
        return 1
    say(f"AgentOS will be installed on the empty disk {d['path']} ({gib(d['sizeBytes'])} {d['model'] or ''}).")
    say("After the install the VM restarts; on its first start you choose one password, and that is all.")
    say("")
    kmsg("countdown")
    if not countdown(10):
        say("Cancelled. Nothing was changed.")
        for line in MANUAL:
            say(line)
        kmsg("cancelled")
        return 1
    current = [x for x in disks() if "install medium" not in x["problems"]]
    if (len(current) != 1 or current[0]["path"] != d["path"] or identity(current[0]) != identity(d)
            or current[0]["problems"] or disk_has_data(current[0])):
        say("The target changed or is no longer provably empty after the countdown. Nothing was changed.")
        kmsg("stopped: target changed after countdown")
        return 1
    ids = [x for x in d["byId"] if not x.startswith("wwn-")] + [x for x in d["byId"] if x.startswith("wwn-")]
    if ids:
        target = "/dev/disk/by-id/" + ids[0]
    else:
        os.environ["AGENTOS_INSTALL_ALLOW_PATH"] = "1"   # e.g. a SCSI disk with no serial: no by-id name exists
        target = d["path"]
    tz = os.environ.get("AGENTOS_INSTALL_TIMEZONE", "UTC")
    try:
        p = cmd_plan({"--disk": target, "--quick": True, "--timezone": tz})
        if p["plan"]["identity"] != identity(d):
            raise Refuse("the target changed while planning; nothing was written")
        cmd_confirm({"--plan-hash": p["planHash"], "--serial": p["plan"]["confirmToken"]})
        say("Installing. This takes a few minutes; the progress lines below are normal.")
        kmsg("installing")
        r = cmd_run({})
    except Refuse as e:
        say("")
        say(f"The install stopped: {e}")
        for line in MANUAL:
            say(line)
        kmsg(f"failed: {e}")
        return 1
    return finish_auto(args, target, r)


def finish_auto(args, target, r):
    loader = os.path.exists(f"{MNT}/boot/EFI/systemd/systemd-bootx64.efi")
    subprocess.run(["sync"], check=False)
    subprocess.run(["umount", "-R", MNT], check=False)
    subprocess.run(["cryptsetup", "close", "agentos-root"], check=False)
    # Start from the disk next time even with the ISO still in the drive: a firmware boot entry for the installed
    # loader, first in the boot order (efibootmgr puts a new entry first). The CD is not ejected: the running
    # installer's own store is on it. Without EFI variables the firmware's own order decides; booting this ISO
    # again then stops at "already installed".
    if loader and os.path.isdir("/sys/firmware/efi/efivars"):
        dev = os.path.realpath(target)
        try:
            logger(f"firmware boot entry: {ensure_firmware_entry(dev)}")
        except Refuse as e:
            say(f"Firmware boot entry unchanged or incomplete: {e}")
    say("")
    say("AgentOS is installed. Restarting in 5 s.")
    say("If the VM starts this installer again, disconnect the ISO from its CD/DVD drive.")
    kmsg(f"installed {r.get('installId')}")
    time.sleep(5)
    if "--no-reboot" not in args:
        subprocess.run(["systemctl", "reboot"], check=False)
    return 0


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
        with installer_lock(cmd in ("auto", "plan", "confirm", "run") or (cmd == "recover" and "--resume" in args)):
            dispatch(cmd, args)
    except Refuse as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)


def dispatch(cmd, args):
    if cmd == "auto":
        sys.exit(cmd_auto(args))
    try:
        if cmd == "inspect":
            out = {"disks": disks(), "medium": medium_identity()}
        elif cmd == "plan":
            out = cmd_plan(args)
        elif cmd == "confirm":
            out = cmd_confirm(args)
        elif cmd == "run":
            out = cmd_run(args)
        elif cmd == "recover":
            out = cmd_recover(args)
        elif cmd == "status":
            out = load()
        else:
            raise Refuse("unknown command")
        print(json.dumps({"ok": True, **out}))
    except Refuse as e:
        st = load()
        message = str(e)
        if st.get("plan", {}).get("initialization") and "Inspect with:" not in message:
            message += ". Inspect with: " + init_hint(st["plan"]["disk"])
        st["lastError"] = message
        if st.get("state") not in (None, "inspecting"):
            save(st)
        print(json.dumps({"ok": False, "error": message, "state": st.get("state")}))
        sys.exit(1)


if __name__ == "__main__":
    main()
