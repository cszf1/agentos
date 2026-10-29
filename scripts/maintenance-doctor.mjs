#!/usr/bin/env node
// pnpm maintenance:doctor (v0.4 spec §24.3): policy sync, target scope, clock, pause state, queue, disk/pins, broker
// protocol 2. Read-only.
import fs from "node:fs";
import { brokerAsk, dataDir, one, openOs, q, report } from "./doctor-common.mjs";

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
const { db, error } = openOs();
if (!db) add("os.sqlite", "fail", error);
else {
  const m = one(db, "SELECT maintenance_state AS s, maintenance_epoch AS e, maintenance_root_state AS r, clock_state AS c, scheduler_epoch AS se, store_uuid AS store FROM meta WHERE id = 1");
  add("maintenance state", m?.s === "paused" ? "warn" : "ok", `${m?.s} at epoch ${m?.e}; executor side ${m?.r}`);
  add("executor confirmed the control state", m?.r === "synced" ? "ok" : "warn", m?.r === "synced" ? "confirmed" : `${m?.r} (a local pause is already effective here)`);
  add("clock", m?.c === "clock_uncertain" ? "fail" : "ok", m?.c ?? "unknown");
  const pols = q(db, "SELECT id, version, template_id, target_kind, target_id, state, root_sync_state, expires_at FROM maintenance_policies WHERE state IN ('enabled','syncing','approved')");
  const unsynced = pols.filter((p) => p.target_kind === "service" && p.root_sync_state !== "synced");
  add("policies", "ok", pols.length ? pols.map((p) => `${p.template_id}→${p.target_kind}:${p.target_id.slice(0, 16)} (${p.state}, root ${p.root_sync_state ?? "n/a"})`).join("; ") : "no enabled policies");
  add("service policies confirmed by the broker", unsynced.length === 0 ? "ok" : "warn", unsynced.length ? `${unsynced.length} waiting (POLICY_SYNC_PENDING)` : "all confirmed");
  const expired = pols.filter((p) => p.expires_at && Date.parse(p.expires_at) < Date.now());
  add("policy expiry", expired.length === 0 ? "ok" : "warn", expired.length ? `${expired.length} past expiry (expired on the next pass)` : "none expired");
  const badScope = q(db, "SELECT p.id FROM maintenance_policies p WHERE p.state = 'enabled' AND p.target_kind = 'app' AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = p.target_id)");
  add("target scope", badScope.length === 0 ? "ok" : "fail", badScope.length ? `policies on missing apps: ${badScope.map((b) => b.id).join(", ")}` : "every enabled policy names an existing target");
  const jobs = q(db, "SELECT state, COUNT(*) AS n FROM maintenance_jobs WHERE state NOT IN ('succeeded','no_change','failed_no_effect','cancelled','expired') GROUP BY state");
  add("job queue", jobs.some((j) => j.state === "indeterminate" || j.state === "needs_attention") ? "warn" : "ok", jobs.length ? jobs.map((j) => `${j.state} ${j.n}`).join(", ") : "empty");
  const circ = q(db, "SELECT target_kind, target_id, action_family, reason FROM maintenance_circuits WHERE state = 'open'");
  add("circuit breakers", circ.length ? "warn" : "ok", circ.length ? circ.map((c) => `${c.target_kind}:${c.target_id.slice(0, 16)} ${c.action_family} (${c.reason ?? ""})`).join("; ") : "all closed");
  const outbox = one(db, "SELECT COUNT(*) AS n FROM root_sync_outbox WHERE dispatch_state IN ('pending','sent')");
  const effects = one(db, "SELECT COUNT(*) AS n FROM maintenance_effect_outbox WHERE dispatch_state IN ('pending','sent','accepted')");
  add("root sync / effect outbox", "ok", `${outbox?.n ?? 0} root sync pending, ${effects?.n ?? 0} maintenance effects awaiting a result`);
  const pins = one(db, "SELECT COUNT(*) AS n FROM artifact_pins WHERE state = 'held'");
  const del = one(db, "SELECT COUNT(*) AS n FROM gc_delete_intents WHERE phase NOT IN ('recorded','aborted')");
  add("artifact pins / GC", "ok", `${pins?.n ?? 0} held pins, ${del?.n ?? 0} unfinished delete intents`);
  try {
    const st = fs.statfsSync(dataDir());
    const usedPct = Math.round((1 - st.bavail / st.blocks) * 100);
    add("disk", usedPct >= 95 ? "fail" : usedPct >= 80 ? "warn" : "ok", `${usedPct}% used on the workspace filesystem`);
  } catch (e) {
    add("disk", "warn", String(e.message));
  }
  // broker protocol 2: the handshake lists the supported protocols
  let store = m?.store;
  try {
    store = JSON.parse(fs.readFileSync("/etc/agentos/broker/policy.json", "utf8")).hosts.find((h) => h.uid === process.getuid())?.storeUuid ?? store;
  } catch {
    /* the policy file may be unreadable; use the workspace's own store */
  }
  const hs = await brokerAsk({ v: 1, id: "1", method: "handshake", params: { protocolVersion: 1, storeUuid: store, machineInstallId: null, workspaceIncarnation: null, clientNonce: "maintenance-doctor" } });
  const sp = hs?.result?.supportedProtocols ?? hs?.supportedProtocols;
  if (hs?.ok === false && !sp) add("broker protocol 2", "warn", `broker not reachable: ${hs.error}`);
  else add("broker protocol 2", Array.isArray(sp) && sp.includes(2) ? "ok" : "warn", Array.isArray(sp) ? `supported protocols ${sp.join(", ")}` : `handshake: ${JSON.stringify(hs).slice(0, 200)}`);
}
report("maintenance", checks);
