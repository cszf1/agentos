# V1-I11 (Wi-Fi and provider secrets) and the VM part of V1-H04 on a real NetworkManager (see m15-wifi.nix).
# Prepended with lib.py and members_lib.py. Every request goes through the real gateway from alice's PAM login.
# The secrets below exist only in this script and in the requests it sends; the scans afterwards look for them in
# argv, the journal, every AgentOS/NetworkManager state directory, a support bundle, a cold backup, the running
# system's Nix closure and every model request body. "KVM VM" evidence; mac80211_hwsim, not a real radio.
import hashlib

FM = "/run/fake-model"
PSK = "agentos-wifi-key-5b7e21c9"
BAD = "wrong-wifi-key-0a9d33f1"
PKEY = "sk-provider-key-e41c88f0a7b3"
SECRETS = [PSK, BAD, PKEY, "alice-pw-1"]

def b64(t):
    return base64.b64encode(t.encode()).decode()

def plan(kind, params, secret=None, tag="p"):
    body = {"actionKind": kind, "params": params}
    if secret is not None:
        body["secret"] = secret
    r = call(1, [{"methodId": "machine.actions.plan", "idempotencyKey": str(uuid.uuid4()), "body": body}], tag)[0]
    machine.succeed(f"rm -f /tmp/{tag}.json /tmp/{tag}.sh /tmp/{tag}")   # the harness's own copy of the request
    return r

def confirm_and_wait(p, tag):
    b = p["body"]
    r = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": b["operationId"], "planHash": b["planHash"]}}], tag)[0]
    assert r["status"] in (200, 202), r
    for _ in range(90):
        g = call(1, [{"methodId": "machine.actions.get", "body": {"operationId": b["operationId"]}}], tag + "g")[0]
        st = g["body"]["state"]
        if st not in ("planned", "authorized", "dispatching", "reconciling"):
            return g["body"]
        time.sleep(1)
    raise AssertionError(("operation did not finish", g))

def wlan0():
    out = machine.succeed("nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION dev show wlan0")
    print("wlan0:", out.strip())
    return out

machine.start()
machine.wait_for_unit("agentos-session-gateway.service")
machine.wait_for_unit("NetworkManager.service")
machine.wait_for_unit("agentos-fake-model.service")
machine.succeed(f"echo 1 > {FM}/hold")
# the access point: hostapd on wlan1, WPA2-Personal, config written now (the key is not in any store path)
cfg = f"interface=wlan1\ndriver=nl80211\nssid=agentos-lab\nhw_mode=g\nchannel=6\nwpa=2\nwpa_key_mgmt=WPA-PSK\nrsn_pairwise=CCMP\nwpa_passphrase={PSK}\n"
machine.succeed(f"echo {b64(cfg)} | base64 -d > /root/lab-ap.conf && chmod 0600 /root/lab-ap.conf")
machine.succeed("systemd-run --unit=lab-ap hostapd /root/lab-ap.conf")
machine.wait_until_succeeds("iw dev wlan1 info | grep -q 'type AP'", timeout=60)
# the lab network also hands out addresses, so NetworkManager can finish IP configuration (state 100, not 70)
machine.succeed("ip addr add 192.168.77.1/24 dev wlan1")
machine.succeed("systemd-run --unit=lab-dhcp dnsmasq --no-daemon --conf-file=/dev/null --interface=wlan1 --bind-interfaces --dhcp-range=192.168.77.10,192.168.77.50,12h --port=0 --dhcp-leasefile=/tmp/lab.leases")
machine.succeed("shred -u /root/lab-ap.conf")   # hostapd has read it; nothing on disk names the key any more

out = json.loads(must("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace A"))
ws_a = out["workspaceId"]
machine.wait_for_unit("agentos-broker.service")
tty_login(1, "alice", "alice-pw-1")
r = call(1, [{"methodId": "workspaces.attach", "workspaceId": ws_a, "idempotencyKey": "att-a", "body": {}}], "aa")[0]
assert r["status"] == 200, r
ua = int(sql(f"SELECT execution_uid FROM workspaces WHERE workspace_id='{ws_a}'"))
machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js", timeout=120)

