// Review F06: the developer-side forwarder never sends the real key to an unconfirmed or redirected origin.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper without types
import { fetchUpstream, targetFor, upstreamFrom, upstreamHeaders } from "../../scripts/model-relay-policy.mjs";

describe("model relay forwarder policy (F06)", () => {
  it("has no default upstream and needs https plus an explicitly confirmed host", () => {
    expect(() => upstreamFrom({})).toThrow(/required/);
    expect(() => upstreamFrom({ AGENTOS_MODEL_BASE_URL: "http://models.example/v1", AGENTOS_MODEL_ALLOWED_HOSTS: "models.example" })).toThrow(/https/);
    expect(() => upstreamFrom({ AGENTOS_MODEL_BASE_URL: "https://models.example/v1" })).toThrow(/not confirmed/);
    expect(() => upstreamFrom({ AGENTOS_MODEL_BASE_URL: "https://models.example/v1", AGENTOS_MODEL_ALLOWED_HOSTS: "other.example" })).toThrow(/not confirmed/);
    expect(() => upstreamFrom({ AGENTOS_MODEL_BASE_URL: "https://u:p@models.example/v1", AGENTOS_MODEL_ALLOWED_HOSTS: "models.example" })).toThrow(/credentials/);
    expect(upstreamFrom({ AGENTOS_MODEL_BASE_URL: "https://models.example/api/v1", AGENTOS_MODEL_ALLOWED_HOSTS: " Models.example " })).toEqual({ origin: "https://models.example", basePath: "/api" });
  });

  it("keeps every relayed path on the confirmed origin under /v1/", () => {
    const up = upstreamFrom({ AGENTOS_MODEL_BASE_URL: "https://models.example/v1", AGENTOS_MODEL_ALLOWED_HOSTS: "models.example" });
    expect(targetFor(up, "/v1/chat/completions")).toBe("https://models.example/v1/chat/completions");
    for (const bad of ["@evil.example/v1/x", "//evil.example/v1/x", "https://evil.example/v1/x", "/v1/../admin", "/admin", "/v1\\x", "/v1/x\n", 7]) {
      expect(() => targetFor(up, bad)).toThrow(/refused/);
    }
  });

  it("drops the box's credentials and hop headers; adds only the forwarder's key", () => {
    const h = upstreamHeaders({ Authorization: "Bearer box", cookie: "c", Host: "evil", "content-type": "application/json", "X-Api-Key": "k" }, "real");
    expect(h).toEqual({ "content-type": "application/json", authorization: "Bearer real" });
  });

  it("never follows a redirect", async () => {
    const seen: unknown[] = [];
    const fake = async (_u: string, init: { redirect: string }) => {
      seen.push(init.redirect);
      return { status: 307, type: "basic", headers: new Map([["location", "https://evil.example/"]]) };
    };
    await expect(fetchUpstream("https://models.example/v1/x", { method: "POST" }, fake)).rejects.toThrow(/redirect/);
    expect(seen).toEqual(["manual"]);
    const ok = async () => ({ status: 200, type: "basic" });
    await expect(fetchUpstream("https://models.example/v1/x", {}, ok)).resolves.toMatchObject({ status: 200 });
  });
});
