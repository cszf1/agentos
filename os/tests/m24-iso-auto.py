import json, os, re, shutil, subprocess, time
import contextlib

tmp = os.environ.get("TMPDIR", "/tmp")
append = open(os.path.join(ISO_DIR, "append")).read().strip()
PW = "auto-iso-pw-1"
GREETER = r"(?im)(welcome back|^\W*login\W*$)"   # ReGreet; never a boot status line ("User Login Management")


def wait_greeter(m, timeout):
    """ReGreet is up: its rendered Login button (pnm.py, as m19 clicks it) or its words on a line of their own."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        m.screenshot("greeter-poll")
        raw = subprocess.run([PNGTOPNM, os.path.join(m.out_dir, "greeter-poll.png")], check=True, capture_output=True).stdout
        try:
            greeter_login_button(pnm_rgb(raw))
            return
        except AssertionError:
            pass
        if any(re.search(GREETER, t) for t in screen_text(m)):
            return
        if m.process is not None and m.process.poll() is not None:
            raise AssertionError("the VM exited while waiting for the login screen")
        time.sleep(5)
    raise AssertionError("the login screen did not come up")

disk = os.path.join(tmp, "auto.qcow2")
subprocess.run([QEMU_IMG, "create", "-f", "qcow2", disk, "64G"], check=True)
vars_ = os.path.join(tmp, "auto-vars.fd")
shutil.copy(OVMF_VARS, vars_)
os.chmod(vars_, 0o644)
common = (f"{QEMU} -m 3072 -smp 2 -nic none -no-reboot "
          f"-drive if=pflash,format=raw,unit=0,readonly=on,file={OVMF_CODE} -drive if=pflash,format=raw,unit=1,file={vars_} "
          f"-drive file={disk},if=none,id=t,format=qcow2 -device virtio-blk-pci,drive=t,serial=AGENTOS-A1 "
          "-vga none -device virtio-gpu-pci -device qemu-xhci,id=xhci -device usb-tablet,bus=xhci.0")
iso_cmd = common + (f" -device virtio-scsi-pci,id=iso-scsi -drive file={ISO_DIR}/agentos.iso,if=none,id=cd,format=raw,media=cdrom,readonly=on "
                    f"-device scsi-cd,drive=cd,bus=iso-scsi.0 -kernel {ISO_DIR}/bzImage -initrd {ISO_DIR}/initrd -append '{append}'")

extra = []

@contextlib.contextmanager
def kill_on_fail():
    try:
        yield
    except BaseException:
        for i, x in enumerate(extra):
            if x.process is not None and x.process.poll() is None:
                try:
                    log_failure_screen(x, f"auto-failure-{i}")
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

def powered_off(m, timeout=300):
    end = time.time() + timeout
    while time.time() < end:
        if m.process is None or m.process.poll() is not None:
            m.wait_for_shutdown()
            return True
        time.sleep(2)
    return False

# ---- pixels of the real output (same helpers as m5) ----

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

def operator_login(m, user, pw):
    # greetd may reclaim VT1 after its first frame. Reselect only until the actual getty is visible;
    # no username or secret is typed while the greeter/transition still owns the output.
    wait_screen(m, r"login:", timeout=180, before_poll=lambda: m.send_key("ctrl-alt-f2"), stable_polls=2)
    m.send_chars(user + "\n", delay=0.08)
    wait_screen(m, r"[Pp]assword:", timeout=120)
    keyed(m, pw + "\n")
    # ReGreet can finish activating after PAM accepted the tty password and reclaim
    # the output. Reselect the same tty while observing its authenticated prompt;
    # do not type credentials again or treat the greeter as a successful login.
    wait_screen(m, user + r"@", timeout=120, before_poll=lambda: m.send_key("ctrl-alt-f2"), stable_polls=2)


with subtest("the ISO alone, untouched: countdown, install to the one empty disk, restart (no key, no command)"), kill_on_fail():
    iso = create_machine(iso_cmd, name="iso")
    extra.append(iso)
    iso.start()
    wait_console(iso, r"agentos-auto-install: countdown", timeout=900)
    wait_screen(iso, r"(?i)press any key to cancel", timeout=60)
    iso.screenshot("auto-countdown")
    wait_console(iso, r"agentos-auto-install: installing", timeout=120)
    wait_console(iso, r"agentos-auto-install: (installed|failed)", timeout=3600)
    assert "agentos-auto-install: failed" not in iso.get_console_log(), iso.get_console_log()[-3000:]
    iso.screenshot("auto-installed")
    # the installer restarts the VM; -no-reboot turns that into QEMU exiting
    assert iso.process is not None, "the ISO VM has no QEMU process"
    assert iso.process.wait(timeout=300) == 0, "the installer did not restart the VM"
    iso.wait_for_shutdown()

with subtest("first start of the installed disk: one password, typed twice, then the login screen; admin signs in with it"), kill_on_fail():
    target = create_machine(common, name="installed")
    extra.append(target)
    target.start()
    # OCR reads the O of AgentOS as 0 (run 42352756464)
    wait_screen(target, r"(?i)choose your agent[o0]s password", timeout=900)
    target.screenshot("auto-first-password")
    time.sleep(2)
    keyed(target, PW + "\n")
    wait_screen(target, r"(?i)repeat the password", timeout=120)
    keyed(target, PW + "\n")
    # re-encryption with a fresh volume key (16 GiB: several minutes on CI) and growing to the disk, then machined,
    # first setup and the greeter. "Login" alone on a line: boot status lines name "User Login Management"
    # (run 42355442891 matched one and went on before the re-key had finished)
    wait_greeter(target, timeout=3000)
    target.screenshot("auto-greeter")
    operator_login(target, "admin", PW)
    target.send_chars("id -nG; echo ADMIN-$(id -un)-OK\n", delay=0.03)
    wait_screen(target, r"ADMIN-admin-[O0]K", timeout=60)   # OCR: O or 0 (run 42357964358)
    target.send_monitor_command("system_powerdown")
    if not powered_off(target, 300):
        target.crash()

with subtest("next start: the same password once at the disk unlock, then the login screen; no setup again"), kill_on_fail():
    target.start()
    wait_screen(target, r"(?i)pass ?phra[sz]+e|enter pass|for disk agentos", timeout=900)
    time.sleep(2)
    keyed(target, PW + "\n")
    wait_greeter(target, timeout=900)
    target.screenshot("auto-second-boot")
    target.send_monitor_command("system_powerdown")
    if not powered_off(target, 300):
        target.crash()
