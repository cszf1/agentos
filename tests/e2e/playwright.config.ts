import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  use: { headless: true, viewport: { width: 1400, height: 900 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
  outputDir: "../../test-results",
});
