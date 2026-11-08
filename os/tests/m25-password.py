"""Guest-only integration checks. The constant is a public, synthetic VM fixture."""
import pathlib
import subprocess

password = b"faux:colon:password:"

def call(args, value=password):
    return subprocess.run(args, input=value, capture_output=True, check=False)

result = call(["agentosctl", "firstboot", "--admin", "colonadmin", "--workspace", "Home"])
assert result.returncode == 0, "firstboot rejected the colon password"
assert call(["pamtester", "login", "colonadmin", "authenticate"]).returncode == 0, "PAM rejected the exact password"
assert call(["pamtester", "login", "colonadmin", "authenticate"], b"faux:wrong:password").returncode != 0, "PAM accepted a different password"
image = pathlib.Path("/run/agentos-colon-luks")
try:
    with image.open("wb") as stream:
        stream.truncate(32 * 1024**2)
    result = call(["cryptsetup", "luksFormat", "--type", "luks2", "--batch-mode", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file=-", str(image)])
    assert result.returncode == 0, "LUKS initialization failed"
    args = ["cryptsetup", "open", "--test-passphrase", "--key-file=-", str(image)]
    assert call(args).returncode == 0, "LUKS rejected the account password"
    assert call(args, password[:-1]).returncode != 0, "LUKS silently truncated the password"
    assert password not in subprocess.check_output(["journalctl", "-b", "--no-pager"]), "password reached the journal"
    for path in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
        try:
            assert password not in path.read_bytes(), "password reached process argv"
        except (FileNotFoundError, ProcessLookupError):
            pass
finally:
    image.unlink(missing_ok=True)
