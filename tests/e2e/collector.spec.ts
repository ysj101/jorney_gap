import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { analyze, parseOtlpJson } from "../../packages/core/src/index.js";
import { createRelay } from "../../packages/relay/src/index.js";
import { close, expect, listen, test } from "./fixture.js";

const execute = promisify(execFile);
test("official browser exporter → Relay/Collector and direct Collector → JSONL import/report without a vendor account", async ({
  page,
  lab,
}) => {
  const endpoint = process.env.JOURNEYGAP_COLLECTOR_ENDPOINT;
  if (!endpoint)
    throw new Error(
      "Start the local Collector and set JOURNEYGAP_COLLECTOR_ENDPOINT",
    );
  const project = process.env.JOURNEYGAP_COMPOSE_PROJECT ?? "journeygap-ci";
  const from = new Date().toISOString();
  lab.setMode("on");
  await page.goto(`${lab.origin}/field/`);
  await page.getByRole("button", { name: "許可", exact: true }).click();
  for (let attempt = 0; attempt < 22; attempt++)
    for (let step = 0; step < 3; step++)
      await page.locator('[data-action="first-task"]').click();
  // Partial/time-out cohorts are independently covered by the 40-attempt
  // offline fixture; this test preserves real browser timestamps end to end.
  await expect
    .poll(() => lab.relay.store.count(), { timeout: 15000 })
    .toBeGreaterThanOrEqual(66);
  for (let attempt = 0; attempt < 20; attempt++)
    for (let step = 0; step < 3; step++)
      await page.locator('[data-action="second-task"]').click();
  await expect
    .poll(() => lab.relay.store.count(), { timeout: 15000 })
    .toBeGreaterThanOrEqual(126);
  await lab.relay.forwardIdle();
  expect(lab.relay.stats().forwarding?.failed).toBe(0);
  expect(lab.relay.stats().forwarding?.succeeded).toBeGreaterThan(0);
  const config = lab.relay.config;
  const first = lab.relay.store.list("sample-web", "first-task");
  const second = lab.relay.store.list("sample-web", "second-task");
  expect(first).toHaveLength(66);
  expect(second).toHaveLength(60);
  const expectedIds = new Set(
    [...first, ...second].map((event) => event.eventId),
  );
  const directPayloads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url() === endpoint) {
      const body = request.postData();
      if (body) directPayloads.push(body);
    }
  });
  lab.setMode("collector");
  await page.goto(`${lab.origin}/field/`);
  // Same tab's explicit compact consent persists across the page reload.
  await expect(
    page.getByText("計測は許可されています。いつでも拒否できます。"),
  ).toBeVisible();
  for (const journey of ["first-task", "second-task"])
    for (let attempt = 0; attempt < 4; attempt++)
      for (let step = 0; step < 3; step++)
        await page.locator(`[data-action="${journey}"]`).click();
  await expect
    .poll(
      () =>
        directPayloads.flatMap(
          (body) => parseOtlpJson(body, config).journeyEvents,
        ).length,
      { timeout: 15000 },
    )
    .toBe(24);
  const direct = directPayloads.flatMap(
    (body) => parseOtlpJson(body, config).journeyEvents,
  );
  for (const event of direct) expectedIds.add(event.eventId);
  const output = join(lab.root, "collector.jsonl");
  await expect
    .poll(
      async () => {
        try {
          await execute(
            "docker",
            [
              "compose",
              "-p",
              project,
              "cp",
              "collector:/data/journeygap-traces.jsonl",
              output,
            ],
            { timeout: 10000, maxBuffer: 1048576 },
          );
          const events = readFileSync(output, "utf8")
            .trim()
            .split("\n")
            .flatMap((line) => parseOtlpJson(line, config).journeyEvents);
          return [...expectedIds].every((id) =>
            events.some((event) => event.eventId === id),
          );
        } catch {
          return false;
        }
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const configPath = join(lab.root, "relay-config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const database = join(lab.root, "imported.db");
  const cli = resolve("packages/cli/dist/main.js");
  await execute(
    process.execPath,
    [
      cli,
      "import",
      "--input",
      output,
      "--db",
      database,
      "--config",
      configPath,
    ],
    { timeout: 30000 },
  );
  const result = await execute(
    process.execPath,
    [
      cli,
      "report",
      "--db",
      database,
      "--journey",
      "first-task",
      "--from",
      from,
      "--format",
      "json",
    ],
    { timeout: 30000 },
  );
  const report = JSON.parse(result.stdout);
  const firstDefinition = config.services[0]?.journeys.find(
    (journey) => journey.id === "first-task",
  );
  if (!firstDefinition) throw new Error("Missing definition");
  const expected = analyze(
    [...first, ...direct.filter((event) => event.journeyId === "first-task")],
    firstDefinition,
    Date.now(),
    { fromMs: Date.parse(from) },
  );
  expect(report.observedStarts).toBe(expected.observedStarts);
  expect(report.observedCompletions).toBe(expected.observedCompletions);
  expect(report.stepCounts).toEqual(expected.stepCounts);
  expect(report.sampleStatus).toBe("sufficient");
  expect(report.observedStarts).toBeGreaterThanOrEqual(20);
  // Replace the upstream with an ordinary OTLP/HTTP receiver. Replaying the same
  // official SDK envelopes preserves every event ID and exact aggregate times.
  const forwarded: string[] = [];
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      forwarded.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  const sinkOrigin = await listen(sink);
  const replacement = createRelay({
    config,
    databasePath: ":memory:",
    adminToken: "synthetic-acceptance-admin-token-not-a-real-secret",
    upstream: { endpoint: `${sinkOrigin}/v1/traces` },
  });
  try {
    const receiver = await replacement.listen(0);
    for (const body of lab.payloads) {
      const response = await fetch(`${receiver}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: lab.origin },
        body,
      });
      expect(response.status).toBe(200);
      await replacement.forwardIdle();
    }
    expect(replacement.stats().forwarding?.failed).toBe(0);
    const comparisonTime = Date.now();
    expect(
      analyze(
        replacement.store.list("sample-web", "first-task"),
        firstDefinition,
        comparisonTime,
        { fromMs: Date.parse(from) },
      ),
    ).toEqual(
      analyze(first, firstDefinition, comparisonTime, {
        fromMs: Date.parse(from),
      }),
    );
    const ids = new Set(
      forwarded
        .flatMap((body) => parseOtlpJson(body, config).journeyEvents)
        .map((event) => event.eventId),
    );
    expect(ids).toEqual(
      new Set([...first, ...second].map((event) => event.eventId)),
    );
  } finally {
    await replacement.close();
    await close(sink);
  }
});
