import json, os, re, shutil, subprocess, time
import contextlib

# ---- the clean UEFI VM: one blank 64 GiB virtio disk with a serial number, no network ----
tmp = os.environ.get("TMPDIR", "/tmp")
append = open(os.path.join(ISO_DIR, "append")).read().strip()
print("ISO serial entry:", open(os.path.join(ISO_DIR, "kernel.path")).read().strip(), append)

def clean_disk(name, serial):
    disk = os.path.join(tmp, name + ".qcow2")
    subprocess.run([QEMU_IMG, "create", "-f", "qcow2", disk, "64G"], check=True)
    vars_ = os.path.join(tmp, name + "-vars.fd")
    shutil.copy(OVMF_VARS, vars_)
    os.chmod(vars_, 0o644)
    return (f"{QEMU} -m 3072 -smp 2 -nic none -no-reboot "
            f"-drive if=pflash,format=raw,unit=0,readonly=on,file={OVMF_CODE} -drive if=pflash,format=raw,unit=1,file={vars_} "
            f"-drive file={disk},if=none,id=t,format=qcow2 -device virtio-blk-pci,drive=t,serial={serial} "
            "-vga none -device virtio-gpu-pci -device qemu-xhci,id=xhci -device usb-tablet,bus=xhci.0")

def iso_command(base):
    # Use the ISO initrd's virtio-scsi optical path, not an implicit legacy IDE controller.
    return base + (f" -device virtio-scsi-pci,id=iso-scsi -drive file={ISO_DIR}/agentos.iso,if=none,id=cd,format=raw,media=cdrom,readonly=on "
                   f"-device scsi-cd,drive=cd,bus=iso-scsi.0 -kernel {ISO_DIR}/bzImage -initrd {ISO_DIR}/initrd -append '{append}'")

common = clean_disk("source", "AGENTOS-T1")
iso_cmd = iso_command(common)
# A non-bootable removable data carrier: test backup, operator script and release metadata, NOT another OS.
carry = os.path.join(tmp, "carry.img")
with open(carry, "wb") as f:
    f.truncate(128 * 1024**2)
subprocess.run([MKFS_VFAT, "-n", "AOS-CARRY", carry], check=True)
subprocess.run([MCOPY, "-i", carry, "-s", *[os.path.join(DRILL_INPUTS, x) for x in sorted(os.listdir(DRILL_INPUTS))], "::/"], check=True)
carry_options = f" -drive file={carry},if=none,id=carry,format=raw -device usb-storage,drive=carry,bus=xhci.0,removable=on,serial=AOS-CARRY"
PASS = "correct horse battery"
TARGET = "/dev/disk/by-id/virtio-AGENTOS-T1"

extra = []

@contextlib.contextmanager
def kill_on_fail():
    # a failed check must not leave a create_machine() VM running until the CI step deadline
    try:
        yield
    except BaseException:
        for i, x in enumerate(extra):
            if x.process is not None and x.process.poll() is None:
                try:
                    log_failure_screen(x, f"iso-failure-{i}")
                except Exception as e:
                    print("failure screenshot unavailable:", e)
            if x.booted:
                x.crash()
        raise

def wait_console(m, pattern, timeout=900, start=0):
    """Read the live log, not one queued line per one-second driver retry (a large install log took 3093 s)."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        log = m.get_console_log()
        if re.search(pattern, log[start:]):
            return log
        if m.process is not None and m.process.poll() is not None:
            raise AssertionError("the VM exited while waiting for console pattern " + pattern)
        time.sleep(0.2)
    raise AssertionError(f"console never showed {pattern!r}; tail: {m.get_console_log()[-2000:]}")


def run(m, cmd, tag, timeout=900):
    """Run a root shell command on the ISO's serial console; returns (rc, console log)."""
    start = len(m.get_console_log())
    m.send_console(f"{cmd}; echo __{tag}_RC=$?__\n")
    log = wait_console(m, f"__{tag}_RC=[0-9]+__", timeout=timeout, start=start)
    return int(re.findall(f"__{tag}_RC=([0-9]+)__", log)[-1]), log

# Installed-disk evidence reads (m19 41314769878 printed "EV-shellStarted=0 0": `|| echo 0` turned a failure into a 0).
# grep -c exits 1 with "0" on no match; that is the only way to read 0. Any other failing pipeline stage, a missing or
# non-numeric value, or a second value fails the drill.
def evidence_cmd(k, c):
    return f"res=$({c}; printf ' PS=%s' \"${{PIPESTATUS[*]}}\"); echo EV-{k}=$res END"

