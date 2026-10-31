// O09's operator script on removable media, run as the locally logged-in administrator, NEVER as root.
// Only the installed release's agentosctl admin/PAM/ticket path changes machine state. The signing key and age
// identity below are ephemeral TEST identities. No model is called; both installed machines have no network.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME;
const work = path.join(home, "drill");
const phase = process.argv[2];
const user = process.env.USER;
const password = user === "alice" ? "alice-pw-1" : "bea-pw-2"; // public VM fixture, stdin only
const APP = "9efaf674-4561-4c6b-9860-cf44e09fdd01";
const STORE = "1385edad-f864-464f-b9d1-d640406dfbfd";

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  if (typeof v === "number") assert(Number.isSafeInteger(v));
  return JSON.stringify(v);
}
export function digest(v) {
  return crypto.createHash("sha256").update(`agentos.release.manifest.v1\n${canonical(v)}`).digest();
}
function read(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function write(p, v) { fs.writeFileSync(p, JSON.stringify(v), { mode: 0o600 }); }
function command(exe, args, input = undefined) {
  const r = spawnSync(exe, args, { input, encoding: "utf8", timeout: 1_200_000, maxBuffer: 16 << 20 });
  assert.equal(r.error, undefined, `${exe}: ${r.error}`);
  return r;
}
function checked(exe, args, input) {
  const r = command(exe, args, input);
  assert.equal(r.status, 0, `${exe} ${args.join(" ")}: ${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
function admin(args) {
  const r = command("agentosctl", ["admin", ...args, "--password-stdin", "--yes"], password + "\n");
  assert.equal(r.status, 0, `admin ${args.join(" ")}: ${r.stdout}\n${r.stderr}`);
  const v = JSON.parse(r.stdout);
  assert.equal(v.state, "succeeded", JSON.stringify(v));
  return v.result;
}
function status() { return JSON.parse(checked("agentosctl", ["admin", "status"])); }
function signed(file, value, key) {
  write(file, value);
  fs.writeFileSync(file + ".sig", crypto.sign(null, digest(value), key).toString("hex"), { mode: 0o600 });
}

// Native-rpc/1, exactly the framing of rpc.py. This socket is opened by the actual tty-session user, so the
// gateway checks SO_PEERCRED/logind and authorises workspaces.attach/forward; no root reader of live data.
async function records(ws) {
  const socket = net.createConnection("/run/agentos/gateway.sock");
  let buffer = Buffer.alloc(0), pending;
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const n = buffer.readUInt32BE(0);
      const v = JSON.parse(buffer.subarray(4, 4 + n).toString());
      buffer = buffer.subarray(4 + n);
      if (v.type !== "event") { assert(pending, "unsolicited response"); pending(v); pending = undefined; }
    }
  });
  await once(socket, "connect");
  let epoch = 1;
  async function call(methodId, body = {}, params = {}) {
    const raw = Buffer.from(JSON.stringify({ requestId: crypto.randomUUID(), methodId, workspaceId: ws,
      clientEpoch: 1, sessionEpoch: epoch, idempotencyKey: crypto.randomUUID(), body, params }));
    const h = Buffer.alloc(4); h.writeUInt32BE(raw.length);
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC timeout: ${methodId}`)), 120_000);
        pending = resolve;
        socket.write(Buffer.concat([h, raw]));
      });
    } finally { clearTimeout(timer); }
  }
  try {
    const b = await call("session.bind");
    assert.equal(b.status, 200, JSON.stringify(b)); epoch = b.body.sessionEpoch;
    assert.equal(b.body.role, "admin");
    const a = await call("workspaces.attach");
    assert.equal(a.status, 200, JSON.stringify(a));
    for (let i = 0; i < 60; i++) {
      const r = await call("workspace.forward", { routeId: "apps.records.list", params: { appId: APP } });
      if (r.status === 503 && r.body?.error?.retryable) { await sleep(2000); continue; }
      assert.equal(r.status, 200, JSON.stringify(r));
      const data = r.body?.data ?? r.body;
      const rows = Array.isArray(data) ? data : (data.records ?? data.items ?? []);
      assert.equal(rows.length, 3, JSON.stringify(rows));
      return rows.map(x => x.id ?? x.recordId).sort();
    }
    throw new Error("Host did not become ready");
  } finally { socket.destroy(); }
}

