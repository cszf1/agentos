import type { ContainerSpec, ContainerStatus, EnvironmentReport, ImageStatus, ObservedContainerState, RuntimeDriver } from "@agentos/core";
import { PodmanApi, PodmanError } from "./api.js";
import { tar, type TarEntry } from "./tar.js";

export interface PodmanDriverOptions {
  socketPath: string;
  /** Builds a platform image context from its recipe (see recipes.ts). */
  recipe?: (image: { name: string; recipeHash: string; role: "builder" | "runtime"; profileId: string }) => { entries: TarEntry[]; recipeHash: string; baseDigestRef: string } | null;
  /** Container log retention per container (k8s-file, bounded). */
  logSizeBytes?: number;
}

const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));

function mapState(s: string | undefined): ObservedContainerState {
  switch (s) {
    case "running":
    case "paused":
      return "running";
    case "created":
    case "configured":
    case "initialized":
      return "created";
    case "exited":
    case "stopped":
    case "dead":
      return "exited";
    default:
      return "unknown";
  }
}

/**
 * Podman driver over the libpod REST API on the user's rootless engine socket (spec §11.2). Container options come
 * only from the typed ContainerSpec built by the host from fixed policy (spec §11.1).
 */
export class PodmanDriver implements RuntimeDriver {
  readonly api: PodmanApi;
  constructor(private readonly opts: PodmanDriverOptions) {
    this.api = new PodmanApi(opts.socketPath);
  }

  async checkEnvironment(): Promise<EnvironmentReport> {
    const problems: string[] = [];
    let info: Record<string, any>;
    try {
      const r = await this.api.json<Record<string, any>>("GET", "/libpod/info", { timeoutMs: 10_000 });
      if (r.status !== 200) throw new Error(`info returned ${r.status}`);
      info = r.data;
    } catch (e) {
      return {
        ok: false, rootless: false, cgroupVersion: "", cgroupControllers: [], seccomp: false, apparmor: false, selinux: false,
        ociRuntime: "", podmanVersion: "", kernel: "", platform: "", problems: [`container engine unreachable: ${(e as Error).message}`],
      };
    }
    const host = info.host ?? {};
    const sec = host.security ?? {};
    const controllers: string[] = host.cgroupControllers ?? [];
    const rootless = sec.rootless === true;
    if (!rootless) problems.push("engine is not rootless");
    if (host.cgroupVersion !== "v2") problems.push(`cgroup ${host.cgroupVersion ?? "unknown"} (v2 required)`);
    for (const c of ["cpu", "memory", "pids"]) if (!controllers.includes(c)) problems.push(`cgroup controller "${c}" is not delegated to this user`);
    if (sec.seccompEnabled !== true) problems.push("seccomp is not enabled");
    const arch = host.arch === "amd64" || host.arch === "arm64" ? host.arch : String(host.arch);
    return {
      ok: problems.length === 0,
      rootless,
      cgroupVersion: String(host.cgroupVersion ?? ""),
      cgroupControllers: controllers,
      seccomp: sec.seccompEnabled === true,
      apparmor: sec.apparmorEnabled === true,
      selinux: sec.selinuxEnabled === true,
      ociRuntime: String(host.ociRuntime?.name ?? ""),
      podmanVersion: String(info.version?.Version ?? ""),
      kernel: String(host.kernel ?? ""),
      platform: `linux/${arch}`,
      problems,
    };
  }

  async inspectImage(name: string): Promise<ImageStatus> {
    const r = await this.api.json<Record<string, any>>("GET", `/libpod/images/${encodeURIComponent(name)}/json`);
    if (r.status === 404) return { name, present: false };
    if (r.status !== 200) throw new PodmanError(r.status, `image inspect ${name}: ${JSON.stringify(r.data).slice(0, 200)}`);
    return { name, present: true, id: r.data.Id, labels: r.data.Labels ?? r.data.Config?.Labels ?? {}, architecture: r.data.Architecture };
  }