def evidence_value(k, log):
    hits = re.findall(f"EV-{k}=(\\S*) PS=([0-9 ]+) END", log)
    assert len(hits) == 1, (k, hits, log[-2000:])
    value, ps = hits[0]
    status = [int(x) for x in ps.split()]
    assert value.isdigit(), (k, "no count read", value, status, log[-2000:])
    assert all(x == 0 for x in status[:-1]) and (status[-1] == 0 or (status[-1] == 1 and value == "0")), (k, "command failed", value, status, log[-2000:])
    return int(value)

# The Shell, Sway and the session agent write nothing to the journal (their output goes to greetd's tty; m20 41314773240
# journals none for alice's session), so no journal pattern can show the Shell ran. Alice records the live process
# count herself, on her console while the Shell is on the output; the evidence boot reads it back from the disk.
SHELL_PROBE = 'logger -t agentos-m19-probe "agentos-shell processes for alice: $(pgrep -c -u alice -f bin/agentos-shell)"'

def last_json(log, key):
    hits = re.findall(key + r":(\{.*\})", log)
    assert hits, f"no {key} line on the console"
    return json.loads(hits[-1])

def console_prompt(m, pattern, timeout):
    # The console reader delivers complete lines, but a shell prompt has no trailing newline (m19 41217257273).
    # Blank Enter is harmless on this autologin installer and flushes the prompt; do not wait 15 minutes for it.
    end = time.time() + timeout
    start = len(m.get_console_log())
    while time.time() < end:
        m.send_console("\n")
        try:
            wait_console(m, pattern, timeout=10, start=start)
            return
        except Exception:
            if m.process is not None and m.process.poll() is not None:
                raise
    raise AssertionError(f"installer prompt {pattern!r} did not appear")

def iso_root_shell(m):
    # the installer's own autologin on the serial console it was booted with
    console_prompt(m, r"nixos@nixos", timeout=900)
    m.send_console("sudo -i\n")
    console_prompt(m, r"root@nixos", timeout=120)
    m.send_console("stty -echo; export TERM=dumb\n")
    time.sleep(1)

def powered_off(m, timeout=300):
    end = time.time() + timeout
    while time.time() < end:
        if m.process is None or m.process.poll() is not None:
            m.wait_for_shutdown()
            return True
        time.sleep(2)
    return False

# ---- pixels of the real output (same helpers as m5) ----
def shot(m, name):
    m.screenshot(name)
    raw = subprocess.run([PNGTOPNM, os.path.join(m.out_dir, name + ".png")], check=True, capture_output=True).stdout
    return pnm_rgb(raw)

def px(img, x, y):
    w, _, d = img
    k = (y * w + x) * 3
    return tuple(d[k:k + 3])

def near(c, ref, tol=8):
    return all(abs(a - b) <= tol for a, b in zip(c, ref))

def hexc(c):
    return "#%02x%02x%02x" % c

TOPBAR, NAVBG, PRIMARY = (0xff, 0xff, 0xff), (0xff, 0xff, 0xff), (0xef, 0xf6, 0xff)

def nav_buttons(img):
    """Find the 12 sidebar tabs by their full-height navigation rails, excluding toolbar controls."""
    w, h, _ = img
    # ATab's 3 px rail is muted (#94a3b8), accent (#2563eb) for the current page.
    # x=17 crosses the rail but lies outside label/icon text and the workspace selector's border.
    rows = [y for y in range(h) if near(px(img, 3, y), NAVBG) and (
        near(px(img, 17, y), (0x94, 0xa3, 0xb8), 3)
        or near(px(img, 17, y), (0x25, 0x63, 0xeb), 3))]
    lines = []
    for r in rows:
        if lines and r - lines[-1][1] <= 1: lines[-1][1] = r
        else: lines.append([r, r])
    return [(top, bot) for top, bot in lines if 18 <= bot - top <= 80]


def shell_frame(m, name, timeout=180):
    end = time.time() + timeout
    while True:
        img = shot(m, name)
        w, h, _ = img
        ok = near(px(img, w - 4, 3), TOPBAR) and near(px(img, 3, h - 6), NAVBG) and len(nav_buttons(img)) == 12
        if ok or time.time() > end:
            print(name, "top", hexc(px(img, w - 4, 3)), "nav", hexc(px(img, 3, h - 6)), "buttons", nav_buttons(img))
            assert ok, "the Shell frame is not on the output"
            return img
        time.sleep(4)