function media() {
  return checked("findmnt", ["-n", "-o", "TARGET", "/dev/disk/by-label/AOS-CARRY"]);
}
function makeCache(top) {
  // This drill tests a failing HEALTH trial, not a download of a different closure (m16 tests the latter).
  // The candidate deliberately has the already-installed closure. A cache with narinfo only proves that
  // update fetch reuses present store paths without silently fetching anything from the network.
  const info = JSON.parse(checked("nix", ["--extra-experimental-features", "nix-command", "path-info", "--json", "--recursive", top]));
  const entries = Array.isArray(info) ? info.map(v => [v.path, v]) : Object.entries(info);
  const cache = path.join(work, "cache"); fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "nix-cache-info"), "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n");
  for (const [p, v] of entries) {
    const name = path.basename(p), refs = (v.references ?? []).map(x => path.basename(x)).join(" ");
    fs.writeFileSync(path.join(cache, name.slice(0, 32) + ".narinfo"),
      `StorePath: ${p}\nURL: nar/not-needed.nar\nCompression: none\nNarHash: ${v.narHash}\nNarSize: ${v.narSize}\nReferences: ${refs}\n`);
  }
  return cache;
}

async function main() {
  assert.notEqual(process.getuid(), 0, "the drill must NOT run as root");
  if (phase === "source") {
    assert.equal(user, "alice");
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    for (const f of ["drill.mjs", "config.json", "manifest.json", "sbom.json", "v04"]) {
      fs.cpSync(path.join(here, f), path.join(work, f), { recursive: true });
    }
    const before = status();
    const imported = admin(["import-v04", "--backup", path.join(work, "v04"), "--owner", user, "--name", "Imported"]);
    assert.equal(imported.storeUUID, STORE, JSON.stringify(imported));
    const ids = await records(imported.workspaceId);
    const cfg = read(path.join(work, "config.json"));
    const base = { ...read(path.join(work, "manifest.json")), keyId: "o09-ephemeral-test" };
    const candidate = { ...base, releaseId: crypto.randomUUID(), releaseSequence: base.releaseSequence + 1 };
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    signed(path.join(work, "base.json"), base, privateKey);
    signed(path.join(work, "candidate.json"), candidate, privateKey);
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    admin(["update", "trust-key", "--key-id", base.keyId, "--public-key", pub]);
    admin(["update", "adopt-base", "--manifest", path.join(work, "base.json"), "--signature", path.join(work, "base.json.sig")]);
    const verified = admin(["update", "verify", "--manifest", path.join(work, "candidate.json"),
      "--signature", path.join(work, "candidate.json.sig"), "--images", cfg.images, "--sbom", path.join(work, "sbom.json"), "--open"]);
    assert.equal(verified.ok, true, JSON.stringify(verified));
    const updateId = verified.update.updateId;
    const cache = makeCache(base.baseClosurePath);
    const fetched = admin(["update", "fetch", "--update-id", updateId, "--from", `file://${cache}`, "--closure", base.baseClosurePath]);
    assert.equal(fetched.state, "staged"); assert.equal(fetched.fetched, 0);
    admin(["update", "activate", "--update-id", updateId]);
    write(path.join(work, "state.json"), { sourceMachine: before.meta.machineInstallId, workspaceId: imported.workspaceId,
      storeUUID: STORE, records: ids, base: base.releaseId, candidate: candidate.releaseId, updateId, fetched });
    console.log("AOS-TRIAL-ARMED");
  } else if (phase === "trial") {
    const state = read(path.join(work, "state.json"));
    assert(fs.readFileSync("/proc/cmdline", "utf8").includes(`agentos.release=${state.candidate}`), "not the candidate boot");
    // Deliberately no graphical login on THIS boot. The tty administrator is real but cannot satisfy the
    // Wayland health gate. No test-only skip flag, service edit or database write is used to induce failure.
    const r = command("agentosctl", ["admin", "update", "commit", "--update-id", state.updateId, "--password-stdin", "--yes"], password + "\n");
    assert.notEqual(r.status, 0, "an unhealthy trial was committed");
    assert.match(r.stdout + r.stderr, /health gate failed; default unchanged/);
    write(path.join(work, "trial-refusal.json"), { status: r.status, output: r.stdout, error: r.stderr });
    console.log("AOS-HEALTH-REFUSED");
  } else if (phase === "export") {
    const state = read(path.join(work, "state.json"));
    assert(fs.existsSync(path.join(work, "trial-refusal.json")), "trial was not exercised");
    assert(fs.readFileSync("/proc/cmdline", "utf8").includes(`agentos.release=${state.base}`), "did not boot known-good");
    const st = status();
    assert.equal(st.meta.currentReleaseId, state.base); assert.equal(st.meta.knownGoodReleaseId, state.base);
    assert.deepEqual(await records(state.workspaceId), state.records);
    admin(["backup", "--name", "o09-iso"]);
    const key = path.join(work, "test-identity.key");
    checked("age-keygen", ["-o", key]);
    const recipient = checked("age-keygen", ["-y", key]);
    const carry = path.join(work, "carry");
    const exp = admin(["backup", "export", "--set", "o09-iso", "--recipient", recipient, "--out", carry]);
    assert.equal(exp.exportState, "verified"); assert.equal(exp.offMachineCopy, true);
    write(path.join(carry, "evidence.json"), { ...state, rollbackStatus: st, export: exp });
    // TEST identity only, for this automated fixture. Real operator identities must be managed out-of-band.
    fs.copyFileSync(key, path.join(carry, "test-identity.key"));
    fs.cpSync(carry, path.join(media(), "carry"), { recursive: true });
    checked("sync", []);
    console.log("AOS-EXPORT-VERIFIED");
  } else if (phase === "restore") {
    assert.equal(user, "bea");
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    const carry = path.join(work, "carry");
    fs.cpSync(path.join(media(), "carry"), carry, { recursive: true });
    const src = read(path.join(carry, "evidence.json"));
    const dest = status(); assert.notEqual(dest.meta.machineInstallId, src.sourceMachine);
    admin(["import-set", "--in", carry, "--identity", path.join(carry, "test-identity.key"), "--name", "o09-carried"]);
    const cloned = admin(["clone", "--set", "o09-carried", "--owner", user]);
    const w = cloned.workspaces.find(x => x.sourceWorkspaceId === src.workspaceId);
    assert(w, JSON.stringify(cloned)); assert.notEqual(w.workspaceId, src.workspaceId); assert.equal(w.storeUUID, STORE);
    const ids = await records(w.workspaceId); assert.deepEqual(ids, src.records);
    write(path.join(media(), "restored.json"), { source: src, destination: dest.meta.machineInstallId, workspace: w, records: ids });
    checked("sync", []);
    console.log("AOS-O09-RESTORED");
  } else if (phase === "reboot") {
    admin(["reboot"]);
  } else {
    throw new Error(`unknown drill phase ${phase}`);
  }
}

if (phase === "--self-test") {
  assert.equal(canonical({ b: 1, a: [true, null, "x\"\n\u0001"], "é": { z: -3, y: "ü" } }),
    '{"a":[true,null,"x\\\"\\n\\u0001"],"b":1,"é":{"y":"ü","z":-3}}');
  assert.equal(canonical({ "～": 1, "😀": 2 }), '{"😀":2,"～":1}');
  assert.throws(() => canonical({ n: 1.5 }));
  assert.throws(() => canonical({ n: 9007199254740992 }));
  assert.equal(digest({}).length, 32);
  console.log("m19 drill canonical/digest self-test passed");
} else {
  await main();
}
