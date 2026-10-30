# Session/member helpers shared by m9 (same as m3-members.py; m3 keeps its own copy).
import base64, time, uuid

def call(n, reqs, tag):
    """Run [session.bind, *reqs] inside the tty n login and return the responses after the bind."""
    body = json.dumps([{"methodId": "session.bind"}] + reqs, ensure_ascii=False)
    machine.succeed(f"echo {base64.b64encode(body.encode()).decode()} | base64 -d > /tmp/{tag}.json && chmod 0644 /tmp/{tag}.json")
    out = tty_run(n, f"{RPC} @/tmp/{tag}.json", f"/tmp/{tag}")
    lines = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert len(lines) == len(reqs) + 1, out
    assert lines[0]["status"] == 200, lines[0]
    return lines[1:]

def code(r):
    e = r.get("error")
    if isinstance(e, dict):
        return e.get("code")
    b = r.get("body")
    if isinstance(b, dict):
        if isinstance(b.get("error"), dict):
            return b["error"].get("code")
        return b.get("code")
    return None

def fwd(ws, route, body=None, params=None, idem=None):
    b = {"routeId": route}
    if body is not None:
        b["body"] = body
    if params is not None:
        b["params"] = params
    r = {"methodId": "workspace.forward", "workspaceId": ws, "body": b}
    if idem:
        # the Host takes only lowercase UUID keys: a readable test tag maps to a stable UUID (same tag = same key)
        r["idempotencyKey"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "agentos-test:" + idem))
    return r

def sql(q):
    return machine.succeed(f"sqlite3 /var/lib/agentos-machine/machine.sqlite \"{q}\"").strip()

def make_user(name, pw, tag):
    p = call(1, [{"methodId": "machine.users.create", "idempotencyKey": str(uuid.uuid4()), "body": {"loginName": name, "role": "user", "password": pw}}], tag + "p")[0]
    assert p["status"] == 201, p
    ok = call(1, [{"methodId": "machine.actions.confirm", "idempotencyKey": str(uuid.uuid4()), "body": {"operationId": p["body"]["operationId"], "planHash": p["body"]["planHash"], "password": "alice-pw-1"}}], tag + "c")[0]
    assert '"succeeded"' in json.dumps(ok), ok
    return sql(f"SELECT user_id FROM users WHERE login_name='{name}'")