# argv sampler for the whole run, in its own session (the driver's shell must not reap it)
machine.succeed("rm -f /root/argv.log /root/argv.done; setsid bash -c 'for i in $(seq 1 3000); do cat /proc/[0-9]*/cmdline 2>/dev/null | tr \"\\\\0\" \" \" >> /root/argv.log; echo >> /root/argv.log; sleep 0.05; test -e /root/argv.stop && break; done; touch /root/argv.done' >/dev/null 2>&1 < /dev/null &")
machine.wait_until_succeeds("test -s /root/argv.log", timeout=30)

with subtest("Wi-Fi: the catalogue lists the network; a key in params is refused; a wrong key fails visibly and leaves nothing (I11, H04 VM part)"):
    machine.wait_until_succeeds("nmcli dev wifi rescan ifname wlan0 >/dev/null 2>&1; nmcli -t -f SSID dev wifi list ifname wlan0 | grep -qx agentos-lab", timeout=90)
    caps = call(1, [{"methodId": "machine.capabilities"}], "cap")[0]
    assert caps["status"] == 200, caps
    net = caps["body"]["hardware"]["network"]
    print("network capability", net)
    assert net["available"] is True and net["wifiDevice"] == "wlan0" and "agentos-lab" in net["ssids"], net
    r = plan("network.wifi.connect", {"device": "wlan0", "ssid": "agentos-lab", "psk": PSK}, tag="wp0")
    assert r["status"] != 201 and code(r) == "INVALID_REQUEST", r
    r = plan("workspaces.runWhenLoggedOut", {"workspaceId": ws_a, "enabled": True}, secret=PSK, tag="wp1")
    assert r["status"] != 201 and code(r) == "INVALID_REQUEST", r      # an action that takes no secret refuses one
    p = plan("network.wifi.connect", {"device": "wlan0", "ssid": "agentos-lab"}, secret=BAD, tag="wb")
    assert p["status"] == 201, p
    assert BAD not in json.dumps(p) and "secretRef" in sql(f"SELECT params_json FROM machine_operations WHERE operation_id='{p['body']['operationId']}'")
    op = confirm_and_wait(p, "wbc")
    print("wrong key operation", op)
    assert op["state"] != "succeeded", op
    assert "100 (connected)" not in wlan0()
    machine.succeed("test -z \"$(nmcli -t -f NAME con show | grep -x agentos-lab)\"")   # the failed connection is gone

with subtest("Wi-Fi: the right key connects through machined's secret agent; NetworkManager stores no key; disconnect (I11, H04 VM part)"):
    p = plan("network.wifi.connect", {"device": "wlan0", "ssid": "agentos-lab"}, secret=PSK, tag="wg")
    assert p["status"] == 201, p
    op = confirm_and_wait(p, "wgc")
    print("right key operation", op)
    assert op["state"] == "succeeded", op
    o = wlan0()
    assert "100 (connected)" in o and "agentos-lab" in o, o
    # agent-owned: the keyfile says psk-flags=1 and holds no psk
    kf = machine.succeed("grep -rl 'ssid=agentos-lab' /etc/NetworkManager/system-connections /run/NetworkManager/system-connections 2>/dev/null || true").split()
    assert kf, "no connection file"
    for f in kf:
        t = machine.succeed(f"cat '{f}'")
        assert "psk-flags=1" in t and "psk=" not in t.replace("psk-flags=", ""), t
    rows = sql("SELECT params_json FROM machine_operations WHERE kind='network.wifi.connect'")
    assert PSK not in rows and BAD not in rows and rows.count("secretRef") >= 2, rows
    p = plan("network.wifi.disconnect", {"device": "wlan0"}, tag="wd")
    assert p["status"] == 201, p
    op = confirm_and_wait(p, "wdc")
    assert op["state"] == "succeeded", op
    assert "100 (connected)" not in wlan0()

