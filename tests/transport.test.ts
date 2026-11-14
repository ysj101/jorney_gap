import { createServer, type RequestListener, type Server } from "node:http";
import { trace } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import {
  type JourneyGapConfig,
  parseOtlpJson,
} from "../packages/core/src/index.js";
import {
  createTelemetry,
  type Telemetry,
  type WebEvent,
} from "../packages/web/src/transport.js";
import { BASE, syntheticId } from "./fixtures/journeys.js";
import { relayConfig } from "./fixtures/otlp.js";

const config: JourneyGapConfig = {
  schemaVersion: 1,
  enabled: true,
  serviceName: "sample-web",
  serviceVersion: "1.2.3",
  otlpTracesEndpoint: "http://localhost:4318/v1/traces",
  consent: { mode: "opt-in", ui: "external" },
  journeys: [
    {
      id: "first-task",
      steps: [{ id: "started" }, { id: "completed", terminal: true }],
      timeoutMinutes: 30,
    },
  ],
  attributesAllowlist: ["app.category", "app.email"],
};
const clients: Telemetry[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function client(endpoint = config.otlpTracesEndpoint) {
  const value = createTelemetry({ ...config, otlpTracesEndpoint: endpoint });
  clients.push(value);
  return value;
}
function event(n: number): Extract<WebEvent, { eventType: "step" }> {
  return {
    eventType: "step",
    eventId: syntheticId(n),
    sessionId: syntheticId(999),
    instanceId: syntheticId(1000),
    journeyId: "first-task",
    stepId: "started",
    timestampMs: BASE,
  };
}
async function receiver(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test address");
  return `http://127.0.0.1:${address.port}/v1/traces`;
}

it("exports real official OTLP JSON with no global provider replacement or raw private attributes", async () => {
  const provider = trace.getTracerProvider();
  let payload = "";
  const endpoint = await receiver((req, res) => {
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.authorization).toBeUndefined();
    req.on("data", (chunk: Buffer) => {
      payload += chunk.toString();
    });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
  });
  const output = client(endpoint);
  output.record({
    ...event(1),
    attributes: {
      "app.category": "demo",
      "app.email": "fake@example.test",
      "app.text": "private free text",
    },
  });
  output.record(event(2));
  expect(output.stats().queued).toBe(2);
  await output.flush();
  expect(output.stats()).toMatchObject({ queued: 0, exported: 2, requests: 1 });
  const decoded = parseOtlpJson(payload, relayConfig);
  expect(decoded.journeyEvents).toHaveLength(2);
  expect(decoded.events[0]?.attributes).toEqual({ "app.category": "demo" });
  expect(payload).not.toContain("fake@example.test");
  expect(payload).not.toContain("private free text");
  const spans = JSON.parse(payload).resourceSpans[0].scopeSpans[0].spans as {
    traceId: string;
    parentSpanId?: string;
  }[];
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(2);
  expect(spans.every((span) => !span.parentSpanId)).toBe(true);
  expect(trace.getTracerProvider()).toBe(provider);
});

it("keeps at most 100 events, drops oldest events and sends batches of at most 20", async () => {
  const sizes: number[] = [];
  const ids: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const text = new TextDecoder().decode(init.body as Uint8Array);
      const decoded = parseOtlpJson(text, relayConfig);
      sizes.push(decoded.events.length);
      ids.push(...decoded.events.map((item) => item.eventId));
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
      return new Response("{}", { status: 200 });
    }),
  );
  const output = client();
  for (let n = 1; n <= 120; n++) output.record(event(n));
  expect(output.stats()).toMatchObject({
    queued: 100,
    dropped: 20,
    requests: 0,
  });
  await output.flush();
  expect(sizes).toEqual([20, 20, 20, 20, 20]);
  expect(ids[0]).toBe(syntheticId(21));
  expect(ids.at(-1)).toBe(syntheticId(120));
});

it("waits five seconds before its periodic batch and clears the timer on shutdown", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const output = client();
  output.record(event(1));
  await vi.advanceTimersByTimeAsync(4999);
  expect(fetcher).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await output.shutdown();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("retries at most twice even with Retry-After zero and exponential bounded delays", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(
    async () =>
      new Response("{}", { status: 503, headers: { "Retry-After": "0" } }),
  );
  vi.stubGlobal("fetch", fetcher);
  const output = client();
  output.record(event(1));
  const pending = output.flush();
  await vi.advanceTimersByTimeAsync(249);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(output.stats()).toMatchObject({ failed: 1, queued: 0 });
});

it("does not retry a permanent error or a Retry-After beyond the export deadline", async () => {
  for (const status of [400, 429]) {
    const fetcher = vi.fn(
      async () =>
        new Response("{}", { status, headers: { "Retry-After": "60" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const output = client();
    output.record(event(1));
    await output.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it("discards pending data and aborts an in-flight request immediately on withdrawal", async () => {
  const endpoint = await receiver(() => {
    /* Deliberately no response. */
  });
  const output = client(endpoint);
  output.record(event(1));
  const pending = output.flush();
  output.record(event(2));
  output.discard();
  await pending;
  output.record(event(3));
  await output.flush();
  expect(output.stats()).toMatchObject({
    queued: 0,
    requests: 1,
    failed: 1,
    dropped: 1,
  });
});

it("bounds a hung HTTP request by three seconds and keeps the caller synchronous", async () => {
  const endpoint = await receiver(() => {
    /* Deliberately no response. */
  });
  const output = client(endpoint);
  expect(() => output.record(event(1))).not.toThrow();
  await output.flush();
  expect(output.stats()).toMatchObject({ failed: 1, requests: 1 });
}, 6000);

it("ignores undefined steps and bounds the response body", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("x".repeat(65537), { status: 200 })),
  );
  const output = client();
  output.record({ ...event(1), stepId: "undefined-step" });
  expect(output.stats().queued).toBe(0);
  output.record(event(2));
  await output.flush();
  expect(output.stats().failed).toBe(1);
});
