import { defineConfig } from "@playwright/test";
import config from "./playwright.config.js";
export default defineConfig({
  ...config,
  testIgnore: [],
  testMatch: "**/collector.spec.ts",
  timeout: 120000,
});
