# Relay storage

`@journeygap/relay` exports `EventStore(path, options?)` for single-process Node.js 24+ SQLite storage. HTTP ingestion is a separate implementation task. The store accepts validated step records from `parseOtlpJson().journeyEvents`; it repeats structural checks but does not replace the configured service/journey allowlist at the ingest boundary. Navigation and error spans are not persisted in this MVP store. No IPs, custom input attributes, full URLs or error text are stored.

Storage uses WAL, SQL placeholders, eventId primary-key deduplication, a versioned `PRAGMA user_version` migration, and service/journey/window and instance indexes. Version 1 creates the initial table without altering unrelated tables. Newer versions are refused. Back up databases before upgrading or changing quotas. Files are mode 0600 and newly created parent directories request 0700. Existing parent permissions remain the operator's responsibility.

`insert(events)` accepts at most 1000 step rows in one transaction and returns inserted/duplicate counts. Capacity or validation failures roll back the entire batch. IDs are canonicalized to lowercase UUIDs. A missing receivedAtMs is filled from the server clock; the client timestamp is retained separately for clock-skew analysis. Reports query by validated service/journey identifiers and preserve client-time then receipt-time ordering.

Defaults:

- retentionDays: 14 (1–365), using receipt time rather than an untrusted client clock.
- cleanupIntervalMs: 3600000 (at least 100), with an unreferenced timer. Expired rows are removed at startup and periodically, secure_delete is enabled, and WAL is checkpointed/truncated. Filesystem backups have their own retention policy.
- maxEvents: 1000000. Duplicate retries do not consume additional capacity.
- maxDatabaseBytes: 100 MiB (at least 1 MiB). This budget reserves space conservatively for database pages, a transaction WAL, and shared-memory metadata. About one third is available to database pages; SQLite max_page_count prevents growth past that allocation. Cache spilling is disabled so a transaction does not repeatedly write dirty pages to WAL; batches are bounded, and WAL is truncated after commit. Freed pages are reused rather than requiring VACUUM on each deletion.

`StorageQuotaError` identifies capacity failures without returning records. Opening a database larger than a newly reduced allocation fails. Use a filesystem quota as an additional deployment boundary, and do not run other writers or long-lived readers against the live database: external readers can delay checkpoints. This is a single-instance reference service, not a horizontally shared database. Shutdown must call close(), which stops maintenance and checkpoints before closing; it is safe to call twice. Database files and sidecars are ignored by Git.
