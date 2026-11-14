import { JSDOM } from "jsdom";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from "vitest";
import { analyze, type JourneyGapConfig } from "../packages/core/src/index.js";
import { CONSENT_KEY, SESSION_KEY } from "../packages/web/src/consent.js";
import {
  getJourneyGapClient,
  initJourneyGap,
  trackStep,
} from "../packages/web/src/index.js";
import type { WebEvent } from "../packages/web/src/transport.js";
import * as transport from "../packages/web/src/transport.js";
import { journey, syntheticId } from "./fixtures/journeys.js";

const config: JourneyGapConfig = {
  schemaVersion: 1,
  enabled: true,
  serviceName: "sample-web",
  otlpTracesEndpoint: "https://ingest.example.test/v1/traces",
  consent: { mode: "opt-in", ui: "external" },
  journeys: [journey, { ...journey, id: "second-task" }],
  attributesAllowlist: ["app.category", "app.email"],
};
let dom: JSDOM;
let events: WebEvent[];
let factory: MockInstance<typeof transport.createTelemetry>;
let discard: Mock<() => void>;
let shutdown: Mock<() => Promise<void>>;
beforeEach(() => {
  dom = new JSDOM(
    "<!doctype html><html><body><main><button id='app-button'>App</button></main></body></html>",
    { url: "https://app.example.test" },
  );
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}")),
  );
  events = [];
  discard = vi.fn();
  shutdown = vi.fn(async () => {});
  factory = vi.spyOn(transport, "createTelemetry").mockImplementation(() => ({
    // Manual API behavior is isolated here; navigation has its own lifecycle tests.
    record: (event) => {
      if (event.eventType !== "navigation") events.push(structuredClone(event));
    },
    discard,
    shutdown,
    flush: async () => {},
    stats: () => ({
      dropped: 0,
      exported: 0,
      failed: 0,
      queued: events.length,
      inFlight: 0,
      requests: 0,
    }),
  }));
});
afterEach(async () => {
  await getJourneyGapClient()?.shutdown();
  dom.window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("creates no telemetry, events, IDs or network requests before explicit consent", () => {
  const random = vi.spyOn(crypto, "randomUUID");
  trackStep("first-task", "started");
  expect(getJourneyGapClient()).toBeNull();
  const client = initJourneyGap(config);
  client.trackStep("first-task", "started");
  client.trackError("network");
  expect(client.getConsent()).toBe(false);
  expect(factory).not.toHaveBeenCalled();
  expect(random).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(events).toEqual([]);
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
});

it("keeps external consent authoritative even if a previous compact choice was granted", () => {
  window.localStorage.setItem(CONSENT_KEY, "true");
  const client = initJourneyGap(config);
  expect(factory).not.toHaveBeenCalled();
  expect(document.querySelector("aside")).toBeNull();
  client.setConsent(true);
  client.trackStep("first-task", "started");
  expect(factory).toHaveBeenCalledTimes(1);
  expect(events).toHaveLength(1);
  expect(client.getConsent()).toBe(true);
  expect(window.localStorage.getItem(CONSENT_KEY)).toBe("true");
  expect(Object.keys(window.sessionStorage)).toEqual([SESSION_KEY]);
  expect(events[0]?.sessionId).toBe(window.sessionStorage.getItem(SESSION_KEY));
});

it("immediately discards on refusal or withdrawal, removes the session and preserves the app", () => {
  let clicks = 0;
  document
    .querySelector("#app-button")
    ?.addEventListener("click", () => clicks++);
  const client = initJourneyGap(config);
  client.setConsent(false);
  expect(factory).not.toHaveBeenCalled();
  client.setConsent(true);
  client.trackStep("first-task", "started");
  client.setConsent(false);
  client.trackStep("first-task", "reviewed");
  expect(discard).toHaveBeenCalledTimes(1);
  expect(client.getConsent()).toBe(false);
  expect(events).toHaveLength(1);
  expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  expect(window.localStorage.getItem(CONSENT_KEY)).toBe("false");
  (document.querySelector("#app-button") as HTMLButtonElement).click();
  expect(clicks).toBe(1);
});

it("offers equal native keyboard-accessible choices and keeps withdrawal controls available", () => {
  const client = initJourneyGap({
    ...config,
    consent: { mode: "opt-in", ui: "compact" },
  });
  const choices = [
    ...document.querySelectorAll("aside button"),
  ] as HTMLButtonElement[];
  expect(
    choices.map((button) => [button.textContent, button.type, button.disabled]),
  ).toEqual([
    ["許可", "button", false],
    ["拒否", "button", false],
  ]);
  expect(document.querySelector("aside")?.hasAttribute("aria-modal")).toBe(
    false,
  );
  expect(factory).not.toHaveBeenCalled();
  choices[0]?.click();
  expect(client.getConsent()).toBe(true);
  expect(document.querySelector("[aria-live]")?.textContent).toContain("許可");
  choices[1]?.click();
  expect(client.getConsent()).toBe(false);
  expect(document.querySelectorAll("aside button")).toHaveLength(2);
});

it("initializes idempotently, suppresses same-turn StrictMode repeats and cleans up for reinitialization", async () => {
  const client = initJourneyGap(config);
  expect(initJourneyGap(config)).toBe(client);
  expect(getJourneyGapClient()).toBe(client);
  client.setConsent(true);
  client.setConsent(true);
  trackStep("first-task", "started");
  trackStep("first-task", "started");
  expect(factory).toHaveBeenCalledTimes(1);
  expect(events).toHaveLength(1);
  await Promise.resolve();
  trackStep("first-task", "started");
  expect(events).toHaveLength(2);
  expect(events[0]).not.toMatchObject({
    instanceId:
      "instanceId" in (events[1] ?? {})
        ? (events[1] as Extract<WebEvent, { eventType: "step" }>).instanceId
        : "missing",
  });
  await client.shutdown();
  await client.shutdown();
  expect(getJourneyGapClient()).toBeNull();
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(initJourneyGap(config)).not.toBe(client);
});

it("tracks two independent journeys, new instances, explicit errors and sanitized attributes", () => {
  const client = initJourneyGap(config);
  client.setConsent(true);
  client.trackStep("first-task", "started", {
    "app.category": "demo",
    "app.email": "fake@example.test",
  });
  client.trackStep("second-task", "started");
  client.trackStep("first-task", "reviewed");
  client.trackStep("second-task", "reviewed");
  client.trackStep("first-task", "completed");
  client.trackStep("second-task", "completed");
  client.trackError("network");
  const steps = events
    .filter(
      (event): event is Extract<WebEvent, { eventType: "step" }> =>
        event.eventType === "step",
    )
    .map((event) => ({ ...event, schemaVersion: 1 as const }));
  for (const definition of config.journeys)
    expect(analyze(steps, definition, Date.now()).observedCompletions).toBe(1);
  expect(events[0]?.attributes).toEqual({ "app.category": "demo" });
  expect(new Set(events.map((event) => event.eventId)).size).toBe(7);
  expect(events.at(-1)).toMatchObject({
    eventType: "error",
    errorKind: "network",
  });
});

it("ignores undefined combinations and pre-start steps but retains valid out-of-order observations", () => {
  const client = initJourneyGap(config);
  client.setConsent(true);
  client.trackStep("missing", "started");
  client.trackStep("first-task", "missing");
  client.trackStep("first-task", "reviewed");
  expect(events).toHaveLength(0);
  client.trackStep("first-task", "started");
  client.trackStep("first-task", "completed");
  expect(events).toHaveLength(2);
  const steps = events
    .filter(
      (event): event is Extract<WebEvent, { eventType: "step" }> =>
        event.eventType === "step",
    )
    .map((event) => ({ ...event, schemaVersion: 1 as const }));
  expect(analyze(steps, journey, Date.now())).toMatchObject({
    observedStarts: 1,
    observedCompletions: 0,
    outOfOrderEvents: 1,
  });
});

it("resumes a compact tab session after shutdown, but rotates a session copied from an opener", async () => {
  const compact = {
    ...config,
    consent: { mode: "opt-in", ui: "compact" },
  } as const;
  const client = initJourneyGap(compact);
  client.setConsent(true);
  const previous = window.sessionStorage.getItem(SESSION_KEY);
  await client.shutdown();
  const next = initJourneyGap(compact);
  expect(next.getConsent()).toBe(true);
  expect(window.sessionStorage.getItem(SESSION_KEY)).toBe(previous);
  await next.shutdown();
  const inherited = syntheticId(55);
  window.sessionStorage.setItem(SESSION_KEY, inherited);
  Object.defineProperty(window, "opener", {
    value: {
      [Symbol.for("journeygap.client.v1")]: {
        client: {},
        session: () => inherited,
      },
    },
  });
  initJourneyGap(compact);
  expect(window.sessionStorage.getItem(SESSION_KEY)).not.toBe(inherited);
});

it("propagates withdrawal from another tab, including clearing consent storage", () => {
  const client = initJourneyGap(config);
  client.setConsent(true);
  window.dispatchEvent(
    new dom.window.StorageEvent("storage", {
      key: CONSENT_KEY,
      newValue: "false",
    }),
  );
  expect(client.getConsent()).toBe(false);
  client.setConsent(true);
  window.dispatchEvent(new dom.window.StorageEvent("storage", { key: null }));
  expect(client.getConsent()).toBe(false);
  expect(discard).toHaveBeenCalledTimes(2);
});

it("fails open for storage, exporter initialization, invalid configuration and disabled SDK", async () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("storage disabled");
  });
  const client = initJourneyGap(config);
  client.setConsent(true);
  client.trackStep("first-task", "started");
  expect(events).toHaveLength(1);
  await client.shutdown();
  factory.mockImplementation(() => {
    throw new Error("exporter unavailable");
  });
  expect(() => initJourneyGap(config).setConsent(true)).not.toThrow();
  expect(() => trackStep("first-task", "started")).not.toThrow();
  await getJourneyGapClient()?.shutdown();
  expect(
    initJourneyGap({
      ...config,
      otlpTracesEndpoint: "javascript:bad",
    }).getConsent(),
  ).toBe(false);
  expect(getJourneyGapClient()).toBeNull();
  factory.mockClear();
  const disabled = initJourneyGap({ ...config, enabled: false });
  disabled.setConsent(true);
  disabled.trackError("unknown");
  expect(disabled.getConsent()).toBe(false);
  expect(factory).not.toHaveBeenCalled();
});
