# U06: download that survives a link loss. Prepended with lib.py.

machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
machine.wait_until_succeeds("test -S /run/agentos/machine/machine.sock", timeout=120)
must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A")
machine.succeed("cat > /root/mcall.py <<'PY'\nimport json, socket, struct, sys\ns = socket.socket(socket.AF_UNIX); s.connect('/run/agentos/machine/machine.sock')\nb = json.dumps({'op': sys.argv[1], 'args': json.loads(sys.argv[2])}).encode()\ns.sendall(struct.pack('>I', len(b)) + b)\nn = struct.unpack('>I', s.recv(4, socket.MSG_WAITALL))[0]\nprint(s.recv(n, socket.MSG_WAITALL).decode())\nPY")
def mok(op, args):
    r = json.loads(machine.succeed(f"python3 /root/mcall.py {op} '{json.dumps(args)}'"))
    assert r["ok"], (op, r)
    return r["data"]
def msql(q):
    return machine.succeed(f"sqlite3 /var/lib/agentos-machine/machine.sqlite \"{q}\"").strip()

with subtest("a candidate closure in a signed release cache, not in the store"):
    machine.succeed("""cat > /root/u06.nix <<'NIX'
{ sh, cu }:
let
  bash = builtins.storePath sh;
  coreutils = builtins.storePath cu;
  mk = name: script: derivation { inherit name; system = "x86_64-linux"; builder = "${bash}/bin/bash"; PATH = "${coreutils}/bin"; args = [ "-c" script ]; };
  part = i: mk "u06-part-${toString i}" "mkdir $out && dd if=/dev/urandom of=$out/blob bs=1M count=20 2>/dev/null && echo ${toString i} > $out/i";
  parts = map part [ 1 2 3 4 5 6 ];
in mk "u06-release" "mkdir $out && echo ${builtins.concatStringsSep " " (map toString parts)} > $out/parts"
NIX""")
    sh = machine.succeed("dirname $(dirname $(readlink -f $(command -v bash)))").strip()
    cu = machine.succeed("dirname $(dirname $(readlink -f $(command -v dd)))").strip()
    root = machine.succeed(f"nix-build /root/u06.nix --argstr sh {sh} --argstr cu {cu} --no-out-link 2>&1 | tail -1").strip()
    assert root.startswith("/nix/store/") and root.endswith("-u06-release"), root
    parts = machine.succeed(f"cat {root}/parts").split()
    assert len(parts) == 6, parts
    closure = sorted([root] + parts)
    machine.succeed("nix-store --generate-binary-cache-key u06-test-1 /root/u06.sk /root/u06.pk")
    machine.succeed(f"nix --extra-experimental-features nix-command store sign --key-file /root/u06.sk --recursive {root}")
    machine.succeed(f"nix --extra-experimental-features nix-command copy --to 'file:///srv/cache?compression=none' {root}")
    machine.succeed(f"nix-store --delete {root} && nix-store --delete {' '.join(parts)}")
    for p in closure:
        machine.fail(f"nix-store --check-validity {p}")
    machine.succeed("""cat > /root/serve.py <<'PY'
import http.server, os, sys, time
ROOT, LOG = "/srv/cache", sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        p = os.path.join(ROOT, self.path.lstrip("/").split("?")[0])
        with open(LOG, "a") as f: f.write(self.path + "\\n")
        if not os.path.isfile(p):
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
        n = os.path.getsize(p)
        self.send_response(200); self.send_header("content-length", str(n)); self.end_headers()
        with open(p, "rb") as f:
            while True:
                b = f.read(65536)
                if not b: break
                self.wfile.write(b)
                if p.endswith(".nar"): time.sleep(0.012)    # ~5 MB/s, one transfer at a time
    do_HEAD = do_GET
http.server.HTTPServer(("127.0.0.1", 8099), H).serve_forever()
PY""")
    pk = machine.succeed("cat /root/u06.pk").strip()
    NIXCFG = f"extra-trusted-public-keys = {pk}"

