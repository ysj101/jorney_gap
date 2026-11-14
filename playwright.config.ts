import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: { browserName: "chromium", headless: true },
  reporter: "list",
  outputDir: "test-results",
});