with subtest("model credential: the owner sets it with the key in the secret field; the Host uses it; nothing else holds it (I11 provider)"):
    base = f"http://127.0.0.1:18080/{ws_a}/v1"
    r = plan("workspaces.modelCredential.set", {"workspaceId": ws_a, "provider": "openai-compatible", "modelId": "fake", "baseUrl": base, "apiKey": PKEY}, tag="mk0")
    assert r["status"] != 201 and code(r) == "INVALID_REQUEST", r
    p = plan("workspaces.modelCredential.set", {"workspaceId": ws_a, "provider": "openai-compatible", "modelId": "fake", "baseUrl": base}, secret=PKEY, tag="mk")
    assert p["status"] == 201 and PKEY not in json.dumps(p), p
    op = confirm_and_wait(p, "mkc")
    assert op["state"] == "succeeded", op
    machine.succeed(f"test \"$(stat -c '%a %u' /var/lib/agentos/workspaces/{ws_a}/model.env)\" = '600 {ua}'")
    machine.wait_until_succeeds(f"pgrep -u {ua} -f packages/host/dist/main.js", timeout=120)
    want = hashlib.sha256(("Bearer " + PKEY).encode()).hexdigest()[:16]
    for i in range(3):
        rr = call(1, [fwd(ws_a, "runs.post", body={"intent": "做一个待办应用", "targetAppId": None}, idem=f"mk-run-{i}")], f"mkr{i}")[0]
        if rr["status"] in (200, 202):
            break
        time.sleep(10)   # the Host restarts with the new credential
    assert rr["status"] in (200, 202), rr
    machine.wait_until_succeeds(f"grep -q '\"auth\": \"{want}\"' {FM}/log.jsonl", timeout=180)
    # a non-owner cannot set it: bob, viewer of A
    bob = make_user("bob", "bob-pw-1", "ub")
    r = call(1, [{"methodId": "members.setRole", "workspaceId": ws_a, "idempotencyKey": str(uuid.uuid4()), "body": {"userId": bob, "role": "viewer"}}], "bv")[0]
    assert r["status"] == 200, r
    tty_login(2, "bob", "bob-pw-1")
    body = {"actionKind": "workspaces.modelCredential.set", "params": {"workspaceId": ws_a, "provider": "openai-compatible", "modelId": "fake"}, "secret": "sk-bob-0000000000"}
    r = call(2, [{"methodId": "machine.actions.plan", "idempotencyKey": str(uuid.uuid4()), "body": body}], "bk")[0]
    machine.succeed("rm -f /tmp/bk.json /tmp/bk")
    assert r["status"] != 201 and code(r) == "NOT_FOUND_OR_FORBIDDEN", r

with subtest("no Wi-Fi, provider or PAM secret in argv, the journal, state, a support bundle, a backup, the Nix closure or a model request (I11)"):
    machine.succeed("touch /root/argv.stop")
    machine.wait_until_succeeds("test -e /root/argv.done", timeout=120)
    machine.succeed("test $(wc -l < /root/argv.log) -gt 100")
    machine.succeed("agentosctl support-bundle --out /root/i11-bundle.json && test -s /root/i11-bundle.json")
    bo = must("agentosctl backup --out /var/lib/agentos-snapshots/i11")
    v = json.loads(bo[bo.index("{"):])
    assert v["ok"], v
    machine.succeed("nix-store -qR /run/current-system > /root/i11-closure && test $(wc -l < /root/i11-closure) -gt 100")
    for s in SECRETS:
        machine.fail(f"grep -aF -- {s} /root/argv.log")
        machine.fail(f"journalctl -o cat --no-pager | grep -aF -- {s}")
        machine.fail(f"grep -aF -- {s} /root/i11-bundle.json")
        machine.fail(f"grep -raF -- {s} /var/lib/agentos-snapshots /var/lib/agentos-machine /var/lib/agentos-broker /var/log /run/agentos /etc /home /var/lib/NetworkManager /run/NetworkManager 2>/dev/null")
        # the workspace tree: only its own credential file may hold the model key (outside data/, in no checkpoint)
        hits = machine.succeed(f"grep -rlaF -- {s} /var/lib/agentos 2>/dev/null || true").split()
        assert hits == ([f"/var/lib/agentos/workspaces/{ws_a}/model.env"] if s == PKEY else []), (s, hits)
        machine.fail(f"xargs -a /root/i11-closure grep -rlaF -- {s} 2>/dev/null")
        machine.fail(f"grep -aF -- {s} {FM}/bodies.log")
    machine.succeed(f"test -s {FM}/bodies.log")
