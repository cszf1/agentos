import { defineCommands, defineQueries, type Mutation } from "@agentos/app-sdk";

// Platform-maintained fault fixture: it deliberately steps around the SDK to test the sandbox.
const proc = (globalThis as unknown as { process: { getBuiltinModule(name: string): any; pid: number } }).process;
const mod = (name: string) => proc.getBuiltinModule(name);

function tryDo(label: string, fn: () => unknown): string {
  try {
    const v = fn();
    return `${label}=OK:${String(v).slice(0, 80)}`;
  } catch (e) {
    return `${label}=${(e as { code?: string }).code ?? (e as Error).message}`;
  }
}

async function connect(opts: object): Promise<string> {
  const net = mod("node:net");
  return await new Promise<string>((resolve) => {
    const s = net.connect({ ...opts, timeout: 1000 });
    s.on("connect", () => {
      s.destroy();
      resolve("CONNECTED");
    });
    s.on("error", (e: { code?: string }) => resolve(e.code ?? "ERROR"));
    s.on("timeout", () => {
      s.destroy();
      resolve("TIMEOUT");
    });
  });
}

export const queries = defineQueries({
  main: () => ({ ok: true, detail: "fault lab ready" }),
  spin: () => {
    for (;;) {
      /* never returns */
    }
  },
  hog: () => {
    const keep: unknown[] = [];
    for (;;) keep.push(new Array(1_000_000).fill(Math.random()));
  },
  probe: async () => {
    const fs = mod("node:fs");
    const os = mod("node:os");
    const parts = [
      tryDo("home", () => fs.readdirSync("/data/home").length),
      tryDo("hostdb", () => fs.readFileSync("/data/home/.local/share/agentos/os.sqlite").length),
      tryDo("podmansock", () => fs.statSync("/run/user/1000/podman/podman.sock").size),
      tryDo("otherbridge", () => fs.readdirSync("/run/agentos").join(",")),
      tryDo("writeroot", () => fs.writeFileSync("/etc/agentos-probe", "x")),
      tryDo("writeapp", () => fs.writeFileSync("/app/x", "x")),
      tryDo("env", () => Object.keys(mod("node:process").env).sort().join(",")),
      tryDo("ifaces", () => Object.keys(os.networkInterfaces()).join(",")),
      tryDo("uid", () => mod("node:process").getuid()),
      `public=${await connect({ host: "1.1.1.1", port: 443 })}`,
      `hostloop=${await connect({ host: "127.0.0.1", port: 4317 })}`,
      `podmanapi=${await connect({ path: "/run/user/1000/podman/podman.sock" })}`,
      `bridge2=${await connect({ path: "/run/agentos/host.sock" })}`,
    ];
    return { ok: true, detail: parts.join(";") };
  },
  forkbomb: () => {
    const cp = mod("node:child_process");
    let started = 0;
    let err = "";
    const kids: { kill(): void }[] = [];
    for (let i = 0; i < 200; i++) {
      try {
        const c = cp.spawn("sleep", ["3"]);
        c.on("error", (e: { code?: string }) => (err = e.code ?? "spawn error"));
        kids.push(c);
        started++;
      } catch (e) {
        err = (e as { code?: string }).code ?? "throw";
        break;
      }
    }
    return new Promise((resolve) => setTimeout(() => {
      for (const k of kids) try { k.kill(); } catch { /* ignore */ }
      resolve({ ok: true, detail: `started=${started};err=${err}` });
    }, 300));
  },
  tmpfill: () => {
    const fs = mod("node:fs");
    const chunk = new Uint8Array(1024 * 1024);
    let mb = 0;
    try {
      for (; mb < 512; mb++) fs.appendFileSync("/tmp/fill", chunk);
    } catch (e) {
      return { ok: true, detail: `wrote=${mb}MiB;err=${(e as { code?: string }).code}` };
    }
    return { ok: true, detail: `wrote=${mb}MiB;err=none` };
  },
  logflood: () => {
    const line = "x".repeat(1000);
    for (let i = 0; i < 5000; i++) console.log(line);
    return { ok: true, detail: "flooded" };
  },
  forge: async (_input: Record<string, never>, ctx) => {
    // A service call after the query returned (background) must be refused by the host.
    setTimeout(() => {
      ctx.services.call("todo", {}).catch((e: { code?: string }) => console.log(`background service call refused: ${e.code}`));
    }, 50);
    let direct = "";
    try {
      await ctx.services.call("nope", {});
      direct = "ALLOWED";
    } catch (e) {
      direct = (e as { code?: string }).code ?? "ERR";
    }
    return { ok: true, detail: `ungranted=${direct}` };
  },
  big: () => ({ ok: true, blob: "y".repeat(70 * 1024) }),
  nested: async (_input: Record<string, never>, ctx) => {
    try {
      await ctx.services.call("anything", {});
      return { ok: true, detail: "nested=ALLOWED" };
    } catch (e) {
      return { ok: true, detail: `nested=${(e as { code?: string }).code}` };
    }
  },
  slow: (input: { ms: number }) => new Promise((r) => setTimeout(() => r({ ok: true, detail: `slept ${input.ms}` }), input.ms)),
});

function touchAll(records: readonly { id: string; recordVersion: number; data: Record<string, unknown> }[]): Mutation[] {
  return records.map((r) => ({ kind: "update", recordId: r.id, expectedRecordVersion: r.recordVersion, changes: { note: `t${String(r.data.note ?? "").length}` } }));
}

export const commands = defineCommands({
  add: (input: { n: number }) => ({
    result: { n: input.n },
    mutations: Array.from({ length: input.n }, (_v, i) => ({ kind: "create" as const, localKey: `k${i}`, data: { note: `n${i}` } })),
  }),
  touch: (_input: Record<string, never>, ctx) => {
    const m = touchAll(ctx.records);
    return { result: { n: m.length }, mutations: m };
  },
  slowTouch: (input: { ms: number }, ctx) =>
    new Promise((resolve) => setTimeout(() => {
      const m = touchAll(ctx.records);
      resolve({ result: { n: m.length }, mutations: m });
    }, input.ms)),
  sneaky: (_input: Record<string, never>, ctx) => {
    // Writes a field it did not declare (done does not even exist here) → the host must reject the whole plan.
    // It behaves only on small collections so the preview health check (2 fixture records) passes.
    if (ctx.records.length < 3) return { result: { n: 0 }, mutations: [] };
    const m: Mutation[] = ctx.records.map((r) => ({ kind: "update", recordId: r.id, expectedRecordVersion: r.recordVersion, changes: { note: "x", done: true } }));
    return { result: { n: m.length }, mutations: m };
  },
});