def click(m, x, y, w, h):
    qsend = getattr(m.qmp_client, "send")
    qsend("input-send-event", {"events": [{"type": "abs", "data": {"axis": "x", "value": round(x * 32767 / (w - 1))}}, {"type": "abs", "data": {"axis": "y", "value": round(y * 32767 / (h - 1))}}]})
    time.sleep(0.3)
    qsend("input-send-event", {"events": [{"type": "btn", "data": {"down": True, "button": "left"}}]})
    time.sleep(0.15)
    qsend("input-send-event", {"events": [{"type": "btn", "data": {"down": False, "button": "left"}}]})

def screen_text(m):
    """Preserve the console bitmap font: stock resample/blur loses exact prompt letters (41253715864)."""
    import shutil, tempfile
    m.screenshot("ocr")
    magick = shutil.which("magick") or shutil.which("convert")
    assert magick, "ImageMagick is unavailable"
    try:
        # The pinned driver has a minimal ImageMagick: use its supported PNM path, not optional PNG codecs.
        raw = subprocess.run([PNGTOPNM, os.path.join(m.out_dir, "ocr.png")], check=True,
                             capture_output=True, timeout=20).stdout
        w, h, rgb = pnm_rgb(raw)
        if rgb == rgb[:3] * (w * h):  # a uniform boot frame contains no text; -trim can warn/fail on it
            return [""] * 6
        with tempfile.TemporaryDirectory(prefix="agentos-ocr-") as d:
            zoom = os.path.join(d, "zoom.pgm")
            neg = os.path.join(d, "neg.pgm")
            subprocess.run([magick, "pnm:-", "-bordercolor", "black", "-border", "1", "-trim", "+repage",
                            "-sample", "300%", "-border", "8", "-depth", "8", zoom], input=raw,
                           check=True, capture_output=True, timeout=20)
            subprocess.run([magick, zoom, "-negate", neg], check=True, capture_output=True, timeout=20)
            env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
            return [subprocess.run(["tesseract", pgm, "stdout", "--oem", "3", "--psm", str(mode),
                                    "-c", "debug_file=/dev/null"], check=True, capture_output=True,
                                   encoding="utf-8", timeout=20, env=env).stdout
                    for pgm in (zoom, neg) for mode in (6, 11, 3)]
    except subprocess.CalledProcessError as e:
        detail = e.stderr.decode("utf-8", errors="replace") if isinstance(e.stderr, bytes) else e.stderr
        raise RuntimeError(f"OCR command failed: {e.cmd}: {detail}") from e


def wait_screen(m, regex, timeout=900, failure_regex=None, before_poll=None, stable_polls=1):
    """Log actual OCR changes as they happen, preserving the driver's wall-clock deadline semantics."""
    assert stable_polls >= 1
    end, previous, matched = time.monotonic() + timeout, None, 0
    while time.monotonic() < end:
        if callable(before_poll):
            before_poll()
        variants = screen_text(m)
        if variants != previous:
            print("OCR", regex, json.dumps(variants, ensure_ascii=False)[:6000], flush=True)
            previous = variants
        if failure_regex and any(re.search(failure_regex, text) is not None for text in variants):
            raise AssertionError(f"operator failed while waiting for {regex!r}; OCR: {variants!r}")
        matched = matched + 1 if any(re.search(regex, text) is not None for text in variants) else 0
        if matched >= stable_polls:
            return
        if m.process is not None and m.process.poll() is not None:
            raise AssertionError("the VM exited while waiting for " + regex)
        time.sleep(min(2, max(0, end - time.monotonic())))
    raise AssertionError(f"screen did not show {regex!r}; last OCR: {previous!r}")


def keyed(m, text):
    """Do not outpace QEMU's default 100-ms key hold, including consecutive identical keys."""
    names = {"-": "minus", " ": "spc", "\n": "ret"}
    for ch in text:
        m.send_key(names.get(ch, ("shift-" + ch.lower()) if ch.isupper() else ch), delay=0.15)

