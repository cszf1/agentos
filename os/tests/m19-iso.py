import json, os, re, shutil, subprocess, time
import contextlib

# ---- the clean UEFI VM: one blank 64 GiB virtio disk with a serial number, no network ----
tmp = os.environ.get("TMPDIR", "/tmp")
disk = os.path.join(tmp, "target.qcow2")
subprocess.run([QEMU_IMG, "create", "-f", "qcow2", disk, "64G"], check=True)
vars_ = os.path.join(tmp, "ovmf-vars.fd")
shutil.copy(OVMF_VARS, vars_)
os.chmod(vars_, 0o644)
append = open(os.path.join(ISO_DIR, "append")).read().strip()
print("ISO serial entry:", open(os.path.join(ISO_DIR, "kernel.path")).read().strip(), append)
common = (f"{QEMU} -m 3072 -smp 2 -nic none "
          f"-drive if=pflash,format=raw,unit=0,readonly=on,file={OVMF_CODE} -drive if=pflash,format=raw,unit=1,file={vars_} "
          f"-drive file={disk},if=none,id=t,format=qcow2 -device virtio-blk-pci,drive=t,serial=AGENTOS-T1 "
          "-vga none -device virtio-gpu-pci -device qemu-xhci,id=xhci -device usb-tablet,bus=xhci.0")
iso_cmd = common + f" -drive file={ISO_DIR}/agentos.iso,media=cdrom,readonly=on,if=ide -kernel {ISO_DIR}/bzImage -initrd {ISO_DIR}/initrd -append '{append}'"
PASS = "correct horse battery"
TARGET = "/dev/disk/by-id/virtio-AGENTOS-T1"

extra = []

@contextlib.contextmanager
def kill_on_fail():
    # a failed check must not leave a create_machine() VM running until the CI step deadline
    try:
        yield
    except BaseException:
        for x in extra:
            if x.booted:
                x.crash()
        raise

def run(m, cmd, tag, timeout=900):
    """Run a root shell command on the ISO's serial console; returns (rc, console log)."""
    m.send_console(f"{cmd}; echo __{tag}_RC=$?__\n")
    m.wait_for_console_text(f"__{tag}_RC=[0-9]+__", timeout=timeout)
    log = m.get_console_log()
    return int(re.findall(f"__{tag}_RC=([0-9]+)__", log)[-1]), log

def last_json(log, key):
    hits = re.findall(key + r":(\{.*\})", log)
    assert hits, f"no {key} line on the console"
    return json.loads(hits[-1])

def iso_root_shell(m):
    # the installer's own autologin on the serial console it was booted with
    m.wait_for_console_text(r"nixos@nixos", timeout=900)
    m.send_console("sudo -i\n")
    m.wait_for_console_text(r"root@nixos", timeout=120)
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
    parts, i = [], 0
    while len(parts) < 4:
        while raw[i:i + 1].isspace(): i += 1
        j = i
        while not raw[j:j + 1].isspace(): j += 1
        parts.append(raw[i:j]); i = j
    assert parts[0] == b"P6", parts
    return int(parts[1]), int(parts[2]), raw[i + 1:]

def px(img, x, y):
    w, _, d = img
    k = (y * w + x) * 3
    return tuple(d[k:k + 3])

def near(c, ref, tol=8):
    return all(abs(a - b) <= tol for a, b in zip(c, ref))

def hexc(c):
    return "#%02x%02x%02x" % c

TOPBAR, NAVBG, PRIMARY = (0x1f, 0x29, 0x37), (0xf3, 0xf4, 0xf6), (0xdc, 0xe7, 0xfb)

def nav_buttons(img):
    w, h, _ = img
    rows = [y for y in range(h) if max(px(img, 12, y)) < 0xc0 and max(px(img, 12, y)) - min(px(img, 12, y)) < 24]
    lines = []
    for r in rows:
        if lines and r - lines[-1][1] <= 1: lines[-1][1] = r
        else: lines.append([r, r])
    btns, k = [], 0
    while k + 1 < len(lines):
        top, bot = lines[k][1], lines[k + 1][0]
        if 18 <= bot - top <= 80:
            btns.append((top, bot)); k += 2
        else:
            k += 1
    return btns

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

def keyed(m, text):
    """Type on the VM keyboard one key at a time (QEMU's fast injection can drop a key)."""
    names = {"-": "minus", " ": "spc", "\n": "ret"}
    for ch in text:
        m.send_key(names.get(ch, ("shift-" + ch.lower()) if ch.isupper() else ch), delay=0.06)

