export interface PermitWaiter {
  workspaceId: string;
  seq: number;
  background: boolean;
}

export interface HeldPermit {
  workspaceId: string;
  background: boolean;
}

export function chooseWaiter(waiters: readonly PermitWaiter[], held: readonly HeldPermit[], capacity: number): PermitWaiter | null {
  if (capacity <= 0) return null;
  const foregroundWaiting = waiters.filter((w) => !w.background).sort((a, b) => a.seq - b.seq);
  const foregroundHeld = held.filter((h) => !h.background);
  if (foregroundWaiting.length > 0 || foregroundHeld.length > 0) {
    const waitingIds = new Set(foregroundWaiting.map((w) => w.workspaceId));
    for (const waiter of foregroundWaiting) {
      const heldByWorkspace = foregroundHeld.filter((h) => h.workspaceId === waiter.workspaceId).length;
      const othersWaiting = [...waitingIds].some((id) => id !== waiter.workspaceId);
      if (heldByWorkspace >= 2) continue;
      if (heldByWorkspace >= 1 && othersWaiting) continue;
      return waiter;
    }
    return null;
  }
  if (held.some((h) => h.background)) return null;
  return waiters.filter((w) => w.background).sort((a, b) => a.seq - b.seq)[0] ?? null;
}
