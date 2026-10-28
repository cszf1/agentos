import http from "node:http";

/** Podman libpod REST client over the user's local engine socket. Only the trusted host uses it. */
export class PodmanApi {
  constructor(readonly socketPath: string, readonly version = "v5.0.0") {}

  request(method: string, path: string, opts: { json?: unknown; body?: Buffer; contentType?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<{ status: number; body: Buffer }> {
    const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const payload = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : opts.body;
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: `/${this.version}${path}`,
          headers: {
            host: "d",
            ...(payload ? { "content-type": opts.json !== undefined ? "application/json" : (opts.contentType ?? "application/octet-stream"), "content-length": payload.length } : {}),
          },
          timeout: opts.timeoutMs ?? 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let n = 0;
          res.on("data", (c: Buffer) => {
            n += c.length;
            if (n <= maxBytes) chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`podman API ${method} ${path} timed out`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async json<T>(method: string, path: string, opts: Parameters<PodmanApi["request"]>[2] = {}): Promise<{ status: number; data: T }> {
    const r = await this.request(method, path, opts);
    let data: unknown = null;
    const text = r.body.toString("utf8");
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: r.status, data: data as T };
  }
}

export class PodmanError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PodmanError";
  }
}
