import { AgentOsError } from "@agentos/contracts";

export interface DirectoryUser {
  loginUid: number;
  userId: string;
  loginName: string;
  state: "provisioning" | "active" | "disabled";
}

export function userFromPeer(loginUid: number, users: readonly DirectoryUser[]): DirectoryUser {
  const row = users.find((u) => u.loginUid === loginUid);
  if (!row || row.state !== "active") throw new AgentOsError("SESSION_REQUIRED", "no active local account for this login");
  return row;
}
