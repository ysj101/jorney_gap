import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { EventStore, StorageQuotaError } from "../packages/relay/src/index.js";
import { BASE, cohortFixture, event } from "./fixtures/journeys.js";

const stores: EventStore[] = [];
const directories: string[] = [];
const row = (n = 1) => ({
  ...event(n, "started", BASE),
  serviceName: "sample-web",
});
function databasePath() {
  const path = mkdtempSync(join(tmpdir(), "journeygap-storage-"));
  directories.push(path);
  return join(path, "events.db");
}
function open(path = ":memory:", options = {}) {
  const store = new EventStore(path, { now: () => BASE, ...options });
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

it("migrates a file to WAL storage and preserves records across reopen", () => {
  const path = databasePath();
  const store = open(path);
  const input = { ...row(), appVersion: "1.2.3" };
  expect(store.insert([input])).toEqual({ inserted: 1, duplicates: 0 });
  store.close();
  const reopened = open(path);
  expect(reopened.list("sample-web", "first-task")).toEqual([input]);
  const inspect = new DatabaseSync(path);
  expect(inspect.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(inspect.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(
    "wal",
  );
  inspect.close();
  if (process.platform !== "win32")
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

it("deduplicates IDs, filters services and journeys, and keeps stable receipt ordering", () => {
  const store = open();
  const input = [
    row(1),
    { ...row(2), serviceName: "other-web" },
    { ...row(3), journeyId: "other-task" },
    { ...row(4), receivedAtMs: BASE + 1 },
  ];
  expect(store.insert(input)).toEqual({ inserted: 4, duplicates: 0 });
  expect(store.insert(input)).toEqual({ inserted: 0, duplicates: 4 });
  expect(
    store.list("sample-web", "first-task").map((item) => item.eventId),
  ).toEqual([row(4).eventId, row(1).eventId]);
  expect(store.list("sample-web", "first-task", BASE + 1)).toEqual([]);
  expect(store.count()).toBe(4);
});

it("stores the synthetic cohort with original and received timestamps", () => {
  const store = open();
  store.insert(
    cohortFixture.map((item) => ({ ...item, serviceName: "sample-web" })),
  );
  expect(store.count()).toBe(80);
  expect(store.list("sample-web", "first-task")).toHaveLength(80);
  const { receivedAtMs: _received, ...withoutReceipt } = row(999);
  store.insert([withoutReceipt]);
  expect(
    store
      .list("sample-web", "first-task")
      .find((item) => item.eventId === withoutReceipt.eventId)?.receivedAtMs,
  ).toBe(BASE);
});

it("deletes expired receipt records at the configured interval without using client clocks", () => {
  vi.useFakeTimers();
  let clock = BASE;
  const store = open(":memory:", { now: () => clock, cleanupIntervalMs: 100 });
  store.insert([
    { ...row(1), timestampMs: BASE - 30 * 86400000, receivedAtMs: BASE },
    { ...row(2), receivedAtMs: BASE - 14 * 86400000 - 1 },
  ]);
  expect(store.count()).toBe(2);
  vi.advanceTimersByTime(100);
  expect(store.count()).toBe(1);
  clock += 15 * 86400000;
  expect(store.cleanup()).toBe(1);
  expect(store.count()).toBe(0);
});

it("rolls back an entire batch when event capacity is exceeded and permits duplicate retries", () => {
  const store = open(":memory:", { maxEvents: 1 });
  expect(() => store.insert([row(1), row(2)])).toThrow(StorageQuotaError);
  expect(store.count()).toBe(0);
  store.insert([row(1)]);
  expect(store.insert([row(1)])).toEqual({ inserted: 0, duplicates: 1 });
  expect(() => store.insert([row(2)])).toThrow(StorageQuotaError);
  expect(store.count()).toBe(1);
});

it("enforces disk quota with transaction rollback and can still accept a small batch", () => {
  const path = databasePath();
  const store = open(path, { maxDatabaseBytes: 1048576 });
  const batch = Array.from({ length: 1000 }, (_, n) => ({
    ...row(n + 1),
    serviceName: `s${"x".repeat(62)}`,
    journeyId: `j${"x".repeat(62)}`,
    stepId: `s${"x".repeat(62)}`,
    appVersion: "1.2.3",
  }));
  expect(() => store.insert(batch)).toThrow(StorageQuotaError);
  expect(store.count()).toBe(0);
  store.insert([row(1)]);
  expect(store.count()).toBe(1);
  expect(statSync(path).size).toBeLessThan(1048576);
});

it("rejects injection and invalid records without changing stored data", () => {
  const store = open();
  expect(() =>
    store.list("sample-web'; DROP TABLE journey_events;--", "first-task"),
  ).toThrow("Invalid storage query");
  expect(() =>
    store.insert([
      row(1),
      { ...row(2), stepId: "'; DROP TABLE journey_events;--" },
    ]),
  ).toThrow("Invalid stored event");
  expect(store.count()).toBe(0);
  expect(() =>
    store.insert([{ ...row(1), appVersion: "fake@example.test" }]),
  ).toThrow("Invalid stored event");
});

it("rejects future database versions without silently recreating tables", () => {
  const path = databasePath();
  const future = new DatabaseSync(path);
  future.exec(
    "PRAGMA user_version=2; CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserved');",
  );
  future.close();
  expect(() => open(path)).toThrow("Unsupported database schema version");
  const inspect = new DatabaseSync(path);
  expect(inspect.prepare("SELECT value FROM sentinel").get()?.value).toBe(
    "preserved",
  );
  inspect.close();
});
