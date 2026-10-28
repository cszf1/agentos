import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PodmanDriver, PodmanError, invalidImageEnv, engineHasEnvLeakCve } from "@agentos/runtime-podman";

// CVE-2026-57231: image config Env entries without "=" make Podman < 5.8.4 copy engine-process variables into the
// container. The driver must refuse such images on every path (create, ensureImage, import) whatever the engine.

describe("CVE-2026-57231 image env validation", () => {
  it("accepts only KEY=VALUE entries", () => {
    expect(invalidImageEnv(["PATH=/usr/bin", "EMPTY=", "A=b=c"])).toEqual([]);
    expect(invalidImageEnv(undefined)).toEqual([]);
    expect(invalidImageEnv(["*"])).toEqual(["*"]);
    expect(invalidImageEnv(["HOST*", "TOKEN", "=1", "OK=1"])).toEqual(["HOST*", "TOKEN", "=1"]);
    expect(invalidImageEnv("PATH=/x")).toEqual(["PATH=/x"]);
  });

  it("knows the affected engine versions", () => {
    for (const v of ["5.4.2", "5.8.3", "4.9.4", "1.8.1", "5.0.0-dev", "garbage"]) expect(engineHasEnvLeakCve(v), v).toBe(true);
    for (const v of ["5.8.4", "5.8.6", "5.9.0", "6.0.0", "6.1.2", "1.8.0"]) expect(engineHasEnvLeakCve(v), v).toBe(false);
  });

  describe("driver paths (fake engine socket)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aos-cve-"));
    const sock = path.join(dir, "p.sock");
    const images: Record<string, { Env: string[]; Labels: Record<string, string> }> = {
      "localhost/good:1": { Env: ["PATH=/usr/bin", "NODE_ENV=production"], Labels: { "agentos.recipe": "sha256:r" } },
      "localhost/evil:1": { Env: ["PATH=/usr/bin", "*"], Labels: { "agentos.recipe": "sha256:r" } },
    };
    const calls: string[] = [];
    let server: http.Server;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        const u = decodeURIComponent(req.url ?? "");
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        req.resume();
        req.on("end", () => {
          let m = /\/libpod\/images\/(.+)\/json$/.exec(u);
          if (req.method === "GET" && m) {
            const img = images[m[1]!];
            return img ? send(200, { Id: m[1], Config: { Env: img.Env, Labels: img.Labels }, Labels: img.Labels, Architecture: "amd64" }) : send(404, { message: "no such image" });
          }
          if (req.method === "POST" && u.endsWith("/libpod/images/load")) return send(200, { Names: ["localhost/evil:1"] });
          m = /\/libpod\/images\/([^?]+)/.exec(u);
          if (req.method === "DELETE" && m) {
            delete images[m[1]!];
            return send(200, []);
          }
          if (req.method === "POST" && u.endsWith("/libpod/containers/create")) return send(201, { Id: "c1" });
          send(500, { message: "unexpected" });
        });
      });
      await new Promise<void>((r) => server.listen(sock, r));
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    });
    const driver = () => new PodmanDriver({ socketPath: sock });
    const spec = (image: string) =>
      ({
        name: "t", image, role: "preview", labels: {}, readOnlyMount: { hostPath: dir, containerPath: "/app" }, bridgeDir: dir, command: ["true"], env: {},
        limits: { memoryBytes: 1 << 26, cpus: 1, pids: 64, tmpfsBytes: 1 << 20 },
      }) as never;

    it("create refuses a malformed image and never reaches the engine's create", async () => {
      calls.length = 0;
      const e = await driver().create(spec("localhost/evil:1")).catch((x) => x);
      expect(e).toBeInstanceOf(PodmanError);
      expect((e as PodmanError).status).toBe(422);
      expect(String(e.message)).toMatch(/invalid image env.*\*/);
      expect(calls.some((c) => c.includes("/containers/create"))).toBe(false);
      expect((await driver().create(spec("localhost/good:1"))).id).toBe("c1");
    });

    it("ensureImage refuses an existing malformed image", async () => {
      const e = await driver().ensureImage({ name: "localhost/evil:1", recipeHash: "sha256:r", role: "runtime", profileId: "p" }, { allowBuild: false }).catch((x) => x);
      expect((e as PodmanError).status).toBe(422);
      expect((await driver().ensureImage({ name: "localhost/good:1", recipeHash: "sha256:r", role: "runtime", profileId: "p" }, { allowBuild: false })).present).toBe(true);
    });

    it("import (backup restore) removes a malformed image and fails", async () => {
      const f = path.join(dir, "a.tar");
      writeFileSync(f, Buffer.alloc(1024));
      const e = await driver().importImage(f).catch((x) => x);
      expect((e as PodmanError).status).toBe(422);
      expect(images["localhost/evil:1"]).toBeUndefined();
      expect(calls.some((c) => c.startsWith("DELETE") && c.includes("evil"))).toBe(true);
    });
  });
});