with subtest("update fetch: a link loss leaves only complete paths; the same command resumes with just the missing ones (U06)"):
    rid = "12121212-1212-4212-8212-121212121212"
    comp = json.dumps({"machineSchema": [1, 2], "workspaceSchema": [5, 5], "brokerSchema": [4, 4], "brokerProtocol": [3, 3], "nativeRpc": [1, 1]}).replace('"', '\\"')
    msql(f"INSERT INTO releases (release_id, manifest_hash, release_sequence, closure_path, compatibility_json, migration_class, verification_state, support_until, created_at) VALUES ('{rid}', 'sha256:{rid}', 1, '{root}', '{comp}', 'none', 'verified', 4102444800000, 1)")
    uid = "34343434-3434-4434-8434-343434343434"
    mok("updates.open", {"updateId": uid, "toReleaseId": rid, "plan": {"to": rid}})
    machine.succeed("systemd-run --unit=u06-cache python3 /root/serve.py /tmp/u06-http-1.log")
    machine.wait_until_succeeds("curl -sf http://127.0.0.1:8099/nix-cache-info >/dev/null || python3 -c \"import urllib.request;urllib.request.urlopen('http://127.0.0.1:8099/nix-cache-info')\"", timeout=30)
    fetch = f"agentosctl update fetch --update-id {uid} --from http://127.0.0.1:8099 --closure {root}"
    machine.succeed(f"systemd-run --unit=u06-fetch-1 --setenv=NIX_CONFIG='{NIXCFG}' --setenv=PATH=/run/current-system/sw/bin sh -c '{fetch} > /tmp/u06-fetch-1.out 2>&1; echo rc=$? >> /tmp/u06-fetch-1.out'")
    def valid():
        return [p for p in closure if machine.execute(f"nix-store --check-validity {p}")[0] == 0]
    machine.wait_until_succeeds(f"test $(for p in {' '.join(parts)}; do nix-store --check-validity $p 2>/dev/null && echo y; done | wc -l) -ge 2", timeout=240)
    assert msql(f"SELECT state FROM update_jobs WHERE update_id='{uid}'") == "downloading"
    machine.succeed("systemctl stop u06-cache")                       # the link is gone mid-download
    machine.wait_until_succeeds("grep -q '^rc=' /tmp/u06-fetch-1.out", timeout=600)
    out1 = machine.succeed("cat /tmp/u06-fetch-1.out")
    print(out1)
    assert "rc=0" not in out1 and "UPDATE_DOWNLOAD_INTERRUPTED" in out1, out1
    have = valid()
    print("present after the cut", len(have), "of", len(closure))
    assert 2 <= len(have) < len(closure), have
    for p in have:                                                      # what is there is complete and verified
        machine.succeed(f"nix-store --verify-path {p}")
    st = json.loads(msql(f"SELECT IFNULL(error_json,'{{}}') FROM update_jobs WHERE update_id='{uid}'") or "{}")
    assert msql(f"SELECT state FROM update_jobs WHERE update_id='{uid}'") == "downloading"
    assert st.get("reason") == "download interrupted" and st.get("present") == len(have), st
    # nothing armed, no default touched: the update never left downloading
    # link back: the same command fetches only what is missing
    machine.succeed("systemd-run --unit=u06-cache-2 python3 /root/serve.py /tmp/u06-http-2.log")
    machine.wait_until_succeeds("python3 -c \"import urllib.request;urllib.request.urlopen('http://127.0.0.1:8099/nix-cache-info')\"", timeout=30)
    out2 = machine.succeed(f"NIX_CONFIG='{NIXCFG}' {fetch}")
    print(out2)
    r = json.loads(out2)
    assert r["state"] == "staged" and r["paths"] == len(closure) and r["alreadyPresent"] == len(have), r
    assert valid() == closure
    log2 = machine.succeed("cat /tmp/u06-http-2.log")
    for p in have:
        h = p[len("/nix/store/"):].split("-")[0]
        url = machine.succeed(f"sed -n 's/^URL: //p' /srv/cache/{h}.narinfo").strip()
        assert url and url not in log2, (p, url)                      # a complete path is never downloaded again
    assert msql(f"SELECT state FROM update_jobs WHERE update_id='{uid}'") == "staged"
    # running it once more is a no-op
    r = json.loads(machine.succeed(f"NIX_CONFIG='{NIXCFG}' {fetch}"))
    assert r["state"] == "staged" and r["fetched"] == 0, r

with subtest("an unsigned or wrongly signed cache is refused: nothing enters the store (U06/U04 boundary)"):
    machine.succeed("nix-store --delete " + root)
    rid2 = "56565656-5656-4656-8656-565656565656"
    msql(f"INSERT INTO releases (release_id, manifest_hash, release_sequence, closure_path, compatibility_json, migration_class, verification_state, support_until, created_at) VALUES ('{rid2}', 'sha256:{rid2}', 2, '{root}', '{comp}', 'none', 'verified', 4102444800000, 1)")
    msql("UPDATE update_jobs SET state='cancelled'")
    uid2 = "78787878-7878-4878-8878-787878787878"
    mok("updates.open", {"updateId": uid2, "toReleaseId": rid2, "plan": {"to": rid2}})
    rc, o = machine.execute(f"agentosctl update fetch --update-id {uid2} --from http://127.0.0.1:8099 --closure {root} 2>&1")   # no trusted key
    print(o)
    assert rc != 0 and "UPDATE_DOWNLOAD_INTERRUPTED" in o, o
    machine.fail(f"nix-store --check-validity {root}")
    assert msql(f"SELECT state FROM update_jobs WHERE update_id='{uid2}'") == "downloading"
