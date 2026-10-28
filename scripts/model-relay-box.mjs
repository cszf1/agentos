#!/usr/bin/env node
// Development-only model relay (E01–E03 on the test machine without a model key on it).
// 127.0.0.1:RELAY_LOCAL_PORT  : OpenAI-compatible endpoint the AgentOS host calls (no key needed here).
// 127.0.0.1:RELAY_PUBLIC_PORT  : long-poll endpoint (reach it over an SSH port-forward) for the developer-side forwarder (token required).
// The forwarder, which holds the key, fetches each request, calls the provider and posts the answer back.
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

const LOCAL = Number(process.env.RELAY_LOCAL_PORT || 4500);
const PUBLIC = Number(process.env.RELAY_PUBLIC_PORT || 4501);
const TOKEN = process.env.RELAY_TOKEN;
if (!TOKEN || TOKEN.length < 32) throw new Error("RELAY_TOKEN (>= 32 chars) is required");
const queue = [];
const waiting = new Map();
const pollers = [];

const ok = (t) => typeof t === "string" && t.length === TOKEN.length && timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const id = randomUUID();
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers.host;
    const item = { id, method: req.method, path: req.url, headers, body: Buffer.concat(chunks).toString("base64") };
    waiting.set(id, res);
    const p = pollers.shift();
    if (p) p(item);
    else queue.push(item);
    setTimeout(() => {
      if (waiting.has(id)) {
        waiting.delete(id);
        res.writeHead(504).end("relay timeout");
      }
    }, 300_000).unref();
  });
}).listen(LOCAL, "127.0.0.1");

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (!ok(url.searchParams.get("token"))) return res.writeHead(404).end();
  if (req.method === "GET" && url.pathname === "/poll") {
    const send = (item) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(item));
    const item = queue.shift();
    if (item) return send(item);
    let done = false;
    const cb = (it) => {
      if (done) return queue.unshift(it);
      done = true;
      send(it);
    };
    pollers.push(cb);
    setTimeout(() => {
      if (done) return;
      done = true;
      const i = pollers.indexOf(cb);
      if (i >= 0) pollers.splice(i, 1);
      res.writeHead(204).end();
    }, 25_000);
    return;
  }
  if (req.method === "POST" && url.pathname === "/respond") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const r = JSON.parse(Buffer.concat(chunks).toString());
      const target = waiting.get(r.id);
      if (target) {
        waiting.delete(r.id);
        target.writeHead(r.status, r.headers).end(Buffer.from(r.body, "base64"));
      }
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PUBLIC, process.env.RELAY_PUBLIC_HOST || "127.0.0.1");
console.log(JSON.stringify({ relay: "up", local: LOCAL, public: PUBLIC }));