def install_iso(cmd, name, serial):
    iso = create_machine(iso_command(cmd), name=name)
    extra.append(iso)
    iso.start()
    iso_root_shell(iso)
    rc, log = run(iso, "test -e /etc/agentos-install-medium.json && ! ip route | grep -q default && echo MEDIUM-OK", "env")
    assert rc == 0 and "MEDIUM-OK" in log, log[-2000:]
    rc, log = run(iso, "agentos-install inspect | tail -n1 | sed 's/^/INSPECT:/'", "inspect")
    disks = {d["path"]: d for d in last_json(log, "INSPECT")["disks"]}
    print("inspect", json.dumps(disks)[:1500])
    tgt = [d for d in disks.values() if d.get("serial") == serial]
    assert len(tgt) == 1 and not tgt[0]["problems"], disks
    rc, log = run(iso, f"agentos-install plan --disk /dev/disk/by-id/virtio-{serial} --timezone Asia/Taipei | tail -n1 | sed 's/^/PLAN:/'", "plan")
    p = last_json(log, "PLAN")
    assert p["ok"], p
    rc, log = run(iso, f"agentos-install confirm --plan-hash {p['planHash']} --serial {p['plan']['confirmToken']} | tail -n1 | sed 's/^/CONFIRM:/'", "confirm")
    assert last_json(log, "CONFIRM")["ok"], log[-1500:]
    rc, log = run(iso, f"printf '%s' '{PASS}' | agentos-install run --passphrase-stdin | tail -n1 | sed 's/^/RUN:/'", "run", timeout=3600)
    v = last_json(log, "RUN")
    assert v["ok"] and v["state"] == "installed", v
    run(iso, "sync; umount -R /mnt; cryptsetup close agentos-root; true", "umount")
    iso.send_console("poweroff\n")
    assert powered_off(iso), "the ISO system did not power off"

with subtest("install from the ISO alone: its own kernel/initrd/command line, offline, to a blank disk by serial (U01, review F11)"), kill_on_fail():
    install_iso(common, "iso", "AGENTOS-T1")

# Operator commands are typed only into a normal PAM-authenticated tty. No execute(), test agent, root shell,
# direct SQLite write or service override exists on either installed system.
def operator_login(m, user, pw):
    # greetd may reclaim VT1 after its first frame. Reselect only until the actual getty is visible;
    # no username or secret is typed while the greeter/transition still owns the output.
    wait_screen(m, r"login:", timeout=180, before_poll=lambda: m.send_key("ctrl-alt-f2"), stable_polls=2)
    m.send_chars(user + "\n", delay=0.08)
    wait_screen(m, r"[Pp]assword:", timeout=120)
    keyed(m, pw + "\n")
    wait_screen(m, user + r"@", timeout=120)

def operator_phase(m, user, phase, marker, from_media=False, timeout=1200):
    script = f"/home/{user}/drill/drill.mjs"
    mount = ""
    if from_media:
        mount = "udisksctl mount -b /dev/disk/by-label/AOS-CARRY --no-user-interaction && "
        script = f"/run/media/{user}/AOS-CARRY/drill.mjs"
    m.send_chars(f"{mount}{NODE} {script} {phase} {int(time.time() * 1000)}\n", delay=0.03)
    # OCR may segment VERIFIED as VERIF IED. Match the same ASCII characters on one whole line:
    # horizontal layout whitespace is allowed, but not changed/missing characters, prefixes or line joining.
    def line_pattern(value):
        return r"(?m)^[ \t]*" + r"[ \t]*".join(re.escape(ch) for ch in value) + r"[ \t]*$"
    wait_screen(m, line_pattern(marker), timeout=timeout, failure_regex=line_pattern("FAIL-DRILL-FAILED"))
    shot(m, "operator-" + user + "-" + phase)

def operator_reboot(m, user, pw):
    m.send_chars(f"{NODE} /home/{user}/drill/drill.mjs reboot\n", delay=0.03)
    assert m.process is not None, "operator reboot has no QEMU process"
    assert m.process.wait(timeout=180) == 0, "operator reboot QEMU exited unsuccessfully"
    m.wait_for_shutdown()  # pinned driver has no timeout argument; finalize only after the bounded wait
    m.start()
    wait_screen(m, r"(?i)passphrase", timeout=900)
    keyed(m, PASS + "\n")
    wait_screen(m, r"(?i)(Welcome back|Login)", timeout=600)  # do NOT log in graphically: the trial must fail the Wayland health gate
    operator_login(m, user, pw)