  async ensureImage(image: { name: string; recipeHash: string; role: "builder" | "runtime"; profileId: string }, opts: { allowBuild: boolean }): Promise<ImageStatus> {
    const cur = await this.inspectImage(image.name);
    if (cur.present) {
      if (cur.labels?.["agentos.recipe"] !== image.recipeHash) {
        throw new PodmanError(409, `image ${image.name} exists but carries recipe ${cur.labels?.["agentos.recipe"] ?? "none"}, expected ${image.recipeHash}`);
      }
      return cur;
    }
    if (!opts.allowBuild || !this.opts.recipe) return cur;
    const ctx = this.opts.recipe(image);
    if (!ctx) throw new PodmanError(404, `no recipe for ${image.name}`);
    if (ctx.recipeHash !== image.recipeHash) {
      throw new PodmanError(409, `platform files do not match the catalog for ${image.name}: recipe ${ctx.recipeHash} != ${image.recipeHash}`);
    }
    const labels = { "agentos.recipe": image.recipeHash, "agentos.role": image.role, "agentos.profile": image.profileId, "agentos.base": ctx.baseDigestRef };
    const q = `dockerfile=Containerfile&t=${encodeURIComponent(image.name)}&buildargs=${enc({ BASE: ctx.baseDigestRef })}&labels=${enc(labels)}&pullpolicy=missing&rm=true&forcerm=true&layers=false`;
    const r = await this.api.request("POST", `/libpod/build?${q}`, { body: tar(ctx.entries), contentType: "application/x-tar", timeoutMs: 15 * 60_000, maxBytes: 4 * 1024 * 1024 });
    const text = r.body.toString("utf8");
    const err = text.split("\n").map((l) => { try { return JSON.parse(l) as { error?: string }; } catch { return {}; } }).find((x) => typeof x.error === "string");
    if (r.status !== 200 || err) throw new PodmanError(r.status, `image build failed for ${image.name}: ${(err?.error ?? text).slice(-500)}`);
    const done = await this.inspectImage(image.name);
    if (!done.present || done.labels?.["agentos.recipe"] !== image.recipeHash) throw new PodmanError(500, `image ${image.name} missing after build`);
    return done;
  }

  async create(spec: ContainerSpec): Promise<{ id: string }> {
    const mountRo = { destination: spec.readOnlyMount.containerPath, type: "bind", source: spec.readOnlyMount.hostPath, options: ["ro", "rbind", "nosuid", "nodev"] };
    const bridge = { destination: "/run/agentos", type: "bind", source: spec.bridgeDir, options: ["rw", "rbind", "nosuid", "nodev", "noexec"] };
    const tmp = { destination: "/tmp", type: "tmpfs", source: "tmpfs", options: ["rw", `size=${spec.limits.tmpfsBytes}`, "mode=1777", "nosuid", "nodev", "noexec"] };
    const body = {
      name: spec.name,
      image: spec.image,
      command: spec.command,
      env: spec.env,
      env_host: false,
      httpproxy: false,
      labels: spec.labels,
      hostname: spec.role === "build" ? "agentos-build" : "agentos-app",
      netns: { nsmode: "none" },
      pidns: { nsmode: "private" },
      ipcns: { nsmode: "private" },
      utsns: { nsmode: "private" },
      userns: { nsmode: "keep-id" },
      read_only_filesystem: true,
      read_write_tmpfs: false,
      mounts: [mountRo, bridge, tmp],
      cap_drop: ["all"],
      no_new_privileges: true,
      privileged: false,
      restart_policy: "no",
      resource_limits: {
        memory: { limit: spec.limits.memoryBytes, swap: spec.limits.memoryBytes },
        cpu: { quota: Math.round(spec.limits.cpus * 100_000), period: 100_000 },
        pids: { limit: spec.limits.pids },
      },
      log_configuration: { driver: "k8s-file", size: this.opts.logSizeBytes ?? 256 * 1024 },
      stop_timeout: 2,
      work_dir: "/tmp",
    };
    const r = await this.api.json<{ Id?: string; message?: string }>("POST", "/libpod/containers/create", { json: body });
    if (r.status !== 201 || !r.data?.Id) throw new PodmanError(r.status, `container create ${spec.name}: ${(r.data as { message?: string })?.message ?? r.status}`);
    return { id: r.data.Id };
  }

  async start(idOrName: string): Promise<void> {
    const r = await this.api.json<{ message?: string }>("POST", `/libpod/containers/${encodeURIComponent(idOrName)}/start`);
    if (r.status !== 204 && r.status !== 304) throw new PodmanError(r.status, `container start ${idOrName}: ${r.data?.message ?? r.status}`);
  }

