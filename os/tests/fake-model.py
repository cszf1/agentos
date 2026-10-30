# A local OpenAI-compatible endpoint for VM checks only (never in a release image). It does NOT generate apps: it
# holds every chat completion for HOLD seconds (file /run/fake-model/hold, default 20) and then answers a short
# streamed text, so the test can watch how many real HTTP model requests the Hosts have in flight at once.
# The workspace is the first path segment (the Host unit's base URL is http://127.0.0.1:18080/<workspaceId>/v1).
# State: /run/fake-model/log.jsonl (one line per request start/end) and /run/fake-model/state.json.
import json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

D = "/run/fake-model"
os.makedirs(D, exist_ok=True)
lock = threading.Lock()
inflight = {}
peak = {"total": 0, "pairs": []}

def hold():
    try:
        return float(open(f"{D}/hold").read().strip())
    except Exception:
        return 20.0

def log(ev):
    with open(f"{D}/log.jsonl", "a") as f:
        f.write(json.dumps(ev) + "\n")

def snapshot():
    with open(f"{D}/state.json.tmp", "w") as f:
        json.dump({"inflight": inflight, "peak": peak}, f)
    os.replace(f"{D}/state.json.tmp", f"{D}/state.json")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a):
        pass
    def do_GET(self):
        b = json.dumps({"object": "list", "data": [{"id": "fake", "object": "model"}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        ws = self.path.strip("/").split("/")[0]
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        t0 = time.time()
        with lock:
            inflight[ws] = inflight.get(ws, 0) + 1
            tot = sum(inflight.values())
            if tot > peak["total"]:
                peak["total"] = tot
            peak["pairs"].append(sorted(k for k, v in inflight.items() for _ in range(v)))
            log({"ev": "start", "ws": ws, "t": t0, "inflight": dict(inflight)})
            snapshot()
        try:
            time.sleep(hold())
            text = "这是测试端点，不生成应用。"
            if body.get("stream"):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                base = {"id": "fake-1", "object": "chat.completion.chunk", "created": int(t0), "model": "fake"}
                for ch in ({"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None},
                           {"index": 0, "delta": {}, "finish_reason": "stop"}):
                    self.wfile.write(b"data: " + json.dumps({**base, "choices": [ch]}).encode() + b"\n\n")
                self.wfile.write(b"data: " + json.dumps({**base, "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}).encode() + b"\n\n")
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                self.close_connection = True
            else:
                b = json.dumps({"id": "fake-1", "object": "chat.completion", "created": int(t0), "model": "fake",
                                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}).encode()
                self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
        finally:
            with lock:
                inflight[ws] -= 1
                log({"ev": "end", "ws": ws, "t": time.time(), "inflight": dict(inflight)})
                snapshot()

ThreadingHTTPServer(("127.0.0.1", 18080), H).serve_forever()
