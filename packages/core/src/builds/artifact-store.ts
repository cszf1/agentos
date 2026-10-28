import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "@agentos/contracts";

/**
 * Content-addressed build outputs (spec §12.2 step 7, §12.3, §13). Files are written to a staging directory on the
 * same filesystem, fsynced, verified and atomically renamed into place before the database references them. A crash
 * leaves at most an unreferenced directory for cleanup. artifactId = sha256 of the canonical manifest bytes.
 */
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const ARTIFACT_FILES = ["app.mjs"] as const;

export interface ArtifactManifest {
  format: 1;
  runtimeLockId: string;
  platform: string;
  abiVersion: number;
  files: Record<string, string>;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function writeDurable(file: string, data: Buffer): void {
  const fd = openSync(file, "wx", 0o444);
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* some filesystems refuse directory fsync */
  }
}

export class ArtifactStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  static idOf(manifestBytes: Buffer | string): string {
    return `sha256:${sha(manifestBytes)}`;
  }

  relativePath(artifactId: string): string {
    return artifactId.replace(/^sha256:/, "");
  }

  dirOf(artifactId: string): string {
    const hex = this.relativePath(artifactId);
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("bad artifact id");
    return path.join(this.root, hex);
  }

  /** Validate, write, fsync and atomically publish. Returns the existing artifact when the same content is present. */
  put(files: Record<string, Buffer>, meta: { runtimeLockId: string; platform: string; abiVersion: number }): { artifactId: string; manifest: ArtifactManifest; sizeBytes: number; manifestBytes: Buffer } {
    const names = Object.keys(files).sort();
    if (names.join(",") !== [...ARTIFACT_FILES].join(",")) throw new Error(`artifact must contain exactly ${ARTIFACT_FILES.join(", ")}`);
    let size = 0;
    const hashes: Record<string, string> = {};
    for (const n of names) {
      size += files[n]!.length;
      hashes[n] = sha(files[n]!);
    }
    if (size > ARTIFACT_MAX_BYTES) throw new Error(`artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`);
    const manifest: ArtifactManifest = { format: 1, runtimeLockId: meta.runtimeLockId, platform: meta.platform, abiVersion: meta.abiVersion, files: hashes };
    const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
    const artifactId = ArtifactStore.idOf(manifestBytes);
    const final = this.dirOf(artifactId);
    if (existsSync(final)) {
      const problem = this.verify(artifactId);
      if (problem === null) return { artifactId, manifest, sizeBytes: size, manifestBytes };
      throw new Error(`existing artifact ${artifactId} is damaged: ${problem}`);
    }
    const staging = path.join(this.root, `.staging-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      for (const n of names) writeDurable(path.join(staging, n), files[n]!);
      writeDurable(path.join(staging, "manifest.json"), manifestBytes);
      fsyncDir(staging);
      renameSync(staging, final);
      fsyncDir(this.root);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    const problem = this.verify(artifactId);
    if (problem !== null) throw new Error(`artifact ${artifactId} failed verification after write: ${problem}`);
    return { artifactId, manifest, sizeBytes: size, manifestBytes };
  }

  /** null when the directory holds exactly the files the id names, with the right hashes; else the problem. */
  verify(artifactId: string): string | null {
    let dir: string;
    try {
      dir = this.dirOf(artifactId);
    } catch {
      return "bad artifact id";
    }
    if (!existsSync(dir)) return "missing";
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return "not a directory";
      const entries = readdirSync(dir).sort();
      if (entries.join(",") !== ["app.mjs", "manifest.json"].join(",")) return `unexpected files: ${entries.join(",")}`;
      for (const e of entries) {
        const s = lstatSync(path.join(dir, e));
        if (!s.isFile() || s.isSymbolicLink()) return `${e} is not a regular file`;
      }
      const manifestBytes = readFileSync(path.join(dir, "manifest.json"));
      if (ArtifactStore.idOf(manifestBytes) !== artifactId) return "manifest hash mismatch";
      const m = JSON.parse(manifestBytes.toString("utf8")) as ArtifactManifest;
      for (const [n, h] of Object.entries(m.files)) {
        if (sha(readFileSync(path.join(dir, n))) !== h) return `${n} hash mismatch`;
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  manifestOf(artifactId: string): ArtifactManifest {
    return JSON.parse(readFileSync(path.join(this.dirOf(artifactId), "manifest.json"), "utf8")) as ArtifactManifest;
  }

  /** Directories on disk: published artifact ids and leftover staging dirs. */
  scan(): { artifacts: string[]; staging: string[] } {
    const artifacts: string[] = [];
    const staging: string[] = [];
    for (const name of readdirSync(this.root)) {
      if (/^[0-9a-f]{64}$/.test(name)) artifacts.push(`sha256:${name}`);
      else if (name.startsWith(".staging-")) staging.push(name);
    }
    return { artifacts, staging };
  }

  removeStaging(name: string): void {
    if (!name.startsWith(".staging-")) throw new Error("not a staging dir");
    rmSync(path.join(this.root, name), { recursive: true, force: true });
  }

  /** Delete a published artifact (GC, after the database marked it unreferenced). */
  remove(artifactId: string): void {
    rmSync(this.dirOf(artifactId), { recursive: true, force: true });
  }

  sizeOnDisk(): number {
    let total = 0;
    for (const name of readdirSync(this.root)) {
      const dir = path.join(this.root, name);
      try {
        for (const f of readdirSync(dir)) total += lstatSync(path.join(dir, f)).size;
      } catch {
        /* ignore */
      }
    }
    return total;
  }
}
