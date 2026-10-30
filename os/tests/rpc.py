#!/usr/bin/env python3
"""Minimal native-rpc/1 client for VM tests (spec §9.2): 4-byte big-endian length + UTF-8 JSON over a UDS.
Usage: rpc.py <socket> '<json request or list of requests>' | @file  -> prints one JSON response per request."""
import json, socket, struct, sys, uuid

def frame(o):
    b = json.dumps(o, ensure_ascii=False).encode()
    return struct.pack(">I", len(b)) + b

def read(s):
    h = b""
    while len(h) < 4:
        c = s.recv(4 - len(h))
        if not c:
            raise EOFError("closed")
        h += c
    n = struct.unpack(">I", h)[0]
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            raise EOFError("closed")
        b += c
    return json.loads(b)

def main():
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(120)
    s.connect(sys.argv[1])
    arg = sys.argv[2]
    if arg.startswith("@"):   # requests from a file, so secrets in a body never appear in this client's argv
        arg = open(arg[1:], encoding="utf-8").read()
    reqs = json.loads(arg)
    if isinstance(reqs, dict):
        reqs = [reqs]
    state = {}
    for r in reqs:
        if r.get("methodId") == "$wait":
            # test choreography: keep THIS connection (and its bound session) open until the test creates a file
            import os, time
            end = time.time() + r.get("timeout", 300)
            while not os.path.exists(r["path"]) and time.time() < end:
                time.sleep(0.2)
            print(json.dumps({"wait": os.path.exists(r["path"])}), flush=True)
            continue
        r = json.loads(json.dumps(r).replace("$EPOCH", str(state.get("epoch", 1))).replace("$WS", state.get("ws", "00000000-0000-0000-0000-000000000000")))
        r.setdefault("requestId", str(uuid.uuid4()))
        r.setdefault("workspaceId", "00000000-0000-0000-0000-000000000000")
        r.setdefault("clientEpoch", 1)
        r.setdefault("sessionEpoch", state.get("epoch", 1))
        s.sendall(frame(r))
        while True:
            v = read(s)
            if v.get("type") == "event":
                continue
            break
        if r["methodId"] == "session.bind" and v.get("status") == 200:
            state["epoch"] = v["body"]["sessionEpoch"]
        if r["methodId"] == "workspaces.list" and v.get("status") == 200 and v["body"]["workspaces"]:
            state["ws"] = v["body"]["workspaces"][0]["workspaceId"]
        print(json.dumps(v, ensure_ascii=False), flush=True)

main()
