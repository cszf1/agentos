import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const REDACT = /token|cookie|secret|authorization|api[_-]?key|password/i;

export interface Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
}

/** JSON-lines logger: stdout (journald) plus logs/host.log rotated at 10 MiB, 5 files kept. */
export function createLogger(dir: string | null, level: Level, opts: { maxBytes?: number; keep?: number } = {}): Logger {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const keep = opts.keep ?? 5;
  let file: string | null = null;
  let size = 0;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = path.join(dir, "host.log");
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }
  const rotate = () => {
    if (!file) return;
    for (let i = keep - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      try {
        fs.renameSync(from, `${file}.${i}`);
      } catch {
        /* missing */
      }
    }
    size = 0;
  };
  const write = (lvl: Level, msg: string, f?: Record<string, unknown>) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f ?? {})) safe[k] = REDACT.test(k) ? "[redacted]" : v;
    const line = `${JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...safe })}\n`;
    process.stdout.write(line);
    if (file) {
      if (size + line.length > maxBytes) rotate();
      fs.appendFileSync(file, line, { mode: 0o600 });
      size += Buffer.byteLength(line);
    }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
