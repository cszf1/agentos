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
