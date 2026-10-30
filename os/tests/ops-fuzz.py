#!/usr/bin/env python3
"""V1-O07 framing/parser abuse against the session gateway (VM checks only). Prints one JSON line per case."""
import json, socket, struct, sys, time, uuid
SOCK = sys.argv[1]

def conn():
    s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(SOCK); return s

def frame(b):
    return struct.pack(">I", len(b)) + b

def answer(s):
    try:
        h = b""
        while len(h) < 4:
            c = s.recv(4 - len(h))
            if not c:
                return "closed"
            h += c
        n = struct.unpack(">I", h)[0]
        b = b""
        while len(b) < n:
            c = s.recv(n - len(b))
            if not c:
                return "closed"
            b += c
        v = json.loads(b)
        return (v.get("error") or {}).get("code") or v.get("status")
    except socket.timeout:
        return "timeout"
    except OSError as e:
        return "oserror:" + e.__class__.__name__

def req(extra=None):
    r = {"methodId": "session.status", "requestId": str(uuid.uuid4()), "workspaceId": "00000000-0000-0000-0000-000000000000", "clientEpoch": 1, "sessionEpoch": 1}
    r.update(extra or {})
    return r

def case(name, payload, raw=False, wait=10):
    s = conn(); s.settimeout(wait)
    s.sendall(payload if raw else frame(payload))
    out = {"case": name, "result": answer(s)}
    s.close()
    print(json.dumps(out), flush=True)

case("oversize-length", struct.pack(">I", 0xFFFFFFF0) + b"{}", raw=True)
case("not-json", b"\xff\xfe not json")
case("duplicate-key", b'{"methodId":"session.status","methodId":"workspaces.list","requestId":"%s","workspaceId":"00000000-0000-0000-0000-000000000000","clientEpoch":1,"sessionEpoch":1}' % str(uuid.uuid4()).encode())
case("unknown-field", json.dumps(req({"principal": {"userId": "root"}})).encode())
case("url-forward", json.dumps(req({"methodId": "workspace.forward", "body": {"url": "http://127.0.0.1:8080/api/state"}})).encode())
case("deep-nesting", ("[" * 100000 + "]" * 100000).encode())
# the gateway gives a started frame 30 s to complete, so wait past that: the stalled frame must be closed, not answered
case("truncated-frame", struct.pack(">I", 100) + b'{"method', raw=True, wait=40)
# slow and idle connections must not starve others; a started frame that stalls is closed; connections per UID bounded
slow = []
for _ in range(20):
    s = conn(); s.sendall(b"\x00\x00"); slow.append(s)
t0 = time.time()
s = conn(); s.sendall(frame(json.dumps(req()).encode()))
print(json.dumps({"case": "served-while-20-slow", "result": answer(s), "seconds": round(time.time() - t0, 2)}), flush=True)
s.close()
time.sleep(35)
closed = 0
for x in slow:
    x.settimeout(2)
    try:
        closed += x.recv(1) == b""
    except OSError:
        closed += 1
    x.close()
print(json.dumps({"case": "stalled-frames-closed", "result": closed, "of": len(slow)}), flush=True)
idle, refused = [], 0
for _ in range(40):
    x = conn(); x.settimeout(1.5)
    try:
        refused += x.recv(1) == b""
    except socket.timeout:
        idle.append(x)
print(json.dumps({"case": "per-uid-bound", "result": len(idle), "refused": refused}), flush=True)
for x in idle:
    x.close()
time.sleep(1)
s = conn(); s.sendall(frame(json.dumps(req()).encode()))
print(json.dumps({"case": "served-after-release", "result": answer(s)}), flush=True)
