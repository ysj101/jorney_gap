import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { JourneyGapConfig } from "../packages/core/src/index.js";
import {
  configSchema,
  isDefinedStep,
  validateConfig,
  validateRelayConfig,
} from "../packages/core/src/index.js";

const firstJourney = {
  id: "first-task",
  steps: [{ id: "started" }, { id: "completed", terminal: true }],
  timeoutMinutes: 30,
};

const config = {
  schemaVersion: 1,
  enabled: true,
  serviceName: "sample-web",
  otlpTracesEndpoint: "https://ingest.example.org/v1/traces",
  consent: { mode: "opt-in", ui: "compact" },
  journeys: [firstJourney],
} satisfies JourneyGapConfig;

it("shares generated JSON with the source from which public types are inferred", () => {
  expect(
    JSON.parse(
      readFileSync("packages/core/schema/journeygap.schema.json", "utf8"),
    ),
  ).toEqual(configSchema);
  expect(validateConfig(config)).toEqual({ valid: true, value: config });
});

it("defaults timeout on a clone without mutating caller configuration", () => {
  const input = {
    ...config,
    journeys: [{ id: "first-task", steps: firstJourney.steps }],
  };
  const result = validateConfig(input);
  expect(result.valid).toBe(true);
  if (result.valid) expect(result.value.journeys[0]?.timeoutMinutes).toBe(30);
  expect(input.journeys[0]).not.toHaveProperty("timeoutMinutes");
});

it.each([
  "javascript:alert(1)",
  "https://ingest.example.org/v1/traces?token=private",
  "https://name:password@ingest.example.org/v1/traces",
  "http://ingest.example.org/v1/traces",
  "https://ingest.example.org/v1/logs",
  "https://ingest.example.org/v1/traces#fragment",
])(
  "rejects unsafe or incorrect endpoint without returning its contents: %s",
  (endpoint) => {
    const result = validateConfig({ ...config, otlpTracesEndpoint: endpoint });
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("password");
  },
);

it.each([
  "http://localhost:4318/v1/traces",
  "http://127.0.0.1:4318/v1/traces",
  "http://[::1]:4318/v1/traces",
  "https://ingest.example.org/otlp/v1/traces",
])("permits a safe endpoint %s", (endpoint) => {
  expect(
    validateConfig({ ...config, otlpTracesEndpoint: endpoint }).valid,
  ).toBe(true);
});

it("rejects duplicate journeys, duplicate steps, and invalid order definitions", () => {
  expect(
    validateConfig({ ...config, journeys: [firstJourney, firstJourney] }).valid,
  ).toBe(false);
  for (const steps of [
    [{ id: "started" }, { id: "started", terminal: true }],
    [{ id: "started" }, { id: "completed" }],
    [
      { id: "started", terminal: true },
      { id: "completed", terminal: true },
    ],
    [{ id: "completed", terminal: true }],
    Array.from({ length: 21 }, (_, n) => ({
      id: `step-${n}`,
      terminal: n === 20,
    })),
  ])
    expect(
      validateConfig({ ...config, journeys: [{ ...firstJourney, steps }] })
        .valid,
    ).toBe(false);
  for (const timeoutMinutes of [0, 1441, 1.5])
    expect(
      validateConfig({
        ...config,
        journeys: [{ ...firstJourney, timeoutMinutes }],
      }).valid,
    ).toBe(false);
});

it("rejects unknown keys, invalid IDs, secrets, and invalid attribute allowlists", () => {
  for (const mutation of [
    { schemaVersion: 2 },
    { serviceName: "Email@example.org" },
    { authorization: "secret" },
    { attributesAllowlist: ["email"] },
    { attributesAllowlist: ["app.x", "app.x"] },
    { consent: { mode: "opt-out", ui: "compact" } },
  ])
    expect(validateConfig({ ...config, ...mutation }).valid).toBe(false);
  expect(
    validateConfig({ ...config, attributesAllowlist: ["app.category"] }).valid,
  ).toBe(true);
});

it("validates simple routes and rejects regex or duplicate route IDs", () => {
  const routes = [
    { id: "root", pattern: "/" },
    { id: "item", pattern: "/items/:id" },
  ];
  expect(validateConfig({ ...config, routes }).valid).toBe(true);
  for (const pattern of [
    ".*",
    "/items/(.*)",
    "/items?token=x",
    "/:id:other",
    "//items",
  ])
    expect(
      validateConfig({ ...config, routes: [{ id: "bad", pattern }] }).valid,
    ).toBe(false);
  expect(
    validateConfig({ ...config, routes: [routes[0], routes[0]] }).valid,
  ).toBe(false);
});

it("accepts only defined journey/step combinations", () => {
  expect(isDefinedStep(config, "first-task", "started")).toBe(true);
  expect(isDefinedStep(config, "first-task", "missing")).toBe(false);
  expect(isDefinedStep(config, "missing", "started")).toBe(false);
});

it("shares journey constraints with Relay and validates origin and service boundaries", () => {
  const relay = {
    schemaVersion: 1,
    allowedOrigins: ["http://localhost:5173"],
    services: [{ serviceName: "sample-web", journeys: config.journeys }],
    retentionDays: 14,
    rateLimitPerMinute: 60,
  };
  expect(validateRelayConfig(relay).valid).toBe(true);
  for (const allowedOrigins of [
    ["*"],
    ["https://example.org/path"],
    ["http://public.example.org"],
    ["https://name:secret@example.org"],
    [],
  ])
    expect(validateRelayConfig({ ...relay, allowedOrigins }).valid).toBe(false);
  expect(
    validateRelayConfig({
      ...relay,
      services: [relay.services[0], relay.services[0]],
    }).valid,
  ).toBe(false);
  expect(validateRelayConfig({ ...relay, retentionDays: 0 }).valid).toBe(false);
});

it("handles untrusted non-JSON and oversized inputs without throwing", () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const input of [
    null,
    undefined,
    1n,
    cycle,
    { data: "x".repeat(262145) },
  ]) {
    expect(validateConfig(input).valid).toBe(false);
    expect(validateRelayConfig(input).valid).toBe(false);
  }
});
