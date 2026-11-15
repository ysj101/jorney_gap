import type { JourneyGapExporter } from "../packages/web/src/index.js";

type ReadableSpan = Parameters<
  JourneyGapExporter["exporter"]["export"]
>[0][number];

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  validateConfig,
  validateExporterConfig,
} from "../packages/core/src/index.js";
import {
  getJourneyGapClient,
  initJourneyGap,
} from "../packages/web/src/index.js";

const config = {
  schemaVersion: 1 as const,
  enabled: true,
  serviceName: "sample-web",
  consent: { mode: "opt-in" as const, ui: "external" as const },
  journeys: [
    {
      id: "task",
      steps: [{ id: "started" }, { id: "done", terminal: true }],
      timeoutMinutes: 30,
    },
  ],
};
let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://example.org",
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
});
afterEach(async () => {
  await getJourneyGapClient()?.shutdown();
  dom.window.close();
  vi.unstubAllGlobals();
});
it("validates an endpoint-free configuration without changing legacy validation", () => {
  expect(validateExporterConfig(config).valid).toBe(true);
  expect(validateConfig(config).valid).toBe(false);
  expect(
    validateExporterConfig({
      ...config,
      otlpTracesEndpoint: "https://example.org/v1/traces",
    }).valid,
  ).toBe(false);
  expect(validateExporterConfig({ ...config, headers: {} }).valid).toBe(false);
  expect(
    validateConfig({
      ...config,
      otlpTracesEndpoint: "https://example.org/v1/traces",
    }).valid,
  ).toBe(true);
});
it("creates fresh exporters only after grant, discards on withdrawal and exposes standard spans", async () => {
  const spans: ReadableSpan[] = [];
  const discard = vi.fn();
  const shutdown = vi.fn(async () => {});
  const createExporter = vi.fn(() => ({
    exporter: {
      export(batch: ReadableSpan[], callback: (r: { code: number }) => void) {
        spans.push(...batch);
        callback({ code: 0 });
      },
      shutdown,
    },
    discard,
  }));
  const client = initJourneyGap(config, { createExporter });
  client.trackStep("task", "started");
  expect(createExporter).not.toHaveBeenCalled();
  client.setConsent(true);
  client.trackStep("task", "started");
  client.trackStep("task", "done");
  await client.flush?.();
  expect(createExporter).toHaveBeenCalledTimes(1);
  const steps = spans.filter((s) => s.name === "journeygap.step");
  expect(steps).toHaveLength(2);
  expect(steps[0]?.attributes["journeygap.step_id"]).toBe("started");
  client.setConsent(false);
  expect(discard).toHaveBeenCalledTimes(1);
  client.setConsent(true);
  expect(createExporter).toHaveBeenCalledTimes(2);
});
it("contains exporter factory failures and leaves consent inactive", async () => {
  const client = initJourneyGap(config, {
    createExporter: () => {
      throw new Error("adapter failure");
    },
  });
  expect(() => client.setConsent(true)).not.toThrow();
  expect(client.getConsent()).toBe(false);
  await expect(client.flush?.()).resolves.toBeUndefined();
});
it("withdrawal releases a custom exporter that never calls its callback", async () => {
  const discard = vi.fn();
  const client = initJourneyGap(config, {
    createExporter: () => ({
      exporter: { export() {}, shutdown: async () => {} },
      discard,
    }),
  });
  client.setConsent(true);
  client.trackStep("task", "started");
  const flushing = client.flush?.();
  client.setConsent(false);
  await flushing;
  await client.shutdown();
  expect(discard).toHaveBeenCalled();
});
