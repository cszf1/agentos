#!/usr/bin/env node
// Developer-side forwarder for model-relay-box.mjs: long-polls the relay, calls the real provider with the key that
// exists only on this side (AGENTOS_MODEL_API_KEY), and posts the full response back. Dev/acceptance use only.
const RELAY = process.env.RELAY_URL; // e.g. https://4501-<box>.instabox.tech
const TOKEN = process.env.RELAY_TOKEN;
const UPSTREAM = (process.env.AGENTOS_MODEL_BASE_URL || "https://tokenrhythm.studio/v1").replace(/\/v1\/?$/, "");
const KEY = process.env.AGENTOS_MODEL_API_KEY;
if (!RELAY || !TOKEN || !KEY) throw new Error("RELAY_URL, RELAY_TOKEN and AGENTOS_MODEL_API_KEY are required");
let served = 0;
async function handle(item) {
  try {
    const headers = { ...item.headers, authorization: `Bearer ${KEY}` };
    delete headers["content-length"];
    delete headers.connection;
    delete headers["accept-encoding"];
    const r = await fetch(`${UPSTREAM}${item.path}`, { method: item.method, headers, body: item.method === "GET" ? undefined : Buffer.from(item.body, "base64") });
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
  }
}
for (;;) {
  try {
    const r = await fetch(`${RELAY}/poll?token=${TOKEN}`);
    if (r.status === 200) void handle(await r.json());
    else if (r.status !== 204) await new Promise((res) => setTimeout(res, 2000));
  } catch (e) {
    console.error("poll failed", e.message);
    await new Promise((res) => setTimeout(res, 2000));
  }
}
