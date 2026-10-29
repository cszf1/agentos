import { describe, expect, it } from "vitest";
import { DeploymentService } from "@agentos/core";
import { fixture, newCore } from "../helpers.js";

/**
 * app_prepare is idempotent: a replay calls drive() again with the same deployment id. Once the candidate is
 * ready, that second drive must not tear the preview down (activation still needs it).
 */
describe("prepare replay leaves a ready candidate alive", () => {
  it("drive() on a ready deployment does not destroy its preview instance", async () => {
    const core = newCore();
    const bundle = fixture("todo-v1.json");
    core.apps.seedActivated(bundle);
    const app = core.apps.requireApp(bundle.manifest.appId);
    const rev = app.active_revision_id!;
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 60_000).toISOString();
    const depId = "dep-ready";
    const instId = "inst-preview";
    core.store.tx(() => {
      core.store.run(
        "INSERT INTO artifacts (id, build_key, runtime_lock_id, platform, manifest_json, relative_path, size_bytes, gc_state, created_at) VALUES ('sha256:replay', 'k', 'l', 'p', '{}', 'replay', 1, 'live', ?)",
        now,
      );
      core.store.run(
        `INSERT INTO deployments (id, app_id, target_revision_id, base_revision_id, expected_app_epoch, origin, owner_run_id, request_key, request_hash, status, stage, no_op,
          artifact_id, candidate_instance_id, deadline_at, cleanup_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'agent_prepare', NULL, 'rk', 'rh', 'ready', NULL, 0, 'sha256:replay', ?, ?, 'pending', ?, ?)`,
        depId, app.id, rev, rev, app.epoch, instId, later, now, now,
      );
      core.store.run(
        "INSERT INTO runtime_instances (id, app_id, revision_id, artifact_id, deployment_id, role, generation, host_boot_id, container_name, desired_state, observed_state, lease_digest, created_at, updated_at) VALUES (?, ?, ?, 'sha256:replay', ?, 'preview', 0, 'boot', 'c-replay', 'running', 'ready', 'lease', ?, ?)",
        instId, app.id, rev, depId, now, now,
      );
    });
    const destroyed: string[] = [];
    const deps = new DeploymentService(
      {
        store: core.store,
        instances: {
          get: (id: string) => (id === instId ? { id, dead: false } : undefined),
          destroy: async (inst: { id: string }) => { destroyed.push(inst.id); },
        },
        bootId: "boot",
        storeUUID: core.store.meta().store_uuid,
        log: () => {},
      } as never,
      {} as never,
    );
    await deps.drive(depId);
    expect(destroyed).toEqual([]);
    expect(core.store.get<{ status: string }>("SELECT status FROM deployments WHERE id = ?", depId)!.status).toBe("ready");
    expect(core.store.get<{ observed_state: string }>("SELECT observed_state FROM runtime_instances WHERE id = ?", instId)!.observed_state).toBe("ready");
  });
});
