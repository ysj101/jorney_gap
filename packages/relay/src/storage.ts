import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredJourneyEvent } from "@journeygap/core";
import { safeVersion } from "@journeygap/core";

const DAY = 86400000;
const id = /^[a-z][a-z0-9._-]{0,63}$/;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const migration1 = `
CREATE TABLE journey_events (
  event_id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  app_version TEXT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  timestamp_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  step_id TEXT NOT NULL
);
CREATE INDEX idx_journey_window ON journey_events(service_name, journey_id, timestamp_ms);
CREATE INDEX idx_journey_instance ON journey_events(instance_id, timestamp_ms);
CREATE INDEX idx_journey_retention ON journey_events(received_at_ms);
PRAGMA user_version = 1;
`;

export type StorageOptions = {
  retentionDays?: number;
  maxEvents?: number;
  maxDatabaseBytes?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
};
export class StorageQuotaError extends Error {
  constructor() {
    super("Storage quota exceeded");
  }
}

/** Single-process local storage. Only already validated step events are persisted. */
export class EventStore {
  private db: DatabaseSync;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private retentionDays: number;
  private maxEvents: number;
  private maxDatabaseBytes: number;
  private now: () => number;

  constructor(
    private path: string,
    options: StorageOptions = {},
  ) {
    this.retentionDays = options.retentionDays ?? 14;
    this.maxEvents = options.maxEvents ?? 1000000;
    this.maxDatabaseBytes = options.maxDatabaseBytes ?? 100 * 1024 * 1024;
    const interval = options.cleanupIntervalMs ?? 3600000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isInteger(this.retentionDays) ||
      this.retentionDays < 1 ||
      this.retentionDays > 365 ||
      !Number.isSafeInteger(this.maxEvents) ||
      this.maxEvents < 1 ||
      !Number.isSafeInteger(this.maxDatabaseBytes) ||
      this.maxDatabaseBytes < 1048576 ||
      !Number.isSafeInteger(interval) ||
      interval < 100
    )
      throw new Error("Invalid storage options");
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA cache_spill=OFF;",
      );
      const version = this.db
        .prepare("PRAGMA user_version")
        .get()?.user_version;
      if (version !== 0 && version !== 1)
        throw new Error("Unsupported database schema version");
      if (version === 0) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(migration1);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      const pageSize = Number(
        this.db.prepare("PRAGMA page_size").get()?.page_size,
      );
      // Reserve space for one transaction's WAL and its shared-memory index.
      const maxPages = Math.floor(
        (this.maxDatabaseBytes - 65536) / (3 * pageSize),
      );
      this.db.exec(`PRAGMA max_page_count=${maxPages}`);
      this.cleanup();
      if (
        this.diskBytes() > this.maxDatabaseBytes ||
        Number(this.db.prepare("PRAGMA page_count").get()?.page_count) >
          maxPages
      )
        throw new StorageQuotaError();
      this.timer = setInterval(() => {
        try {
          this.cleanup();
        } catch {
          /* Maintenance failures must not crash ingestion. */
        }
      }, interval);
      this.timer.unref();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private diskBytes(): number {
    if (this.path === ":memory:")
      return (
        Number(this.db.prepare("PRAGMA page_count").get()?.page_count ?? 0) *
        Number(this.db.prepare("PRAGMA page_size").get()?.page_size ?? 4096)
      );
    return [this.path, `${this.path}-wal`, `${this.path}-shm`].reduce(
      (sum, path) => {
        try {
          return sum + statSync(path).size;
        } catch {
          return sum;
        }
      },
      0,
    );
  }

  insert(events: readonly StoredJourneyEvent[]): {
    inserted: number;
    duplicates: number;
  } {
    if (this.closed) throw new Error("Storage is closed");
    if (events.length > 1000) throw new Error("Too many events");
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO journey_events (event_id, service_name, app_version, schema_version, timestamp_ms, received_at_ms, session_id, instance_id, journey_id, step_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    let inserted = 0;
    try {
      const initialCount = this.count();
      for (const event of events) {
        const received = event.receivedAtMs ?? this.now();
        if (
          event.schemaVersion !== 1 ||
          ![event.eventId, event.sessionId, event.instanceId].every((value) =>
            uuid.test(value),
          ) ||
          ![event.serviceName, event.journeyId, event.stepId].every((value) =>
            id.test(value),
          ) ||
          !Number.isSafeInteger(event.timestampMs) ||
          event.timestampMs < 0 ||
          !Number.isSafeInteger(received) ||
          received < 0 ||
          (event.appVersion !== undefined &&
            safeVersion(event.appVersion) === undefined)
        )
          throw new Error("Invalid stored event");
        const result = insert.run(
          event.eventId.toLowerCase(),
          event.serviceName,
          event.appVersion ?? null,
          1,
          event.timestampMs,
          received,
          event.sessionId.toLowerCase(),
          event.instanceId.toLowerCase(),
          event.journeyId,
          event.stepId,
        );
        inserted += Number(result.changes);
        if (
          initialCount + inserted > this.maxEvents ||
          this.diskBytes() > this.maxDatabaseBytes
        )
          throw new StorageQuotaError();
      }
      this.db.exec("COMMIT");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return { inserted, duplicates: events.length - inserted };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (
        typeof error === "object" &&
        error !== null &&
        "errcode" in error &&
        error.errcode === 13
      )
        throw new StorageQuotaError();
      throw error;
    }
  }

  count(): number {
    return Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM journey_events").get()
        ?.count ?? 0,
    );
  }

  list(
    serviceName: string,
    journeyId: string,
    fromMs = 0,
    toMs = Number.MAX_SAFE_INTEGER,
  ): StoredJourneyEvent[] {
    if (
      !id.test(serviceName) ||
      !id.test(journeyId) ||
      !Number.isSafeInteger(fromMs) ||
      !Number.isSafeInteger(toMs) ||
      fromMs < 0 ||
      fromMs > toMs
    )
      throw new Error("Invalid storage query");
    return this.db
      .prepare(
        "SELECT event_id AS eventId, service_name AS serviceName, app_version AS appVersion, schema_version AS schemaVersion, timestamp_ms AS timestampMs, received_at_ms AS receivedAtMs, session_id AS sessionId, instance_id AS instanceId, journey_id AS journeyId, step_id AS stepId FROM journey_events WHERE service_name = ? AND journey_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ? ORDER BY timestamp_ms, received_at_ms, rowid",
      )
      .all(serviceName, journeyId, fromMs, toMs)
      .map((row) => {
        const { appVersion, ...rest } = row;
        return {
          ...rest,
          ...(appVersion === null ? {} : { appVersion }),
        } as StoredJourneyEvent;
      });
  }

  cleanup(): number {
    if (this.closed) return 0;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("Invalid storage clock");
    const result = this.db
      .prepare("DELETE FROM journey_events WHERE received_at_ms < ?")
      .run(now - this.retentionDays * DAY);
    // Allow deleted pages to be reused and truncate WAL; do not retain a durable queue.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Number(result.changes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
