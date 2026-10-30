#!/usr/bin/env python3
"""File-level audit of the formal release closure (spec §32 V1-B08): no testMode, no preset token or private key, no
faux model default, no anonymous TCP entry, no default account password. Usage:
  release-audit.py <toplevel> <closure store-paths file>   -> prints a JSON report; exit 1 on any finding.
Scope: the whole closure for account definitions, units and sockets; every AgentOS-owned store path (name contains
"agentos") file by file for keys, tokens and test switches."""
import json, os, re, sys

top, paths_file = sys.argv[1], sys.argv[2]
paths = [p.strip() for p in open(paths_file) if p.strip()]
findings, checked = [], {"users": 0, "units": 0, "agentosFiles": 0, "agentosPaths": 0}

def bad(kind, where, detail=""):
    findings.append({"kind": kind, "where": where, "detail": detail[:200]})

# --- accounts: every user NixOS creates, from the closure's users-groups.json
ug = [p for p in paths if p.endswith("-users-groups.json")]
if not ug:
    bad("accounts", "users-groups.json", "not found in the closure")
for f in ug:
    for u in json.load(open(f)).get("users", []):
        checked["users"] += 1
        for k in ("password", "initialPassword", "hashedPasswordFile", "passwordFile"):
            if u.get(k):
                bad("account-password", u.get("name", "?"), k)
        for k in ("hashedPassword", "initialHashedPassword"):
            v = u.get(k)
            if v not in (None, "", "!", "*", "!*"):
                bad("account-password", u.get("name", "?"), k)

# --- units and sockets of the system and user managers (through the toplevel's etc)
etc = os.path.realpath(os.path.join(top, "etc"))
unit_dirs = [os.path.join(etc, d) for d in ("systemd/system", "systemd/user")]
for d in unit_dirs:
    if not os.path.isdir(d):
        continue
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        if not os.path.isfile(p):
            continue
        checked["units"] += 1
        try:
            t = open(p, errors="replace").read()
        except OSError:
            continue
        if n in ("sshd.service", "sshd.socket", "sshd@.service", "telnet.socket"):
            bad("remote-entry", n)
        for m in re.finditer(r"^ListenStream=(.+)$", t, re.M):
            v = m.group(1).strip()
            if not v.startswith("/") and not v.startswith("@"):
                bad("tcp-listen", n, v)          # a TCP port/address instead of a UNIX socket
        if re.search(r"AGENTOS_MODEL_MODE=faux", t):
            bad("faux-default", n)
        if re.search(r"--autologin|autologin-user", t):
            bad("autologin", n)
        if n.startswith("agentos-host@") and "AGENTOS_MODEL_MODE=real" not in t:
            bad("model-mode", n, "AGENTOS_MODEL_MODE=real missing")

greetd = os.path.join(etc, "greetd/config.toml")
if os.path.exists(greetd) and "initial_session" in open(greetd).read():
    bad("autologin", "greetd initial_session")

# --- every AgentOS-owned path, file by file
PEM = re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----")
TOKENS = [re.compile(rb"\bsk-[A-Za-z0-9]{24,}"), re.compile(rb"\bghp_[A-Za-z0-9]{30,}"), re.compile(rb"github_pat_[A-Za-z0-9_]{30,}"),
          re.compile(rb"AKIA[0-9A-Z]{16}"), re.compile(rb"AGENTOS_(?:AUTH_)?TOKEN=[A-Za-z0-9]{16,}"), re.compile(rb"AGENTOS_MODEL_API_KEY=[^\s\"']{8,}")]
TESTMODE = re.compile(rb"\"testMode\"\s*:\s*true|testMode\s*=\s*true")
# the public template LUKS key (only protects a disk with no identity and no data; replaced on first boot, U03)
ALLOWED_KEYS = re.compile(r"agentos-template-disk\.key$|-template-disk\.key$")
own = [p for p in paths if "agentos" in os.path.basename(p)]
for root0 in own:
    checked["agentosPaths"] += 1
    for root, dirs, files in os.walk(root0):
        # third-party dependency trees bundled inside the Node package are audited for keys only, not test switches
        for f in files:
            p = os.path.join(root, f)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            checked["agentosFiles"] += 1
            if f.endswith((".pem", ".key")) and not ALLOWED_KEYS.search(p):
                bad("key-file", p)
            try:
                if os.path.getsize(p) > 64 * 1024 * 1024:
                    continue
                b = open(p, "rb").read()
            except OSError:
                continue
            if PEM.search(b) and "node_modules" not in p and "/test" not in p:
                bad("private-key", p)
            for t in TOKENS:
                m = t.search(b)
                if m:
                    bad("token", p, m.group(0)[:12].decode(errors="replace") + "…")
            if "node_modules" not in p and TESTMODE.search(b) and not p.endswith((".ts", ".js.map", ".d.ts")):
                bad("test-mode", p)

# --- the broker policy the release installs
pol = os.path.join(etc, "agentos/broker/policy.json")
try:
    if json.load(open(pol)).get("testMode") is not False:
        bad("test-mode", pol, "broker policy testMode is not false")
    checked["brokerPolicy"] = "testMode=false"
except Exception as e:
    bad("broker-policy", pol, str(e))

print(json.dumps({"ok": not findings, "toplevel": top, "closurePaths": len(paths), "checked": checked, "findings": findings}, indent=1))
sys.exit(0 if not findings else 1)
