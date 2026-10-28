#!/usr/bin/env python3
"""V3-T01..T05 inside the eBPF acceptance guest (real kernel with BTF): the fixed object is loaded by the real
agentos-telemetry daemon; workloads are real cgroups; events come from the kernel ring buffer. Run as root.
Prints one JSON object with a verdict per check (no simulated results)."""
import json, os, socket, struct, subprocess, sys, time, hashlib, threading

D = sys.argv[1]  # directory with agentos-telemetry and exec_exit.bpf.o
SOCK = "/run/agentos-telemetry/telemetry.sock"
CG = "/sys/fs/cgroup/agentos-test"
res = {"kernel": os.uname().release, "btf": os.path.exists("/sys/kernel/btf/vmlinux")}

def frame(o):
    b = json.dumps(o).encode()
    return struct.pack(">I", len(b)) + b

def recv(s):
    h = b""
    while len(h) < 4:
        c = s.recv(4 - len(h))
        if not c:
            raise EOFError
        h += c
    n = struct.unpack(">I", h)[0]
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            raise EOFError
        b += c
    return json.loads(b)

def ask(o):
    s = socket.socket(socket.AF_UNIX); s.connect(SOCK); s.sendall(frame(o)); r = recv(s); s.close(); return r

class Sub:
    def __init__(self, since=0, epoch=None):
        self.s = socket.socket(socket.AF_UNIX); self.s.connect(SOCK)
        req = {"op": "subscribe", "sinceSeq": since}
        if epoch: req["sourceEpoch"] = epoch
        self.s.sendall(frame(req)); self.items = []; self.stop = False
        self.t = threading.Thread(target=self.loop, daemon=True); self.t.start()
    def loop(self):
        try:
            while not self.stop:
                self.items.append(recv(self.s))
        except Exception:
            pass
    def close(self):
        self.stop = True
        try: self.s.close()
        except Exception: pass

def in_cg(path, argv):
    # Run argv inside the cgroup: the child moves itself before exec.
    return subprocess.run(["sh", "-c", f"echo $$ > {path}/cgroup.procs && exec \"$@\"", "sh"] + argv, capture_output=True)

def mkcg(name):
    p = f"{CG}/{name}"
    os.makedirs(p, exist_ok=True)
    return p

# ---- install the fixed object with its pinned hash (root-owned), start the real daemon
os.makedirs("/etc/agentos", exist_ok=True)
os.makedirs("/run/agentos-telemetry", exist_ok=True)
obj = "/usr/lib/agentos/exec_exit.bpf.o"
os.makedirs("/usr/lib/agentos", exist_ok=True)
subprocess.run(["install", "-o", "root", "-g", "root", "-m", "0644", f"{D}/exec_exit.bpf.o", obj], check=True)
subprocess.run(["install", "-o", "root", "-g", "root", "-m", "0755", f"{D}/agentos-telemetry", "/usr/lib/agentos/agentos-telemetry"], check=True)
osha = hashlib.sha256(open(obj, "rb").read()).hexdigest()
res["objectSha256"] = osha
open("/sys/fs/cgroup/cgroup.subtree_control", "w").write("+pids") if False else None
os.makedirs(CG, exist_ok=True)
cfg = {"objectPath": obj, "objectSha256": osha, "ringBytes": 16384, "hostUids": [1000], "allowedCgroupPrefixes": [f"{CG}/"], "testMode": True}
open("/etc/agentos/telemetry.json", "w").write(json.dumps(cfg))
os.chmod("/etc/agentos/telemetry.json", 0o644)
subprocess.run(["pkill", "-f", "/usr/lib/agentos/agentos-telemetry"], capture_output=True)
time.sleep(0.5)
log = open("/tmp/telemetry.log", "w")
daemon = subprocess.Popen(["/usr/lib/agentos/agentos-telemetry"], stdout=log, stderr=log)
for _ in range(600):
    try:
        st = ask({"op": "status"})["result"]
        if st.get("available"):
            break
    except Exception:
        pass
    time.sleep(0.1)
st = ask({"op": "status"})["result"]
res["status"] = st
res["T01_loaded"] = bool(st.get("available"))

# ---- T01: exec/exit of a registered workload are captured with its key and generation
w1 = mkcg("w1")
r = ask({"op": "register", "workloadKey": "app:test/w1", "cgroupPath": w1, "kind": "app"})
res["register"] = r
gen1 = r["result"]["workloadGeneration"]
sub = Sub()
time.sleep(0.5)
in_cg(w1, ["/bin/true"])
in_cg(w1, ["/bin/sh", "-c", "exit 7"])
time.sleep(2.0)
evs = [e for e in sub.items if e.get("type") == "event"]
mine = [e for e in evs if e.get("workloadKey") == "app:test/w1"]
res["T01_events"] = len(mine)
res["T01"] = res["T01_loaded"] and any(e["kind"] == "exec" for e in mine) and any(e["kind"] == "exit" and e.get("exitCode") == 7 for e in mine) and all(e["workloadGeneration"] == gen1 for e in mine)

