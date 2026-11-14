import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { analyze, parseOtlpJson } from "../packages/core/src/index.js";
import { createForwarder } from "../packages/relay/src/forward.js";
import { createRelay } from "../packages/relay/src/index.js";
import { otlpFixture, relayConfig } from "./fixtures/otlp.js";

const token = "synthetic-admin-token-not-real-production-secret";
const relays: ReturnType<typeof createRelay>[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});
async function upstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test address");
  return `http://127.0.0.1:${address.port}/v1/traces`;
}
async function receiver(endpoint: string, authorization?: string) {
  const relay = createRelay({
    config: relayConfig,
    databasePath: ":memory:",
    adminToken: token,
    now: () => 1794517200100,
    upstream: { endpoint, ...(authorization ? { authorization } : {}) },
  });
  relays.push(relay);
  return { relay, url: await relay.listen(0) };
}
const send = (url: string, data = otlpFixture()) =>
  fetch(`${url}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

it("forwards only reconstructed spans with credentials confined to the upstream request", async () => {
  let body = "";
  let authorization: string | undefined;
  const endpoint = await upstream((req, res) => {
    authorization = req.headers.authorization;
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  const { relay, url } = await receiver(
    endpoint,
    "Bearer synthetic-upstream-token",
  );
  const response = await send(
    url,
    otlpFixture({
      attributes: {
        "http.url": {
          stringValue: "https://private.example.test/?token=dummy",
        },
      },
      span: { events: [{ name: "private-event" }] },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({});
  await relay.forwardIdle();
  expect(authorization).toBe("Bearer synthetic-upstream-token");
  expect(body).not.toContain("private");
  expect(body).not.toContain("synthetic-upstream-token");
  expect(parseOtlpJson(body, relayConfig).journeyEvents).toHaveLength(1);
  expect(relay.stats().forwarding).toMatchObject({ succeeded: 1, failed: 0 });
});

it("keeps local observations identical when the fixed upstream destination changes", async () => {
  const first = await upstream((_req, res) => res.end("{}"));
  const second = await upstream((_req, res) => res.end("{}"));
  const reports = [];
  const definition = relayConfig.services[0]?.journeys[0];
  if (!definition) throw new Error("Missing fixture definition");
  for (const endpoint of [first, second]) {
    const { relay, url } = await receiver(endpoint);
    expect((await send(url)).status).toBe(200);
    await relay.forwardIdle();
    reports.push(
      analyze(
        relay.store.list("sample-web", "first-task"),
        definition,
        1794517200100,
      ),
    );
  }
  expect(reports[0]).toEqual(reports[1]);
});

it("separates stored success from upstream failure without reflecting an upstream error", async () => {
  const endpoint = await upstream((_req, res) => {
    res.writeHead(503);
    res.end("synthetic-private-upstream-error");
  });
  const { relay, url } = await receiver(endpoint);
  const response = await send(url);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("{}");
  await relay.forwardIdle();
  expect(relay.store.count()).toBe(1);
  expect(relay.stats().forwarding).toMatchObject({ succeeded: 0, failed: 1 });
});

it("never follows upstream redirects, preventing credential forwarding to another destination", async () => {
  let leaked = 0;
  const trap = await upstream((_req, res) => {
    leaked++;
    res.end("{}");
  });
  const endpoint = await upstream((_req, res) => {
    res.writeHead(307, { Location: trap });
    res.end();
  });
  const { relay, url } = await receiver(
    endpoint,
    "Bearer synthetic-upstream-token",
  );
  expect((await send(url)).status).toBe(200);
  await relay.forwardIdle();
  expect(leaked).toBe(0);
  expect(relay.stats().forwarding?.failed).toBe(1);
});

it("bounds queued batches, aborts in-flight requests on shutdown and snapshots the startup endpoint", async () => {
  const endpoint = await upstream(() => {
    /* Deliberately no response. */
  });
  const options = { endpoint };
  const forwarder = createForwarder(options);
  options.endpoint = "http://public.example.test/v1/traces";
  const envelope = parseOtlpJson(
    JSON.stringify(otlpFixture()),
    relayConfig,
  ).sanitized;
  for (let n = 0; n < 8; n++) forwarder.enqueue(envelope);
  expect(forwarder.stats()).toMatchObject({
    queued: 4,
    inFlight: true,
    dropped: 3,
  });
  await forwarder.close();
  expect(forwarder.stats()).toMatchObject({
    queued: 0,
    inFlight: false,
    failed: 1,
    dropped: 7,
  });
});

it("times out an unresponsive upstream while local ingestion remains successful", async () => {
  const endpoint = await upstream(() => {
    /* Deliberately no response. */
  });
  const { relay, url } = await receiver(endpoint);
  expect((await send(url)).status).toBe(200);
  await relay.forwardIdle();
  expect(relay.store.count()).toBe(1);
  expect(relay.stats().forwarding?.failed).toBe(1);
}, 6000);

it("rejects unsafe startup endpoints and CRLF credentials", () => {
  for (const endpoint of [
    "http://public.example.test/v1/traces",
    "https://name:password@example.test/v1/traces",
    "https://example.test/v1/traces?token=dummy",
  ])
    expect(() => createForwarder({ endpoint })).toThrow(
      "Invalid upstream endpoint",
    );
  expect(() =>
    createForwarder({
      endpoint: "https://example.test/v1/traces",
      authorization: "Bearer dummy\r\nX-Leak: yes",
    }),
  ).toThrow("Invalid upstream authentication");
});

it("permits explicit development-only internal HTTP and refuses that exception in production", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const forwarder = createForwarder({
    endpoint: "http://collector:14318/v1/traces",
    development: true,
  });
  await forwarder.close();
  vi.stubEnv("NODE_ENV", "production");
  expect(() =>
    createForwarder({
      endpoint: "http://collector:14318/v1/traces",
      development: true,
    }),
  ).toThrow("Invalid upstream endpoint");
});
