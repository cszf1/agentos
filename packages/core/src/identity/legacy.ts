import { AgentOsError, isUuid } from "@agentos/contracts";
import type { Store } from "../persistence/store.js";

/** Binds historical `user:local` receipts to an owner. Does not rewrite operation rows or their hashes. */
export function bindLegacyPrincipal(store: Store, ownerUserId: string, workspaceId: string): void {
  if (!isUuid(ownerUserId) || !isUuid(workspaceId)) throw new AgentOsError("INVALID_REQUEST", "owner and workspace must be uuids");
  store.tx(() => {
    const prior = store.get<{ owner_user_id: string; workspace_id: string }>("SELECT owner_user_id, workspace_id FROM legacy_principals WHERE legacy_key = 'user:local'");
    if (prior) {
      if (prior.owner_user_id !== ownerUserId || prior.workspace_id !== workspaceId) {
        throw new AgentOsError("IDEMPOTENCY_CONFLICT", "user:local is already bound");
      }
      return;
    }
    store.run(
      "INSERT INTO legacy_principals (legacy_key, owner_user_id, workspace_id, note) VALUES ('user:local', ?, ?, 'legacy principal')",
      ownerUserId,
      workspaceId,
    );
  });
}
