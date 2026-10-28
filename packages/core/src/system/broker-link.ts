import { AgentOsError, type BrokerIdentity } from "@agentos/contracts";
import { BrokerClient, BrokerError, type HandshakeResult } from "@agentos/broker-client";
import { iso, type Store } from "../persistence/store.js";

export type BrokerBinding = "unbound" | "bound" | "mismatch" | "fenced";

export interface BrokerStatus {
  brokerReady: boolean;
  binding: BrokerBinding;
  machineInstallId: string | null;
  workspaceIncarnation: number | null;
  workspaceState: string | null;
  policyVersion: string | null;
  testMode: boolean;
  diagnostic: string | null;
  checkedAt: string | null;
}

/**
 * The host side of broker pairing (spec §12.1, §22.1 step 2). The workspace remembers the machineInstallId and
 * workspaceIncarnation it was bound to; a broker that reports anything else (a reinstalled log, a restore that moved
 * the incarnation) disables system writes instead of silently re-binding. A brand-new workspace with no system
 * history adopts the broker's current identity once.
 */
export class BrokerLink {
  readonly client: BrokerClient;
  status: BrokerStatus = { brokerReady: false, binding: "unbound", machineInstallId: null, workspaceIncarnation: null, workspaceState: null, policyVersion: null, testMode: false, diagnostic: "not connected", checkedAt: null };
  #connecting: Promise<BrokerStatus> | null = null;

  constructor(readonly store: Store, readonly storeUUID: string, socketPath?: string) {
    this.client = new BrokerClient({ storeUuid: storeUUID, socketPath });
  }

  meta(): { broker_install_id: string | null; workspace_incarnation: number | null; broker_binding_state: BrokerBinding; provider_policy_version: string | null } {
    return this.store.get("SELECT broker_install_id, workspace_incarnation, broker_binding_state, provider_policy_version FROM meta WHERE id = 1")!;
  }

  identity(): BrokerIdentity {
    const m = this.meta();
    if (!m.broker_install_id || m.workspace_incarnation === null) throw new AgentOsError("BROKER_UNAVAILABLE", "the workspace is not paired with the broker");
    return { machineInstallId: m.broker_install_id, storeUuid: this.storeUUID, workspaceIncarnation: m.workspace_incarnation };
  }

  /** Writes need a ready, bound broker with matching identity. */
  requireWritable(): BrokerIdentity {
    const s = this.status;
    if (!s.brokerReady) throw new AgentOsError("BROKER_UNAVAILABLE", s.diagnostic ?? "broker unavailable; system writes are paused");
    if (s.binding === "mismatch") throw new AgentOsError("BROKER_IDENTITY_MISMATCH", s.diagnostic ?? "broker identity does not match this workspace");
    if (s.binding === "fenced") throw new AgentOsError("WORKSPACE_FENCED", s.diagnostic ?? "this workspace incarnation is fenced");
    if (s.workspaceState !== "active") throw new AgentOsError("WORKSPACE_FENCED", `broker workspace state is ${s.workspaceState}`);
    return this.identity();
  }

