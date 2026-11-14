import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { run } from "../packages/cli/src/index.js";
import { EventStore } from "../packages/relay/src/index.js";
import { BASE, cohortFixture, journey } from "./fixtures/journeys.js";
import { otlpFixture, relayConfig } from "./fixtures/otlp.js";

const directories: string[] = [];
const config = {
  ...relayConfig,
  services: [{ serviceName: "sample-web", journeys: [journey] }],
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function project() {
  const cwd = mkdtempSync(join(tmpdir(), "journeygap-cli space-"));
  directories.push(cwd);
  writeFileSync(join(cwd, "journeygap.relay.json"), JSON.stringify(config));
  const out: string[] = [],
    errors: string[] = [];
  return {
    cwd,
    out,
    errors,
    execute: (args: string[]) =>
      run(
        args,
        { out: (text) => out.push(text), error: (text) => errors.push(text) },
        cwd,
      ),
  };
}
function archive() {
  const shift = Date.now() - 2 * 86400000 - BASE;
  return cohortFixture
    .map((event) =>
      JSON.stringify(
        otlpFixture({
          attributes: {
            "journeygap.event_id": { stringValue: event.eventId },
            "journeygap.session_id": { stringValue: event.sessionId },
            "journeygap.instance_id": { stringValue: event.instanceId },
            "journeygap.step_id": { stringValue: event.stepId },
          },
          span: {
            startTimeUnixNano: String(
              BigInt(event.timestampMs + shift) * 1000000n,
            ),
            endTimeUnixNano: String(
              BigInt(event.timestampMs + shift) * 1000000n + 1n,
            ),
          },
        }),
      ),
    )
    .join("\n");
}

it("streams historical JSONL, deduplicates reruns and reports the 40-attempt fixture without false clock skew", async () => {
  const p = project();
  const db = "nested data/events.db";
  writeFileSync(join(p.cwd, "synthetic traces.jsonl"), `${archive()}\n`);
  const args = ["import", "--input", "synthetic traces.jsonl", "--db", db];
  expect(await p.execute(args)).toBe(0);
  expect(p.out[0]).toContain("inserted 80");
  expect(await p.execute(args)).toBe(0);
  expect(p.out[1]).toContain("duplicates 80");
  expect(
    await p.execute([
      "report",
      "--db",
      db,
      "--journey",
      "first-task",
      "--format",
      "json",
    ]),
  ).toBe(0);
  const report = JSON.parse(p.out.at(-1) ?? "{}");
  expect(report).toMatchObject({
    observedStarts: 40,
    observedCompletions: 10,
    incompleteAfterTimeout: 30,
    excludedEvents: 0,
  });
  expect(
    report.stepCounts.map((step: { reached: number }) => step.reached),
  ).toEqual([40, 30, 10]);
  expect(
    report.warnings.some((warning: string) => warning.includes("元の受信時刻")),
  ).toBe(true);
  expect(
    report.findings.every(
      (finding: { confidence: string }) => finding.confidence === "low",
    ),
  ).toBe(true);
  expect(
    await p.execute(["report", "--db", db, "--journey", "first-task"]),
  ).toBe(0);
  expect(p.out.at(-1)).toContain("10/40 (25.0%); previous 33.3%");
  expect(p.out.at(-1)).toContain("70000 ms");
  expect(p.errors).toEqual([]);
  // A separate process outside the app can use the safe definitions saved in SQLite.
  const binary = resolve("packages/cli/dist/main.js");
  const output = execFileSync(
    process.execPath,
    [
      binary,
      "report",
      "--db",
      join(p.cwd, db),
      "--journey",
      "first-task",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(output).observedStarts).toBe(40);
});

it("stops on a bad line without logging it, preserving prior lines for idempotent retry", async () => {
  const p = project();
  writeFileSync(
    join(p.cwd, "bad.jsonl"),
    `${JSON.stringify(otlpFixture())}\n{"dummy-secret": invalid}\n`,
  );
  const args = ["import", "--input", "bad.jsonl", "--db", "events.db"];
  expect(await p.execute(args)).toBe(1);
  expect(p.errors[0]).toContain("line 2");
  expect(p.errors[0]).not.toContain("dummy-secret");
  const store = new EventStore(join(p.cwd, "events.db"), { readOnly: true });
  expect(store.count()).toBe(1);
  store.close();
  expect(await p.execute(args)).toBe(1);
  const retry = new EventStore(join(p.cwd, "events.db"), { readOnly: true });
  expect(retry.count()).toBe(1);
  retry.close();
});

it("bounds a JSONL line before unbounded buffering and rejects invalid UTF-8", async () => {
  const p = project();
  writeFileSync(join(p.cwd, "huge.jsonl"), "x".repeat(262145));
  expect(
    await p.execute(["import", "--input", "huge.jsonl", "--db", "events.db"]),
  ).toBe(1);
  expect(p.errors[0]).toContain("256 KiB");
  writeFileSync(join(p.cwd, "utf8.jsonl"), Buffer.from([255, 10]));
  expect(
    await p.execute(["import", "--input", "utf8.jsonl", "--db", "events.db"]),
  ).toBe(1);
  expect(p.errors[1]).toContain("UTF-8");
});

it("rejects malformed arguments, unknown services and injection while redacting raw parse errors", async () => {
  const p = project();
  writeFileSync(join(p.cwd, "empty.jsonl"), "{}\n");
  expect(
    await p.execute(["import", "--input", "empty.jsonl", "--db", "events.db"]),
  ).toBe(0);
  for (const extra of [
    ["--days", "0"],
    ["--days", "366"],
    ["--days", "1.2"],
    ["--to", "tomorrow"],
    ["--to", "2026-02-30T00:00:00Z"],
    ["--format", "html"],
    ["--service", "unconfigured"],
    ["--grace-minutes", "1441"],
    ["--from", "2026-01-01T00:00:00Z", "--days", "7"],
  ]) {
    expect(
      await p.execute([
        "report",
        "--db",
        "events.db",
        "--journey",
        "first-task",
        ...extra,
      ]),
    ).toBe(1);
  }
  expect(
    await p.execute([
      "report",
      "--db",
      "events.db",
      "--journey",
      "'; DROP TABLE journey_events;--",
    ]),
  ).toBe(1);
  expect(
    await p.execute([
      "report",
      "--db",
      "events.db",
      "--journey",
      "first-task",
      "--dummy-secret",
    ]),
  ).toBe(1);
  expect(p.errors.at(-1)).not.toContain("dummy-secret");
  expect(
    await p.execute(["report", "--db", "events.db", "--journey", "first-task"]),
  ).toBe(0);
  expect(p.out.at(-1)).toContain("n/a");
});

it("reports read-only without applying a default TTL to an existing database", async () => {
  const p = project();
  const database = join(p.cwd, "long-retention.db");
  const now = Date.now();
  const old = now - 40 * 86400000;
  const store = new EventStore(database, {
    retentionDays: 365,
    now: () => old,
  });
  store.setConfig({ ...config, retentionDays: 365 });
  store.insert([
    {
      schemaVersion: 1,
      eventId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      instanceId: "00000000-0000-4000-8000-000000000003",
      journeyId: "first-task",
      stepId: "started",
      serviceName: "sample-web",
      timestampMs: old,
      receivedAtMs: old,
    },
  ]);
  store.close();
  expect(
    await p.execute([
      "report",
      "--db",
      database,
      "--journey",
      "first-task",
      "--days",
      "365",
    ]),
  ).toBe(0);
  const reader = new EventStore(database, { readOnly: true });
  expect(reader.count()).toBe(1);
  expect(() => reader.cleanup()).toThrow("read-only");
  reader.close();
});

it("migrates a version-1 database without losing stored events", () => {
  const p = project();
  const database = join(p.cwd, "old.db");
  const store = new EventStore(database, { now: () => BASE });
  store.setConfig(config);
  store.close();
  const old = new DatabaseSync(database);
  old.exec(
    "ALTER TABLE journey_events DROP COLUMN source; DROP TABLE relay_metadata; PRAGMA user_version=1;",
  );
  old
    .prepare("INSERT INTO journey_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "00000000-0000-4000-8000-000000000001",
      "sample-web",
      null,
      1,
      BASE,
      BASE,
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "first-task",
      "started",
    );
  old.close();
  const migrated = new EventStore(database, { now: () => BASE });
  expect(migrated.count()).toBe(1);
  expect(migrated.list("sample-web", "first-task")[0]?.receivedAtMs).toBe(BASE);
  migrated.setConfig(config);
  expect(migrated.getConfig()).toEqual(config);
  migrated.close();
  const reader = new EventStore(database, { readOnly: true });
  expect(reader.count()).toBe(1);
  reader.close();
  expect(readFileSync(database).subarray(0, 15).toString()).toBe(
    "SQLite format 3",
  );
});