  async inspect(idOrName: string): Promise<ContainerStatus> {
    const r = await this.api.json<Record<string, any>>("GET", `/libpod/containers/${encodeURIComponent(idOrName)}/json`);
    if (r.status === 404) return { id: "", name: idOrName, state: "absent", exitCode: null, oomKilled: false, labels: {}, startedAt: null, finishedAt: null };
    if (r.status !== 200) throw new PodmanError(r.status, `container inspect ${idOrName}: ${r.status}`);
    const st = r.data.State ?? {};
    return {
      id: r.data.Id,
      name: String(r.data.Name ?? idOrName).replace(/^\//, ""),
      state: mapState(st.Status),
      exitCode: typeof st.ExitCode === "number" ? st.ExitCode : null,
      oomKilled: st.OOMKilled === true,
      labels: r.data.Config?.Labels ?? {},
      startedAt: st.StartedAt ?? null,
      finishedAt: st.FinishedAt ?? null,
    };
  }

  async stop(idOrName: string, timeoutSeconds: number): Promise<void> {
    const r = await this.api.json<{ message?: string }>("POST", `/libpod/containers/${encodeURIComponent(idOrName)}/stop?timeout=${timeoutSeconds}`, { timeoutMs: (timeoutSeconds + 10) * 1000 });
    if (r.status !== 204 && r.status !== 304 && r.status !== 404) throw new PodmanError(r.status, `container stop ${idOrName}: ${r.data?.message ?? r.status}`);
  }

  async kill(idOrName: string): Promise<void> {
    const r = await this.api.json<{ message?: string }>("POST", `/libpod/containers/${encodeURIComponent(idOrName)}/kill?signal=SIGKILL`);
    if (r.status !== 204 && r.status !== 409 && r.status !== 404) throw new PodmanError(r.status, `container kill ${idOrName}: ${r.data?.message ?? r.status}`);
  }

  async remove(idOrName: string): Promise<void> {
    const r = await this.api.json<unknown>("DELETE", `/libpod/containers/${encodeURIComponent(idOrName)}?force=true&v=true&timeout=2`, { timeoutMs: 30_000 });
    if (r.status !== 200 && r.status !== 204 && r.status !== 404) throw new PodmanError(r.status, `container remove ${idOrName}: ${r.status}`);
  }

  async list(storeUUID: string): Promise<ContainerStatus[]> {
    const r = await this.api.json<Record<string, any>[]>("GET", `/libpod/containers/json?all=true&filters=${enc({ label: [`agentos.store=${storeUUID}`] })}`);
    if (r.status !== 200 || !Array.isArray(r.data)) throw new PodmanError(r.status, `container list: ${r.status}`);
    return r.data.map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] ?? "").replace(/^\//, ""),
      state: mapState(c.State),
      exitCode: typeof c.ExitCode === "number" ? c.ExitCode : null,
      oomKilled: false,
      labels: c.Labels ?? {},
      startedAt: null,
      finishedAt: null,
    }));
  }

  async diagnostics(idOrName: string, maxBytes: number): Promise<string> {
    const r = await this.api.request("GET", `/libpod/containers/${encodeURIComponent(idOrName)}/logs?stdout=true&stderr=true&tail=40`, { maxBytes: maxBytes * 2, timeoutMs: 10_000 });
    if (r.status !== 200) return "";
    // Strip the 8-byte multiplexing headers when present.
    const b = r.body;
    const parts: Buffer[] = [];
    let i = 0;
    while (i + 8 <= b.length && (b[i] === 1 || b[i] === 2) && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 0) {
      const len = b.readUInt32BE(i + 4);
      parts.push(b.subarray(i + 8, i + 8 + len));
      i += 8 + len;
    }
    const text = (parts.length > 0 ? Buffer.concat(parts) : b).toString("utf8");
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  }

  async listPlatformImages(): Promise<string[]> {
    const r = await this.api.json<Record<string, any>[]>("GET", `/libpod/images/json?filters=${enc({ label: ["agentos.recipe"] })}`);
    if (r.status !== 200 || !Array.isArray(r.data)) throw new PodmanError(r.status, "image list failed");
    return r.data.flatMap((i) => (i.Names ?? i.RepoTags ?? []) as string[]).filter((n) => n.startsWith("localhost/agentos-"));
  }

  async removeImage(name: string): Promise<void> {
    if (!name.startsWith("localhost/agentos-")) throw new PodmanError(400, "only agentos platform images are removed");
    const r = await this.api.json<unknown>("DELETE", `/libpod/images/${encodeURIComponent(name)}`);
    if (r.status !== 200 && r.status !== 404) throw new PodmanError(r.status, `image remove ${name}: ${r.status}`);
  }

  async exportImage(name: string, file: string): Promise<void> {
    const { createWriteStream } = await import("node:fs");
    const http = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ socketPath: this.opts.socketPath, method: "GET", path: `/${this.api.version}/libpod/images/${encodeURIComponent(name)}/get?format=oci-archive`, headers: { host: "d" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new PodmanError(res.statusCode ?? 0, `image export ${name}: ${res.statusCode}`));
          return;
        }
        const out = createWriteStream(file, { mode: 0o600 });
        res.pipe(out);
        out.on("finish", () => resolve());
        out.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  async importImage(file: string): Promise<string[]> {
    const { createReadStream, statSync } = await import("node:fs");
    const http = await import("node:http");
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { socketPath: this.opts.socketPath, method: "POST", path: `/${this.api.version}/libpod/images/load`, headers: { host: "d", "content-type": "application/x-tar", "content-length": statSync(file).size }, timeout: 15 * 60_000 },
        (res) => {
          let t = "";
          res.on("data", (c) => (t += String(c)));
          res.on("end", () => (res.statusCode === 200 ? resolve(t) : reject(new PodmanError(res.statusCode ?? 0, `image load: ${t.slice(0, 300)}`))));
        },
      );
      req.on("error", reject);
      createReadStream(file).pipe(req);
    });
    try {
      return ((JSON.parse(body) as { Names?: string[] }).Names ?? []) as string[];
    } catch {
      return [];
    }
  }

  async wait(idOrName: string, timeoutMs: number): Promise<ContainerStatus> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.inspect(idOrName);
      if (s.state === "exited" || s.state === "absent" || Date.now() >= until) return s;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