  ensure(): Promise<BrokerStatus> {
    if (this.client.connected && this.client.handshakeResult) return Promise.resolve(this.status);
    if (!this.#connecting) {
      this.#connecting = this.#handshake().finally(() => {
        this.#connecting = null;
      });
    }
    return this.#connecting;
  }

  async refresh(): Promise<BrokerStatus> {
    this.client.close();
    return this.ensure();
  }

  async #handshake(): Promise<BrokerStatus> {
    const m = this.meta();
    let r: HandshakeResult;
    try {
      r = await this.client.handshake({ machineInstallId: m.broker_install_id, workspaceIncarnation: m.workspace_incarnation });
    } catch (e) {
      const be = e as BrokerError;
      this.status = { ...this.status, brokerReady: false, diagnostic: `${be.code ?? "BROKER_UNAVAILABLE"}: ${be.message}`, checkedAt: iso(Date.now()) };
      return this.status;
    }
    const base = { policyVersion: r.policyVersion, testMode: r.testMode, workspaceState: r.workspaceState, checkedAt: iso(Date.now()) };
    if (!r.brokerReady) {
      this.status = { ...this.status, ...base, brokerReady: false, diagnostic: r.diagnostic ?? "broker log unavailable (diagnostics only)" };
      return this.status;
    }
    const hasHistory = !!this.store.get("SELECT 1 FROM system_outbox LIMIT 1") || !!this.store.get("SELECT 1 FROM provider_grants WHERE principal_kind <> 'run' AND sync_state <> 'local' LIMIT 1");
    if (m.broker_install_id === null) {
      if (hasHistory) {
        this.status = { ...this.status, ...base, brokerReady: true, binding: "mismatch", machineInstallId: r.machineInstallId, workspaceIncarnation: r.workspaceIncarnation, diagnostic: "workspace has system history but no broker binding" };
        return this.status;
      }
      // First pairing: adopt the broker's identity (recorded so later mismatches are detected).
      this.store.tx(() =>
        this.store.run("UPDATE meta SET broker_install_id = ?, workspace_incarnation = ?, broker_binding_state = 'bound', provider_policy_version = ? WHERE id = 1", r.machineInstallId, r.workspaceIncarnation, r.policyVersion),
      );
      this.status = { ...base, brokerReady: true, binding: "bound", machineInstallId: r.machineInstallId, workspaceIncarnation: r.workspaceIncarnation, diagnostic: null };
      return this.status;
    }
    if (m.broker_install_id !== r.machineInstallId) {
      this.store.tx(() => this.store.run("UPDATE meta SET broker_binding_state = 'mismatch' WHERE id = 1"));
      this.status = { ...base, brokerReady: true, binding: "mismatch", machineInstallId: r.machineInstallId, workspaceIncarnation: r.workspaceIncarnation, diagnostic: `broker install ${r.machineInstallId} is not the one this workspace was bound to (${m.broker_install_id}); system writes stay off until an administrator rebinds` };
      return this.status;
    }
    if (m.workspace_incarnation !== r.workspaceIncarnation) {
      this.store.tx(() => this.store.run("UPDATE meta SET broker_binding_state = 'fenced' WHERE id = 1"));
      this.status = { ...base, brokerReady: true, binding: "fenced", machineInstallId: r.machineInstallId, workspaceIncarnation: r.workspaceIncarnation, diagnostic: `broker incarnation ${r.workspaceIncarnation} differs from this workspace (${m.workspace_incarnation}); finish the restore` };
      return this.status;
    }
    if (m.broker_binding_state !== "bound" || m.provider_policy_version !== r.policyVersion) {
      this.store.tx(() => this.store.run("UPDATE meta SET broker_binding_state = 'bound', provider_policy_version = ? WHERE id = 1", r.policyVersion));
    }
    this.status = { ...base, brokerReady: true, binding: "bound", machineInstallId: r.machineInstallId, workspaceIncarnation: r.workspaceIncarnation, diagnostic: null };
    return this.status;
  }

  /** Administrator rebind after a broker reinstall (new machineInstallId): every old grant, plan and outbox is void. */
  rebindToNewInstall(newInstallId: string, incarnation: number): void {
    this.store.tx(() => {
      const now = iso(Date.now());
      this.store.run("UPDATE provider_grants SET sync_state = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE revoked_at IS NULL AND sync_state <> 'local'", now);
      this.store.run(
        "UPDATE system_actions SET state = CASE WHEN state = 'awaiting_approval' THEN 'expired_no_effect' WHEN state = 'ready' AND COALESCE((SELECT dispatch_state FROM system_outbox o WHERE o.action_id = system_actions.id), 'pending') = 'pending' THEN 'cancelled_no_effect' ELSE 'indeterminate' END, effect_certainty = CASE WHEN state = 'awaiting_approval' OR (state = 'ready' AND COALESCE((SELECT dispatch_state FROM system_outbox o WHERE o.action_id = system_actions.id), 'pending') = 'pending') THEN 'none' ELSE 'unknown' END, error_json = ?, updated_at = ? WHERE state IN ('awaiting_approval','ready','dispatching','running','reconciling')",
        JSON.stringify({ code: "BROKER_HISTORY_MISSING", message: "the broker log was replaced; plans that were never sent are void, sent ones stay unknown and cannot be replayed" }), now,
      );
      this.store.run("UPDATE system_outbox SET dispatch_state = 'fenced', updated_at = ? WHERE dispatch_state <> 'final'", now);
      // Resources registered by the retired install are gone; the new install's catalog is synced on the next handshake.
      this.store.run("UPDATE system_resources SET status = 'gone', updated_at = ? WHERE execution_class = 'broker'", now);
      this.store.run("UPDATE meta SET broker_install_id = ?, workspace_incarnation = ?, broker_binding_state = 'bound' WHERE id = 1", newInstallId, incarnation);
      this.store.event("broker.rebound", { machineInstallId: newInstallId, workspaceIncarnation: incarnation });
    });
    this.client.close();
  }
}
