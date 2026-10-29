#!/usr/bin/env node
// pnpm agents:doctor (v0.4 spec §24.3): Pi version, conversation mapping, per-conversation cancel/routing, model budget
// and toolset version. Read-only.
import fs from "node:fs";
import path from "node:path";
import { ROOT, one, openOs, q, report } from "./doctor-common.mjs";

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
const pkgVersion = (n) => {
  for (const base of [path.join(ROOT, "packages", "agent-pi", "node_modules"), path.join(ROOT, "node_modules")]) {
    const f = path.join(base, n, "package.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).version;
  }
  return null;
};
for (const n of ["@earendil-works/pi-ai", "@earendil-works/pi-durable"]) {
  const v = pkgVersion(n);
  add(`${n} version`, v === "1.4.0" ? "ok" : "fail", v ?? "not installed");
}
add("node version", process.versions.node === "24.22.1" ? "ok" : "warn", process.versions.node);
const { db, error } = openOs();
if (!db) add("os.sqlite", "fail", error);
else {
  const migrations = one(db, "SELECT MAX(version) AS v FROM agent_toolset_migrations");
  add("toolset version (os.sqlite)", migrations?.v ? "ok" : "warn", `latest applied toolset migration ${migrations?.v ?? "none"}`);
  const convs = q(db, "SELECT profile_id, toolset_version, COUNT(*) AS n FROM agent_conversations GROUP BY profile_id, toolset_version");
  add("conversation mapping", "ok", convs.length ? convs.map((c) => `${c.profile_id} v${c.toolset_version}: ${c.n}`).join("; ") : "no task conversations yet");
  // every unfinished run must own exactly one conversation and one model route (per-conversation routing / cancel)
  const orphan = q(db, "SELECT r.id FROM runs r LEFT JOIN agent_conversations c ON c.run_id = r.id WHERE r.status IN ('running','cancel_requested') AND r.scheduling_state IN ('active','waiting_build','waiting_model','draining') AND c.run_id IS NULL");
  add("running tasks have their own conversation", orphan.length === 0 ? "ok" : "fail", orphan.length === 0 ? "all running tasks are mapped" : `unmapped: ${orphan.map((o) => o.id).join(", ")}`);
  const dupRoutes = q(db, "SELECT model_route_id, COUNT(*) AS n FROM agent_conversations GROUP BY model_route_id HAVING n > 1");
  add("one model route per conversation", dupRoutes.length === 0 ? "ok" : "fail", dupRoutes.length === 0 ? "routes are unique" : JSON.stringify(dupRoutes));
  const cancels = q(db, "SELECT id, updated_at FROM runs WHERE status = 'cancel_requested'");
  add("pending cancellations", cancels.length === 0 ? "ok" : "warn", cancels.length ? `${cancels.length} task(s) still cancelling: ${cancels.map((c) => c.id).join(", ")}` : "none");
  const queue = one(db, "SELECT SUM(scheduling_state IN ('waiting_slot','waiting_target')) AS queued, SUM(scheduling_state IN ('dispatching','active','waiting_build','waiting_model','draining') AND background = 0) AS fg, SUM(scheduling_state IN ('dispatching','active','waiting_build','waiting_model','draining') AND background = 1) AS bg FROM runs WHERE status IN ('queued','running','cancel_requested','blocked')");
  add("task slots", (queue?.fg ?? 0) <= 2 ? "ok" : "fail", `foreground running ${queue?.fg ?? 0}/2, background ${queue?.bg ?? 0}, queued ${queue?.queued ?? 0}`);
  const lim = one(db, "SELECT budget_limits_json AS j FROM meta WHERE id = 1");
  const used = one(db, "SELECT COUNT(*) AS n, SUM(background) AS bg, SUM(state IN ('interrupted','usage_unknown')) AS unk FROM model_attempts WHERE started_at > ? AND state <> 'denied'", new Date(Date.now() - 86_400_000).toISOString());
  add("model budget (24 h)", "ok", `requests ${used?.n ?? 0}, background ${used?.bg ?? 0}, usage unknown ${used?.unk ?? 0}; limits ${lim?.j ?? "platform defaults"}`);
  const leases = q(db, "SELECT target_kind, target_id, owner_kind, owner_id, state, deadline_at FROM target_leases WHERE state IN ('held','reclaiming','unknown')");
  const stale = leases.filter((l) => Date.parse(l.deadline_at) < Date.now());
  add("target locks", stale.length === 0 ? "ok" : "warn", `${leases.length} held${stale.length ? `, ${stale.length} past deadline (reclaimed by the host on its next pass)` : ""}`);
}
report("agents", checks);
