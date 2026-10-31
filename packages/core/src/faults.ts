import fs from "node:fs";
/**
 * Fault injection for recovery tests. Disabled unless NODE_ENV=test and AGENTOS_FAULTS=1;
 * AGENTOS_FAULT_POINT names the one point that kills the process with SIGKILL.
 */
const enabled = process.env.NODE_ENV === "test" && process.env.AGENTOS_FAULTS === "1";
const point = enabled ? process.env.AGENTOS_FAULT_POINT : undefined;

export function fault(name: string): void {
  if (point !== undefined && point === name) {
    process.stderr.write(`[fault] ${name}\n`);
    process.kill(process.pid, "SIGKILL");
    // SIGKILL is asynchronous only in theory; block until it lands.
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

export function faultsEnabled(): boolean {
  return enabled;
}

/**
 * Test-only pause points (review F03/F04 race windows). Armed only when AGENTOS_TEST_PAUSE_DIR names a root-owned
 * directory that nobody else may write (the release audit refuses the variable in any unit) and a file named after
 * the point exists there; a non-empty file names the one userId it applies to. The Host logs "[pause] <name>" and
 * waits until the file is removed (at most 180 s). pauseSync blocks the event loop on purpose: it stands inside a
 * synchronous SQLite transaction, exactly where a slow commit would be.
 */
const pauseDir = process.env.AGENTOS_TEST_PAUSE_DIR;

function pauseArmed(name: string, who?: string | null): boolean {
  if (!pauseDir) return false;
  try {
    const st = fs.statSync(pauseDir);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) return false;
    const c = fs.readFileSync(`${pauseDir}/${name}`, "utf8").trim();
    return c === "" || c === (who ?? "");
  } catch {
    return false;
  }
}

export function pauseSync(name: string, who?: string | null): void {
  if (!pauseArmed(name, who)) return;
  process.stderr.write(`[pause] ${name}\n`);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + 180_000;
  while (Date.now() < until && pauseArmed(name, who)) Atomics.wait(cell, 0, 0, 100);
  process.stderr.write(`[pause] ${name} released\n`);
}

export async function pauseAsync(name: string, who?: string | null): Promise<void> {
  if (!pauseArmed(name, who)) return;
  process.stderr.write(`[pause] ${name}\n`);
  const until = Date.now() + 180_000;
  while (Date.now() < until && pauseArmed(name, who)) await new Promise((r) => setTimeout(r, 100));
  process.stderr.write(`[pause] ${name} released\n`);
}
