import { request } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createRelay } from "../packages/relay/src/index.js";
import { otlpFixture, relayConfig } from "./fixtures/otlp.js";

const relays: ReturnType<typeof createRelay>[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});
async function start(config: unknown = relayConfig, now = Date.now) {
  const relay = createRelay({ config, databasePath: ":memory:", now });
  relays.push(relay);
  return { relay, url: await relay.listen(0) };
}
const post = (
  url: string,
  body: string | Uint8Array = JSON.stringify(otlpFixture()),
  headers: Record<string, string> = {},
) =>
  fetch(`${url}/v1/traces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:5173",
      ...headers,
    },
    body: body as BodyInit,
  });

it("serves a minimal health response and stores only allowed spans idempotently", async () => {
  const { relay, url } = await start();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(await (await fetch(`${url}/healthz`)).json()).toEqual({
    status: "ok",
  });
  const response = await post(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "http://localhost:5173",
  );
  expect(await response.json()).toEqual({});
  expect((await post(url)).status).toBe(200);
  expect(relay.store.count()).toBe(1);
  expect(relay.stats()).toMatchObject({
    acceptedRequests: 2,
    storedEvents: 1,
    duplicateEvents: 1,
  });
  const unrelated = otlpFixture({
    serviceName: "not-allowed",
    span: { name: "http.request" },
  });
  expect((await post(url, JSON.stringify(unrelated))).status).toBe(200);
  expect(relay.store.count()).toBe(1);
});

it("restricts origins and preflight headers without treating CORS as authentication", async () => {
  const { relay, url } = await start();
  const denied = await post(url, "{}", {
    Origin: "https://denied.example.test",
  });
  expect(denied.status).toBe(403);
  expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  const preflight = await fetch(`${url}/v1/traces`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-headers")).toBe(
    "Content-Type",
  );
  expect(
    (
      await fetch(`${url}/v1/traces`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization",
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect(relay.store.count()).toBe(0);
});

it("rejects unsupported types, malformed JSON and invalid JourneyGap data without leaking input", async () => {
  const { relay, url } = await start();
  expect((await post(url, "{}", { "Content-Type": "text/plain" })).status).toBe(
    415,
  );
  expect((await post(url, "{}", { "Content-Encoding": "br" })).status).toBe(
    415,
  );
  expect((await post(url, "{dummy-secret")).status).toBe(400);
  const invalid = await post(
    url,
    JSON.stringify(
      otlpFixture({
        attributes: {
          "journeygap.session_id": { stringValue: "dummy-secret" },
        },
      }),
    ),
  );
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain("dummy-secret");
  expect(relay.store.count()).toBe(0);
  expect((await fetch(`${url}/admin/v1/report`)).status).toBe(404);
  expect((await fetch(`${url}/v1/traces`)).status).toBe(405);
  expect((await fetch(`${url}/healthz`)).status).toBe(200);
});

it("bounds compressed and uncompressed payloads and rejects invalid UTF-8", async () => {
  const { relay, url } = await start();
  expect((await post(url, "x".repeat(262145))).status).toBe(413);
  expect(
    (
      await post(url, gzipSync(JSON.stringify(otlpFixture())), {
        "Content-Encoding": "gzip",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post(url, gzipSync("x".repeat(262145)), {
        "Content-Encoding": "gzip",
      })
    ).status,
  ).toBe(413);
  expect((await post(url, new Uint8Array([255]))).status).toBe(400);
  expect(relay.store.count()).toBe(1);
});

it("rate limits by the peer address, ignores spoofed forwarding headers and expires buckets", async () => {
  let clock = 1794517200100;
  const { url } = await start(
    { ...relayConfig, rateLimitPerMinute: 1 },
    () => clock,
  );
  expect(
    (await post(url, "{}", { "X-Forwarded-For": "192.0.2.1" })).status,
  ).toBe(200);
  const limited = await post(url, "{}", { "X-Forwarded-For": "192.0.2.2" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  clock += 60001;
  expect((await post(url, "{}")).status).toBe(200);
});

it("enforces body timeout while keeping the receiver healthy", async () => {
  const { url } = await start();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${url}/v1/traces`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "100",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.write("{");
  });
  expect(status).toBe(408);
  expect((await fetch(`${url}/healthz`)).status).toBe(200);
}, 10000);

it("rejects chunked bodies exceeding the limit without storing a partial request", async () => {
  const { relay, url } = await start();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${url}/v1/traces`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.write("x".repeat(131073));
    req.end("x".repeat(131073));
  });
  expect(status).toBe(413);
  expect(relay.store.count()).toBe(0);
});

it("validates startup configuration and releases resources when closed twice", async () => {
  expect(() =>
    createRelay({
      config: { ...relayConfig, allowedOrigins: ["*"] },
      databasePath: ":memory:",
    }),
  ).toThrow("Invalid Relay configuration");
  const { relay } = await start();
  await relay.close();
  await relay.close();
  await expect(relay.listen(0)).rejects.toThrow("Relay is closed");
});
