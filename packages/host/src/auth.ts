import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "agentos_session";

function writeSecretFile(file: string, value: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
  const fd = fs.openSync(tmp, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

/** 256-bit local login token and a separate session-signing secret, both 0600 files in the data dir. */
export function ensureSecrets(dataDir: string): { tokenFile: string; secretFile: string } {
  const tokenFile = path.join(dataDir, "auth-token");
  const secretFile = path.join(dataDir, "session-secret");
  if (!fs.existsSync(tokenFile)) writeSecretFile(tokenFile, randomBytes(32).toString("hex"));
  if (!fs.existsSync(secretFile)) writeSecretFile(secretFile, randomBytes(32).toString("hex"));
  fs.chmodSync(tokenFile, 0o600);
  fs.chmodSync(secretFile, 0o600);
  return { tokenFile, secretFile };
}

export function rotateSecrets(dataDir: string): void {
  writeSecretFile(path.join(dataDir, "auth-token"), randomBytes(32).toString("hex"));
  writeSecretFile(path.join(dataDir, "session-secret"), randomBytes(32).toString("hex"));
}

export class SessionAuth {
  constructor(
    private readonly dataDir: string,
    private readonly ttlMs: number,
  ) {}

  private read(name: string): string {
    return fs.readFileSync(path.join(this.dataDir, name), "utf8").trim();
  }

  checkToken(candidate: string): boolean {
    const real = Buffer.from(this.read("auth-token"));
    const got = Buffer.from(candidate.trim());
    return real.length === got.length && timingSafeEqual(real, got);
  }

  private sign(payload: string): string {
    return createHmac("sha256", Buffer.from(this.read("session-secret"), "hex")).update(payload).digest("base64url");
  }

  issue(clientEpoch: number, now = Date.now()): { value: string; maxAgeSec: number } {
    const payload = Buffer.from(JSON.stringify({ v: 1, iat: now, exp: now + this.ttlMs, epoch: clientEpoch, sid: randomBytes(9).toString("base64url") })).toString("base64url");
    return { value: `${payload}.${this.sign(payload)}`, maxAgeSec: Math.floor(this.ttlMs / 1000) };
  }

  /** Valid only when signed with the current secret, unexpired, and bound to the current client epoch. */
  verify(value: string | undefined, clientEpoch: number, now = Date.now()): boolean {
    if (!value) return false;
    const [payload, sig] = value.split(".");
    if (!payload || !sig) return false;
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    try {
      const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp: number; epoch: number };
      return p.exp > now && p.epoch === clientEpoch;
    } catch {
      return false;
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
