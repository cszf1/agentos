// Review F13: one product release (1.0.0) everywhere it is reported; the Host runtime line stays separate.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_RUNTIME_VERSION, HOST_VERSION, PRODUCT_VERSION } from "@agentos/contracts";

const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("product and runtime versions (F13)", () => {
  it("the product release is the same in package metadata, Cargo, Nix packages, the release manifest and the desktop", () => {
    expect(PRODUCT_VERSION).toBe("1.0.0");
    expect(JSON.parse(read("package.json")).version).toBe(PRODUCT_VERSION);
    expect(read("native/Cargo.toml")).toMatch(new RegExp(`\\[workspace\\.package\\]\\nversion = "${PRODUCT_VERSION}"`));
    for (const m of read("native/Cargo.lock").matchAll(/name = "(agentos-[^"]+)"\nversion = "([^"]+)"/g)) expect([m[1], m[2]]).toEqual([m[1], PRODUCT_VERSION]);
    for (const p of ["os/packages/native.nix", "os/packages/node.nix", "desktop/package.nix"]) expect(read(p)).toContain(`version = "${PRODUCT_VERSION}";`);
    expect(read("os/release.nix")).toContain(`version ? "${PRODUCT_VERSION}"`);
  });

  it("the Host runtime compatibility line is its own value and is never the product release", () => {
    expect(HOST_RUNTIME_VERSION).toBe(HOST_VERSION);
    expect(HOST_VERSION).toMatch(/^0\.4\./);
    expect(HOST_VERSION).not.toBe(PRODUCT_VERSION);
  });
});