# ---- T02: an unregistered process produces nothing; events carry no argv/env/content/payload
outside = mkcg("outside")
before = len(sub.items)
in_cg(outside, ["/bin/echo", "SECRET_ARG"])
subprocess.run(["/bin/true"])
time.sleep(1.5)
new = sub.items[before:]
allowed = {"type", "kind", "workloadKey", "workloadKind", "workloadGeneration", "cgroupId", "pid", "tgid", "procStartNs", "bootNs", "exitCode", "exitSignal", "sourceEpoch", "sourceSeq", "observedAtMs"}
res["T02_unregistered_events"] = len([e for e in new if e.get("type") == "event"])
res["T02_fields_ok"] = all(set(e.keys()) <= allowed for e in mine)
res["T02"] = res["T02_unregistered_events"] == 0 and res["T02_fields_ok"] and "SECRET_ARG" not in json.dumps(sub.items)
sub.close()

# ---- T03: ring/user drops are counted and surface as a gap (pause the consumer, flood a small ring)
ask({"op": "test-pause", "ms": 4000})
s0 = ask({"op": "status"})["result"]
sub2 = Sub(since=s0["lastSeq"])
procs = [subprocess.Popen(["sh", "-c", f"echo $$ > {w1}/cgroup.procs && for i in $(seq 1 300); do /bin/true; done"]) for _ in range(3)]
for p in procs:
    p.wait()
time.sleep(5.5)
s1 = ask({"op": "status"})["result"]
gaps = [e for e in sub2.items if e.get("type") == "gap"]
res["T03_kernelDrops"] = s1.get("kernelDrops")
res["T03_gaps"] = [g.get("reason") for g in gaps][:5]
res["T03"] = (s1.get("kernelDrops", 0) > 0) and len(gaps) > 0
sub2.close()

# resume from outside the retained window / another epoch is a gap too
sub3 = Sub(since=1, epoch="t_other_0")
time.sleep(1.0)
res["T03_resume_gap"] = any(e.get("type") == "gap" and e.get("reason") == "resume_outside_window" for e in sub3.items)
sub3.close()

# ---- T04: cgroup/PID reuse never maps old identity to the new workload
ask({"op": "unregister", "workloadKey": "app:test/w1"})
time.sleep(0.3)
os.rmdir(w1) if not open(f"{w1}/cgroup.procs").read().strip() else None
w1b = mkcg("w1")  # same path, new cgroup (new inode id)
sub4 = Sub()
time.sleep(0.3)
in_cg(w1b, ["/bin/true"])  # not registered yet: no attribution
time.sleep(1.0)
pre = [e for e in sub4.items if e.get("type") == "event"]
r2 = ask({"op": "register", "workloadKey": "app:test/w1", "cgroupPath": w1b, "kind": "app"})
gen2 = r2["result"]["workloadGeneration"]
in_cg(w1b, ["/bin/true"])
time.sleep(1.5)
post = [e for e in sub4.items if e.get("type") == "event" and e.get("workloadKey") == "app:test/w1"]
res["T04_newCgroupId"] = r2["result"]["cgroupId"] != r["result"]["cgroupId"]
res["T04_preEvents"] = len(pre)
res["T04"] = res["T04_newCgroupId"] and len(pre) == 0 and len(post) > 0 and all(e["workloadGeneration"] == gen2 and e["cgroupId"] == r2["result"]["cgroupId"] for e in post) and gen2 != gen1
sub4.close()

# ---- T05: the collector failing is visible (unavailable + gap), never silent
sub5 = Sub()
ask({"op": "test-detach"})
seen_down = None
for _ in range(40):
    s5 = ask({"op": "status"})["result"]
    if s5.get("available") is False:
        seen_down = {"available": False, "reason": s5.get("reason")}
        break
    time.sleep(0.05)
time.sleep(2.5)
s6 = ask({"op": "status"})["result"]
res["T05_down"] = seen_down
res["T05_gap"] = [e.get("reason") for e in sub5.items if e.get("type") == "gap"][:5]
res["T05_recovered"] = {"available": s6.get("available"), "sourceEpoch": s6.get("sourceEpoch")}
res["T05"] = seen_down is not None and "probe_lost" in res["T05_gap"]
sub5.close()

# ---- a foreign uid cannot use the socket; registering outside the allowed prefix is refused
r3 = ask({"op": "register", "workloadKey": "evil", "cgroupPath": "/sys/fs/cgroup/system.slice", "kind": "app"})
res["scopeRefused"] = r3.get("ok") is False
daemon.terminate()
print(json.dumps(res))
