import { expect, it } from "vitest";
import { publicModelEndpoint } from "../../packages/agent-pi/src/models.js";

it("only exposes an endpoint without embedded credentials or query secrets", () => {
  expect(publicModelEndpoint("https://model.example.test/v1")).toEqual({ baseUrl: "https://model.example.test/v1" });
  for (const url of [undefined, "https://user:password@example.test/v1", "https://example.test/v1?key=faux", "https://example.test/#faux", "invalid"]) {
    expect(publicModelEndpoint(url)).toEqual({});
  }
});
