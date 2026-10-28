import fs from "node:fs";

/**
 * The host must be started through bin/agentos-host, which holds an flock(2) on <dataDir>/host.lock and
 * execs Node with --no-fork, so the lock owner is this very process. Verify via /proc/locks before any database opens.
 */
export function assertLockHeld(lockFile: string): void {
  const st = fs.statSync(lockFile);
  const inode = String(st.ino);
  const locks = fs.readFileSync("/proc/locks", "utf8").split("\n");
  const mine = locks.some((l) => {
    const parts = l.trim().split(/\s+/);
    // e.g. "1: FLOCK  ADVISORY  WRITE 12345 fd:01:123456 0 EOF"
    if (parts[1] !== "FLOCK" || parts[3] !== "WRITE") return false;
    const pid = parts[4];
    const dev = parts[5] ?? "";
    return pid === String(process.pid) && dev.split(":").pop() === inode;
  });
  if (!mine) {
    throw new Error(`this process does not hold ${lockFile}; start the host through bin/agentos-host`);
  }
}

const REMOTE_FS = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "fuse.sshfs", "drvfs", "virtiofs", "vboxsf"]);

/** The data directory must live on a local filesystem (advisory locks and SQLite WAL rely on it). */
export function assertLocalFs(dir: string): void {
  const mounts = fs.readFileSync("/proc/mounts", "utf8").split("\n").map((l) => l.split(" ")).filter((p) => p.length > 2);
  const real = fs.realpathSync(dir);
  let best: string[] | undefined;
  for (const m of mounts) {
    const mp = m[1]!.replace(/\\040/g, " ");
    if ((real === mp || real.startsWith(mp.endsWith("/") ? mp : `${mp}/`)) && (!best || mp.length > best[1]!.length)) best = m;
  }
  if (best && REMOTE_FS.has(best[2]!)) throw new Error(`data directory ${dir} is on ${best[2]}; use a local filesystem`);
}
