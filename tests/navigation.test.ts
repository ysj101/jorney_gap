import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getJourneyGapClient,
  initJourneyGap,
} from "../packages/web/src/index.js";
import {
  observeNavigation,
  resolveRoute,
} from "../packages/web/src/navigation.js";
import type { WebEvent } from "../packages/web/src/transport.js";
import * as transport from "../packages/web/src/transport.js";
import { journey } from "./fixtures/journeys.js";

const routes = [
  { id: "root", pattern: "/" },
  { id: "item", pattern: "/items/:id" },
  { id: "new-item", pattern: "/items/new" },
  { id: "flow", pattern: "/flow" },
];
let dom: JSDOM;
const observers: ReturnType<typeof observeNavigation>[] = [];
beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://app.example.test/",
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
});
afterEach(async () => {
  await getJourneyGapClient()?.shutdown();
  for (const observer of observers.splice(0)) observer.stop();
  dom.window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function observe(emit: (route: string) => void, enabled = () => true) {
  const value = observeNavigation(routes, emit, enabled);
  observers.push(value);
  return value;
}
function nativeShape() {
  // jsdom implements methods in JavaScript. Bound native-shape functions exercise
  // the browser patch path; real browser methods are verified in E2E.
  const prototype = Object.getPrototypeOf(window.history);
  for (const method of ["pushState", "replaceState"] as const)
    Object.defineProperty(prototype, method, {
      value: window.history[method].bind(window.history),
      writable: true,
      configurable: true,
    });
}

it("matches categorical templates without exposing dynamic values, queries or fragments", () => {
  expect(
    resolveRoute(routes, "/items/synthetic-id?email=fake@example.test#private"),
  ).toBe("item");
  expect(resolveRoute(routes, "/items/new")).toBe("new-item");
  expect(resolveRoute(routes, "/items/one/two")).toBe("unknown");
  expect(resolveRoute(routes, "/items/")).toBe("unknown");
  expect(resolveRoute(routes, "/flow/")).toBe("flow");
  expect(resolveRoute(routes, "/", "#/items/123?secret=dummy#private")).toBe(
    "item",
  );
  expect(resolveRoute(routes, "/flow", "#private-identifier")).toBe("flow");
  expect(resolveRoute(routes, "/demo/items/123", "", "/demo/")).toBe("item");
});

it("patches and restores native History methods, deduplicating consecutive route IDs", () => {
  nativeShape();
  const originalPush = window.history.pushState;
  const originalReplace = window.history.replaceState;
  const ids: string[] = [];
  const observer = observe((id) => ids.push(id));
  expect(observer.isPatched()).toBe(true);
  observer.refresh();
  window.history.pushState(
    { app: "unchanged" },
    "",
    "/items/123?dummy=private",
  );
  window.history.replaceState(null, "", "/items/456");
  window.history.pushState(null, "", "/flow");
  expect(ids).toEqual(["root", "item", "flow"]);
  expect(window.location.pathname).toBe("/flow");
  observer.stop();
  expect(window.history.pushState).toBe(originalPush);
  expect(window.history.replaceState).toBe(originalReplace);
  window.history.pushState(null, "", "/");
  expect(ids).toHaveLength(3);
});

it("preserves original History exceptions and application state", () => {
  nativeShape();
  const emit = vi.fn();
  observe(emit);
  expect(() =>
    window.history.pushState(null, "", "https://other.example.test/"),
  ).toThrow();
  expect(emit).not.toHaveBeenCalled();
  const state = { answer: "synthetic-app-only-value" };
  window.history.pushState(state, "", "/flow");
  expect(window.history.state).toEqual(state);
  expect(emit).toHaveBeenCalledExactlyOnceWith("flow");
});

it("keeps foreign patches and uses popstate/hashchange fallback", () => {
  nativeShape();
  const original = window.history.pushState.bind(window.history);
  const foreign = vi.fn((...args: Parameters<History["pushState"]>) =>
    original(...args),
  );
  window.history.pushState = foreign;
  const ids: string[] = [];
  const observer = observe((id) => ids.push(id));
  expect(observer.isPatched()).toBe(false);
  expect(window.history.pushState).toBe(foreign);
  window.history.pushState(null, "", "/flow");
  window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  expect(ids).toEqual(["flow"]);
  window.location.hash = "/items/123?dummy=private";
  window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  expect(ids).toEqual(["flow", "item"]);
  observer.stop();
  expect(window.history.pushState).toBe(foreign);
});

it("falls back when History cannot be extended", () => {
  nativeShape();
  Object.preventExtensions(window.history);
  const ids: string[] = [];
  const observer = observe((id) => ids.push(id));
  expect(observer.isPatched()).toBe(false);
  window.history.pushState(null, "", "/flow");
  window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  expect(ids).toEqual(["flow"]);
});

it("does not overwrite a later foreign wrapper during shutdown", () => {
  nativeShape();
  const emit = vi.fn();
  const observer = observe(emit);
  const ours = window.history.pushState;
  const foreign: History["pushState"] = function (this: History, ...args) {
    return Reflect.apply(ours, this, args);
  };
  window.history.pushState = foreign;
  observer.stop();
  expect(window.history.pushState).toBe(foreign);
  window.history.pushState(null, "", "/flow");
  expect(emit).not.toHaveBeenCalled();
});

it("stays silent while consent is off, then emits the current route and respects an explicit base", () => {
  let enabled = false;
  const ids: string[] = [];
  const observer = observe(
    (id) => ids.push(id),
    () => enabled,
  );
  window.history.pushState(null, "", "/demo/items/123");
  const base = document.createElement("base");
  base.href = "/demo/";
  document.head.append(base);
  observer.refresh();
  expect(ids).toEqual([]);
  enabled = true;
  observer.refresh();
  expect(ids).toEqual(["item"]);
  observer.reset();
  observer.refresh();
  expect(ids).toEqual(["item", "item"]);
});

it("connects initial/current navigation to consent and removes listeners on shutdown", async () => {
  nativeShape();
  const events: WebEvent[] = [];
  vi.spyOn(transport, "createTelemetry").mockImplementation(() => ({
    record: (event) => events.push(event),
    discard() {},
    shutdown: async () => {},
    flush: async () => {},
    stats: () => ({
      dropped: 0,
      exported: 0,
      failed: 0,
      queued: 0,
      inFlight: 0,
      requests: 0,
    }),
  }));
  const client = initJourneyGap({
    schemaVersion: 1,
    enabled: true,
    serviceName: "sample-web",
    otlpTracesEndpoint: "https://example.test/v1/traces",
    consent: { mode: "opt-in", ui: "external" },
    journeys: [journey],
    routes,
  });
  window.history.pushState(null, "", "/items/123");
  expect(events).toEqual([]);
  client.setConsent(true);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ eventType: "navigation", routeId: "item" });
  window.history.pushState(null, "", "/items/456");
  expect(events).toHaveLength(1);
  window.history.pushState(null, "", "/flow");
  expect(events).toHaveLength(2);
  client.setConsent(false);
  window.history.pushState(null, "", "/");
  expect(events).toHaveLength(2);
  client.setConsent(true);
  expect(events).toHaveLength(3);
  expect(events[2]).toMatchObject({ routeId: "root" });
  await client.shutdown();
  window.history.pushState(null, "", "/flow");
  window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  expect(events).toHaveLength(3);
  expect(JSON.stringify(events)).not.toContain("/items/");
});
