import fs from "node:fs";
import { createHash } from "node:crypto";

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Strict sync: callers that allow unsupported filesystems must explicitly catch the error. */
export function fsyncPath(file: string): void {
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
