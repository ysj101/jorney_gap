import { afterEach, expect, it } from "vitest";
import { createRelay } from "../packages/relay/src/index.js";
import { BASE, cohortFixture, journey } from "./fixtures/journeys.js";
import { relayConfig } from "./fixtures/otlp.js";

const token = "synthetic-admin-token-for-tests-not-a-real-secret";
const relays: ReturnType<typeof createRelay>[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});
async function start() {
  const config = {
    ...relayConfig,
    services: [
      { serviceName: "sample-web", journeys: [journey] },
      { serviceName: "other-web", journeys: [journey] },
    ],
  };
  const relay = createRelay({
    config,
    databasePath: ":memory:",
    adminToken: token,
    now: () => BASE + 3600000,
  });
  relays.push(relay);
  relay.store.insert(
    cohortFixture.map((event) => ({ ...event, serviceName: "sample-web" })),
  );
  return { relay, url: `${await relay.listen(0)}/admin/v1/report` };
}
const auth = { Authorization: `Bearer ${token}` };

it("requires a server-only token and never reflects credentials in an error", async () => {
  const { url } = await start();
  for (const headers of [
    {},
    { Authorization: "Bearer wrong-synthetic-value" },
    { Authorization: `Basic ${token}` },
  ]) {
    const response = await fetch(
      `${url}?service=sample-web&journey=first-task`,
      { headers },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(await response.text()).not.toContain(token);
  }
});

it("returns service-scoped aggregate evidence without configuration, credentials or individual IDs", async () => {
  const { url } = await start();
  const response = await fetch(
    `${url}?service=sample-web&journey=first-task&days=7`,
    { headers: auth },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    observedStarts: 40,
    observedCompletions: 10,
    incompleteAfterTimeout: 30,
    sampleStatus: "sufficient",
  });
  for (const value of [
    token,
    "allowedOrigins",
    "authorization",
    cohortFixture[0]?.sessionId ?? "invalid",
  ])
    expect(text).not.toContain(value);
  const other = await fetch(`${url}?service=other-web&journey=first-task`, {
    headers: auth,
  });
  expect(await other.json()).toMatchObject({
    observedStarts: 0,
    sampleStatus: "insufficient",
  });
});

it("rejects malformed, ambiguous, duplicate and unrecognized parameters", async () => {
  const { url } = await start();
  for (const query of [
    "journey=first-task",
    "service=sample-web",
    "service=sample-web&journey=first-task&days=-1",
    "service=sample-web&journey=first-task&days=366",
    "service=sample-web&journey=first-task&days=1.5",
    "service=sample-web&journey=first-task&days=7&days=8",
    "service=sample-web&journey=first-task&token=dummy",
    "service=sample-web&journey=first-task%27%3Bdrop",
  ]) {
    expect((await fetch(`${url}?${query}`, { headers: auth })).status).toBe(
      400,
    );
  }
  expect(
    (
      await fetch(`${url}?service=sample-web&journey=missing`, {
        headers: auth,
      })
    ).status,
  ).toBe(404);
  expect((await fetch(url, { method: "POST", headers: auth })).status).toBe(
    405,
  );
});

it("warns when the requested observation window exceeds retention", async () => {
  const { url } = await start();
  const response = await fetch(
    `${url}?service=sample-web&journey=first-task&days=30`,
    { headers: auth },
  );
  const report = (await response.json()) as { warnings: string[] };
  expect(report.warnings.some((warning) => warning.includes("保存期間"))).toBe(
    true,
  );
});

it("refuses startup with missing, weak or malformed tokens before opening storage", () => {
  for (const adminToken of [
    "",
    "short",
    "x".repeat(257),
    `${"x".repeat(32)}\n`,
  ])
    expect(() =>
      createRelay({
        config: relayConfig,
        databasePath: ":memory:",
        adminToken,
      }),
    ).toThrow("server-only admin token");
});