with subtest("install from the ISO alone: its own kernel/initrd/command line, offline, to a blank disk by serial (U01, review F11)"), kill_on_fail():
    iso = create_machine(iso_cmd, name="iso")
    extra.append(iso)
    iso.start()
    iso_root_shell(iso)
    rc, log = run(iso, "test -e /etc/agentos-install-medium.json && ! ip route | grep -q default && echo MEDIUM-OK", "env")
    assert rc == 0 and "MEDIUM-OK" in log, log[-2000:]
    rc, log = run(iso, "agentos-install inspect | tail -n1 | sed 's/^/INSPECT:/'", "inspect")
    disks = {d["path"]: d for d in last_json(log, "INSPECT")["disks"]}
    print("inspect", json.dumps(disks)[:1500])
    tgt = [d for d in disks.values() if d.get("serial") == "AGENTOS-T1"]
    assert len(tgt) == 1 and not tgt[0]["problems"], disks
    rc, log = run(iso, f"agentos-install plan --disk {TARGET} --timezone Asia/Taipei | tail -n1 | sed 's/^/PLAN:/'", "plan")
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

with subtest("the installed disk alone: first unlock, first-boot administrator on the console, ReGreet login, the Shell on the output and driven by clicks (U01, D01, review F11)"), kill_on_fail():
    target = create_machine(common, name="installed")
    extra.append(target)
    target.start()
    target.wait_for_text(r"(?i)passphrase", timeout=900)
    time.sleep(2)
    keyed(target, PASS + "\n")
    target.wait_for_text(r"administrator login", timeout=900)
    shot(target, "first-setup")
    keyed(target, "alice\n")
    target.wait_for_text(r"password:", timeout=120)
    keyed(target, "alice-pw-1\n")
    target.wait_for_text(r"password again", timeout=120)
    keyed(target, "alice-pw-1\n")
    target.wait_for_text(r"workspace name", timeout=120)
    keyed(target, "Home\n")
    target.wait_for_text(r"Login", timeout=600)                 # ReGreet's button, alice preselected
    time.sleep(5)
    shot(target, "greeter")
    target.send_key("ret")
    target.wait_for_text(r"Password", timeout=120)              # greetd's PAM prompt in ReGreet
    keyed(target, "alice-pw-1\n")
    img = shell_frame(target, "shell")
    w, h, _ = img
    b = nav_buttons(img)
    click(target, 75, (b[2][0] + b[2][1]) // 2, w, h)           # 工作区与成员
    end = time.time() + 60
    while True:
        img2 = shot(target, "shell-workspaces")
        b2 = nav_buttons(img2)
        done = len(b2) == 12 and near(px(img2, 18, (b2[2][0] + b2[2][1]) // 2), PRIMARY)
        if done or time.time() > end:
            break
        time.sleep(3)
    assert done, [hexc(px(img2, 18, (x[0] + x[1]) // 2)) for x in b2]
    time.sleep(10)                                              # let the Shell's requests land in the journal
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
    J = "journalctl -D /ev/var/log/journal --no-pager -o cat"
    checks = {
        "boots": "journalctl -D /ev/var/log/journal --list-boots --no-pager | grep -c .",
        "firstSetup": f"{J} -t agentos-first-setup | grep -c 'first boot completed for administrator alice'",
        "greetdSession": f"{J} | grep -c 'pam_unix(greetd:session): session opened for user alice'",
        "regreetLast": "grep -c '^last_user = \"alice\"' /ev/var/lib/regreet/state.toml",
        "regreetSession": "grep -c '^alice = \"AgentOS\"' /ev/var/lib/regreet/state.toml",
        "hostStarted": f"{J} | grep -c 'Started AgentOS Host for workspace'",
        "shellStarted": f"{J} | grep -cE 'agentos-session-agent|agentos-shell'",
        "passwordInJournal": f"{J} | grep -c 'alice-pw-1'",
        "luksKeyslots": "cryptsetup luksDump /dev/disk/by-partlabel/agentos-luks | grep -cE '^ +[0-9]+: luks2'",
    }
    ev = {}
    for k, c in checks.items():
        rc, log = run(iso2, f"echo EV-{k}=$({c} 2>/dev/null || echo 0)", "ev" + k)
        ev[k] = int(re.findall(f"EV-{k}=([0-9]+)", log)[-1])
    print("installed-disk evidence", ev)
    assert ev["boots"] >= 1 and ev["firstSetup"] >= 1 and ev["greetdSession"] >= 1, ev
    assert ev["regreetLast"] == 1 and ev["regreetSession"] == 1, ev
    assert ev["hostStarted"] >= 1, ev
    assert ev["passwordInJournal"] == 0 and ev["luksKeyslots"] == 1, ev
    run(iso2, "umount /ev; cryptsetup close agentos-root; true", "close")
    iso2.send_console("poweroff\n")
    powered_off(iso2, 120)
