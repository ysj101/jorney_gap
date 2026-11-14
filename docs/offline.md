# Offline import and reports

Build the workspace with Node.js 24+ and pnpm, then run the local CLI without publishing packages:

```sh
node packages/cli/dist/main.js import --input ./data/traces.jsonl --db ./data/imported.db --config deploy/journeygap.relay.example.json
node packages/cli/dist/main.js report --db ./data/imported.db --journey first-task --days 7
node packages/cli/dist/main.js report --db ./data/imported.db --journey first-task --days 7 --format json
```

Input is newline-delimited OTLP JSON from a standard Collector file exporter, not a proprietary event file. Stop a Relay before importing into its database; this reference storage supports one writer. Report uses a read-only SQLite connection and does not migrate, expire events or change file permissions. A fresh schema-v2 Relay database already contains safe journey definitions, so reporting it needs only --db and --journey. Source configuration is selected in this order: explicit --config, saved database configuration, journeygap.relay.json, journeygap.config.json. An explicit file may be a validated Relay or Web configuration. Web configuration supplies definitions and attributes only; its synthetic offline origin is not a deployable CORS policy.

Import reads in bounded chunks and rejects any line exceeding 256 KiB before accumulating an unbounded line. UTF-8, JSON, OTLP shape/depth/arrays, service and journey/step IDs use the same validation as HTTP ingest. Only validated step observations are saved, with eventId deduplication and configured storage quotas. Blank lines and CRLF are accepted. A malformed line stops import with a line number, not its contents. Earlier validated lines remain committed; rerunning is safe and reports duplicate counts. Input must be a regular file distinct from the database, including inode aliases.

## Original receipt time versus import time

An OTLP trace exported days ago does not contain a portable original receiver timestamp. Import records the current ingestion time for storage retention but marks its source as offline. Analysis receives no fabricated original receipt timestamp: it retains these observations, warns that clock skew cannot be checked, and lowers finding confidence. It does not incorrectly exclude every old trace as a greater-than-24-hour clock error. Live events still compare their client timestamp with the actual server receipt timestamp and exclude excessive skew. This distinction is operational metadata in SQLite, not a new OTLP attribute or event schema version.

Schema-v2 migration adds that source marker and a validated configuration record. No admin token, upstream authorization, peer IP or request payload is part of the configuration schema or stored metadata. Event rows from v1 retain their original receipt timestamps and become live-source rows. Relay or import with matching --config performs the additive migration; read-only report asks for migration instead of modifying the database. Back up existing databases before upgrades. Newer unknown database schemas are refused.

## Selecting a cohort

Reports default to the last seven days ending now. --days accepts 1–365. To use historical start and completion bounds:

```sh
node packages/cli/dist/main.js report --db ./data/imported.db --journey first-task \
  --from 2026-11-01T00:00:00Z --to 2026-11-08T00:00:00Z --grace-minutes 30
```

Dates must be ISO UTC with seconds and optional three-digit milliseconds. --from and --days are mutually exclusive. Grace accepts 0–1440 minutes, never extends beyond the current time, and includes follow-up observations only for starts inside the cohort. Future/inverted/invalid windows fail validation. Set --service when a database contains multiple services; reports never silently combine them. --format is text (default) or json.

Text output shows observed starts/completions, reached/start ratios, previous-step conversion, medians from start and previous step, timeout/superseded/pending counts, finding evidence/confidence, and delivery/sampling/receipt-time uncertainty. Empty denominators and absent timing samples print n/a. Low sample counts remain visible but do not establish causes. Reports contain aggregates, not session or event histories. No external SaaS account, backend query API or network connection is needed for either command.
