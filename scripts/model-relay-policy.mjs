// Review F06: the forwarder holds the real model key, so where it may send it is checked before anything is sent.
// No default upstream: AGENTOS_MODEL_BASE_URL must be given, must be https, and its host must be named again in
// AGENTOS_MODEL_ALLOWED_HOSTS (the explicit confirmation). Every request path is resolved against that origin and must
// stay on it; redirects are never followed (a 3xx is answered as an error, so a key never goes to another origin).

/** @returns {{ origin: string, basePath: string }} */
export function upstreamFrom(env) {
  const raw = (env.AGENTOS_MODEL_BASE_URL ?? "").trim();
  if (!raw) throw new Error("AGENTOS_MODEL_BASE_URL is required with a real key (no default upstream)");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`AGENTOS_MODEL_BASE_URL is not a URL: ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error("AGENTOS_MODEL_BASE_URL must be https");
  if (u.username || u.password) throw new Error("AGENTOS_MODEL_BASE_URL must not carry credentials");
  if (u.search || u.hash) throw new Error("AGENTOS_MODEL_BASE_URL must not carry a query or fragment");
  const allowed = (env.AGENTOS_MODEL_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(u.host.toLowerCase())) {
    throw new Error(`upstream host ${u.host} is not confirmed: name it in AGENTOS_MODEL_ALLOWED_HOSTS`);
  }
  return { origin: u.origin, basePath: u.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "") };
}

/** The URL one relayed request goes to; refuses anything that would leave the confirmed origin. */
export function targetFor(up, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f]/.test(path)) {
    throw new Error(`refused relay path ${JSON.stringify(path)}`);
  }
  const t = new URL(up.origin + up.basePath + path);
  if (t.origin !== up.origin || t.username || t.password) throw new Error(`refused relay path ${JSON.stringify(path)} (leaves ${up.origin})`);
  if (!t.pathname.startsWith(`${up.basePath}/v1/`)) throw new Error(`refused relay path ${JSON.stringify(path)} (only ${up.basePath}/v1/...)`);
  return t.href;
}

/** Headers sent upstream: the box's own credentials and hop headers never travel; the key is added here only. */
export function upstreamHeaders(itemHeaders, key) {
  const h = {};
  for (const [k, v] of Object.entries(itemHeaders ?? {})) {
    const n = k.toLowerCase();
    if (["authorization", "cookie", "host", "content-length", "connection", "accept-encoding", "proxy-authorization", "x-api-key"].includes(n)) continue;
    h[n] = v;
  }
  h.authorization = `Bearer ${key}`;
  return h;
}

/** fetch() for the upstream: redirects are refused, never followed. */
export async function fetchUpstream(url, init, fetchImpl = fetch) {
  const r = await fetchImpl(url, { ...init, redirect: "manual" });
  if ((r.status >= 300 && r.status < 400) || r.type === "opaqueredirect") {
    throw new Error(`upstream answered a redirect (${r.status}); not followed`);
  }
  return r;
}
