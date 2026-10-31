#!/usr/bin/env node
// Developer-side forwarder for model-relay-box.mjs: long-polls the relay, calls the real provider with the key that
// exists only on this side (AGENTOS_MODEL_API_KEY), and posts the full response back. Dev/acceptance use only.
import { fetchUpstream, targetFor, upstreamFrom, upstreamHeaders } from "./model-relay-policy.mjs";
const RELAY = process.env.RELAY_URL; // the relay base URL (https)
const TOKEN = process.env.RELAY_TOKEN;
const KEY = process.env.AGENTOS_MODEL_API_KEY;
if (!RELAY || !TOKEN || !KEY) throw new Error("RELAY_URL, RELAY_TOKEN and AGENTOS_MODEL_API_KEY are required");
// review F06: explicit https upstream, confirmed host, no redirects (see model-relay-policy.mjs)
const UP = upstreamFrom(process.env);
let served = 0;
let inflight = 0;
// FORWARD_MAX_MS: stop polling after this long and exit once in-flight answers are posted (a supervisor restarts it),
// so a forwarder is never killed while it holds a request.
const MAX_MS = Number(process.env.FORWARD_MAX_MS || 0);
const startedAt = Date.now();
async function handle(item) {
  inflight++;
  try {
    const url = targetFor(UP, item.path);
    const headers = upstreamHeaders(item.headers, KEY);
    const r = await fetchUpstream(url, { method: item.method, headers, body: item.method === "GET" ? undefined : Buffer.from(item.body, "base64") });
    const body = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) h[k] = v;
    });
    await fetch(`${RELAY}/respond?token=${TOKEN}`, { method: "POST", body: JSON.stringify({ id: item.id, status: r.status, headers: h, body: body.toString("base64") }) });
    served++;
    console.log(new Date().toISOString(), item.method, item.path, r.status, body.length, `served=${served}`);
  } catch (e) {
    await fetch(`${RELAY}/respond?token=${TOKEN}`, { method: "POST", body: JSON.stringify({ id: item.id, status: 502, headers: {}, body: Buffer.from(String(e.message)).toString("base64") }) }).catch(() => {});
  } finally {
    inflight--;
  }
}
for (;;) {
  if (MAX_MS && Date.now() - startedAt > MAX_MS) {
    while (inflight > 0) await new Promise((res) => setTimeout(res, 500));
    console.log(new Date().toISOString(), `max runtime reached, served=${served}`);
    process.exit(0);
  }
  try {
    const r = await fetch(`${RELAY}/poll?token=${TOKEN}`);
    if (r.status === 200) void handle(await r.json());
    else if (r.status !== 204) await new Promise((res) => setTimeout(res, 2000));
  } catch (e) {
    console.error("poll failed", e.message);
    await new Promise((res) => setTimeout(res, 2000));
  }
}
