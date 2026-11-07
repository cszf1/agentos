"""Run a unit's shell script (os/modules/agentos.nix) with only the commands its own PATH provides.

The script's `export PATH=${lib.makeBinPath [ ... ]}` line names its packages. Under test, PATH holds the test's fakes
plus links to the host's copies of the commands those packages ship, nothing else, and a command that is not there is
recorded even when the script hides its error (`clear 2>/dev/null || true` hid that the VT was never cleared: no
ncurses in the path). A fake for a command none of the packages ship is refused too."""
import re
import shutil
from pathlib import Path

# What each package in those PATH lines puts in bin/ (only the commands that matter for the scripts)
PROVIDES = {
    "coreutils": {"basename", "cat", "chmod", "cp", "cut", "date", "dirname", "echo", "env", "false", "head", "id", "ln",
                  "ls", "mkdir", "mv", "printf", "readlink", "rm", "seq", "shred", "sleep", "sort", "stat", "sync", "tail", "tee",
                  "test", "timeout", "touch", "tr", "true", "uniq", "wc"},
    "util-linux": {"agetty", "findmnt", "flock", "logger", "lsblk", "mount", "script", "setsid", "umount"},
    "systemd": {"journalctl", "loginctl", "systemctl", "systemd-cat", "systemd-run", "udevadm"},
    "gnugrep": {"egrep", "fgrep", "grep"},
    "gawk": {"awk", "gawk"},
    "getent": {"getent"},
    "native": {"agentosctl", "agentos-machined"},
}
EXPORT = re.compile(r"export PATH=\$\{lib\.makeBinPath \[([^]]*)\]\}")


def packages(body):
    m = EXPORT.search(body)
    assert m, "the script sets no PATH of its own"
    pk = [w.removeprefix("pkgs.") for w in m.group(1).split()]
    unknown = [p for p in pk if p not in PROVIDES]
    assert not unknown, f"unit_path.PROVIDES does not know {unknown}"
    return pk


def write_fake(fakebin, name, text):
    """A fake runs with the host's PATH (it is test scaffolding, not part of the unit)."""
    text = text.replace("#!/usr/bin/env bash\n", f"#!{shutil.which('bash')}\n", 1)
    first, _, rest = text.partition("\n")
    (fakebin / name).write_text(f'{first}\nexport PATH="$HOST_PATH"\n{rest}')
    (fakebin / name).chmod(0o755)


def confine(body, fakebin, realbin, missing):
    """The script with PATH = fakes + the host's copies of what its packages ship; misses are appended to `missing`.
    Run it with HOST_PATH in its environment (for the fakes)."""
    allowed = set().union(*(PROVIDES[p] for p in packages(body)))
    stray = sorted(f.name for f in Path(fakebin).iterdir() if f.name not in allowed)
    assert not stray, f"fakes for commands the unit's PATH does not have: {stray}"
    Path(realbin).mkdir(exist_ok=True)
    for c in sorted(allowed):
        w = shutil.which(c)
        if not (Path(fakebin) / c).exists() and w:
            (Path(realbin) / c).symlink_to(w)
    handler = f'command_not_found_handle() {{ echo "$1" >> "{missing}"; echo "$1: command not found" >&2; return 127; }}\n'
    return handler + EXPORT.sub(f'export PATH="{fakebin}:{realbin}"', body, count=1)