with subtest("the installed disk alone: first unlock, first-boot administrator on the console, ReGreet login, the Shell on the output and driven by clicks (U01, D01, review F11)"), kill_on_fail():
    target = create_machine(common + carry_options, name="installed")
    extra.append(target)
    target.start()
    wait_screen(target, r"(?i)passphrase", timeout=900)
    time.sleep(2)
    keyed(target, PASS + "\n")
    wait_screen(target, r"administrator login", timeout=900)
    shot(target, "first-setup")
    keyed(target, "alice\n")
    wait_screen(target, r"password:", timeout=120)
    keyed(target, "alice-pw-1\n")
    wait_screen(target, r"password again", timeout=120)
    keyed(target, "alice-pw-1\n")
    wait_screen(target, r"workspace name", timeout=120)
    keyed(target, "Home\n")
    wait_screen(target, r"(?i)(Welcome back|Login)", timeout=600)                 # ReGreet's prompt, alice preselected
    time.sleep(5)
    greeter = shot(target, "greeter")
    login_x, login_y = greeter_login_button(greeter)
    click(target, login_x, login_y, greeter[0], greeter[1])       # real rendered Login control, independent of GTK focus
    wait_screen(target, r"Password", timeout=120)              # greetd's PAM prompt in ReGreet
    keyed(target, "alice-pw-1\n")
    img = shell_frame(target, "shell")
    w, h, _ = img
    b = nav_buttons(img)
    click(target, 75, (b[1][0] + b[1][1]) // 2, w, h)           # 工作区与成员
    end = time.time() + 60
    while True:
        img2 = shot(target, "shell-workspaces")
        b2 = nav_buttons(img2)
        done = len(b2) == 12 and near(px(img2, 24, (b2[1][0] + b2[1][1]) // 2), PRIMARY)
        if done or time.time() > end:
            break
        time.sleep(3)
    assert done, [hexc(px(img2, 24, (x[0] + x[1]) // 2)) for x in b2]
    time.sleep(10)                                              # let the Shell's requests land in the journal
    operator_login(target, "alice", "alice-pw-1")
    target.send_chars(SHELL_PROBE + "\n", delay=0.03)
    operator_phase(target, "alice", "source", "PASS-TRIAL-ARMED", from_media=True, timeout=1800)
    operator_reboot(target, "alice", "alice-pw-1")
    operator_phase(target, "alice", "trial", "PASS-HEALTH-REFUSED")
    operator_reboot(target, "alice", "alice-pw-1")
    operator_phase(target, "alice", "export", "PASS-EXPORT-VERIFIED", from_media=True)
    target.send_monitor_command("system_powerdown")             # the power button: logind powers off
    if not powered_off(target, 300):
        print("no ACPI power-off within 300 s; cutting power")
        target.crash()

with subtest("evidence from the installed disk, read by a second ISO boot: unlock, administrator, greetd/PAM session, AgentOS session state, Host started, no password in the journal"), kill_on_fail():
    iso2 = create_machine(iso_cmd, name="iso2")
    extra.append(iso2)
    iso2.start()
    iso_root_shell(iso2)
    rc, log = run(iso2, f"printf '%s' '{PASS}' | cryptsetup open --readonly /dev/disk/by-partlabel/agentos-luks agentos-root - && mkdir -p /ev && mount -o ro,subvol=@root /dev/mapper/agentos-root /ev && echo OPEN-OK", "open")
    assert rc == 0 and "OPEN-OK" in log, log[-2000:]
    rc, log = run(iso2, "mount -o ro,subvol=@machine /dev/mapper/agentos-root /ev/var/lib/agentos-machine && "
                  "mount -o ro,subvol=@home /dev/mapper/agentos-root /ev/home", "subvols")
    assert rc == 0, log[-2000:]
    J = "journalctl -D /ev/var/log/journal --no-pager -o cat"
    checks = {
        "boots": "journalctl -D /ev/var/log/journal --list-boots --no-pager | grep -c .",
        "firstSetup": f"{J} -t agentos-first-setup | grep -c 'first boot completed for administrator alice'",
        "greetdSession": f"{J} | grep -c 'pam_unix(greetd:session): session opened for user alice'",
        "regreetLast": "grep -c '^last_user = \"alice\"' /ev/var/lib/regreet/state.toml",
        "regreetSession": "grep -c '^alice = \"AgentOS\"' /ev/var/lib/regreet/state.toml",
        "hostStarted": f"{J} | grep -c 'Started AgentOS Host for workspace'",
        "shellStarted": f"{J} -t agentos-m19-probe | grep -cE '^agentos-shell processes for alice: [1-9][0-9]*$'",
        "passwordInJournal": f"{J} | grep -c 'alice-pw-1'",
        "rootLocked": "awk -F: '$1==\"root\" && substr($2,1,1)==\"!\"' /ev/etc/shadow | grep -c .",
        "luksKeyslots": "cryptsetup luksDump /dev/disk/by-partlabel/agentos-luks | grep -cE '^ +[0-9]+: luks2'",
    }
    ev = {}
    for k, c in checks.items():
        rc, log = run(iso2, evidence_cmd(k, c), "ev" + k)
        ev[k] = evidence_value(k, log)
    print("installed-disk evidence", ev)
    assert ev["boots"] >= 1 and ev["firstSetup"] >= 1 and ev["greetdSession"] >= 1, ev
    assert ev["regreetLast"] == 1 and ev["regreetSession"] == 1, ev
    assert ev["hostStarted"] >= 1, ev
    assert ev["shellStarted"] == 1, ev                          # alice's one probe saw the Shell running
    assert ev["passwordInJournal"] == 0 and ev["luksKeyslots"] == 1, ev
    assert ev["rootLocked"] == 1, ev                            # the installed release: root locked (O09, decision 80)
    # Read-only recovery-medium evidence AFTER the real operator's failed trial and rollback, not a driver-created
    # update or a database mutation. @home and @machine are separate from @root on the installed Btrfs disk.
    probe = ("import json,sqlite3; from pathlib import Path; "
             "s=json.loads(Path('/ev/home/alice/drill/state.json').read_text()); "
             "c=sqlite3.connect('file:/ev/var/lib/agentos-machine/machine.sqlite?mode=ro',uri=True); "
             "j=c.execute('SELECT state FROM update_jobs WHERE update_id=?',(s['updateId'],)).fetchone(); "
             "m=c.execute('SELECT current_release_id,known_good_release_id FROM machine_meta').fetchone(); "
             "print('O09-SOURCE:'+json.dumps({'state':s,'job':j,'meta':m}))")
    rc, log = run(iso2, f"{PYTHON} -c \"{probe}\"", "drill-source")
    assert rc == 0, log[-2000:]
    source_evidence = last_json(log, "O09-SOURCE")
    assert source_evidence["job"] == ["rolled_back"], source_evidence
    assert source_evidence["meta"] == [source_evidence["state"]["base"]] * 2, source_evidence
    assert ev["boots"] >= 3, ev
    run(iso2, "umount -R /ev; cryptsetup close agentos-root; true", "close")
    iso2.send_console("poweroff\n")
    assert powered_off(iso2, 120), "the evidence ISO did not power off"

with subtest("O09 continuation: the SAME release ISO installs a second machine; its own administrator restores the carried encrypted set and reads the imported records through the real gateway/Host"), kill_on_fail():
    common2 = clean_disk("destination", "AGENTOS-T2")
    install_iso(common2, "destination-iso", "AGENTOS-T2")
    dest = create_machine(common2 + carry_options, name="destination")
    extra.append(dest)
    dest.start()
    wait_screen(dest, r"(?i)passphrase", timeout=900)
    keyed(dest, PASS + "\n")
    wait_screen(dest, "administrator login", timeout=900)
    keyed(dest, "bea\n")
    wait_screen(dest, "password:", timeout=120)
    keyed(dest, "bea-pw-2\n")
    wait_screen(dest, "password again", timeout=120)
    keyed(dest, "bea-pw-2\n")
    wait_screen(dest, "workspace name", timeout=120)
    keyed(dest, "B\n")
    wait_screen(dest, r"(?i)(Welcome back|Login)", timeout=600)
    operator_login(dest, "bea", "bea-pw-2")
    operator_phase(dest, "bea", "restore", "PASS-RESTORED", from_media=True)
    dest.send_monitor_command("system_powerdown")
    assert powered_off(dest, 300), "the destination did not power off"
    # The carrier is unmounted and both writers are off before the driver reads its final evidence.
    receipt = os.path.join(tmp, "restored.json")
    subprocess.run([MCOPY, "-i", carry, "::/restored.json", receipt], check=True)
    restored = json.load(open(receipt))
    assert restored["source"]["sourceMachine"] == source_evidence["state"]["sourceMachine"], restored
    assert restored["destination"] != restored["source"]["sourceMachine"], restored
    assert restored["records"] == source_evidence["state"]["records"] and len(restored["records"]) == 3, restored
    print("O09 ISO -> v0.4 import -> unhealthy trial -> known-good rollback -> encrypted export -> second ISO install -> restore:", json.dumps(restored))
