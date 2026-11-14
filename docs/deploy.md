# Running the reference Relay

Node.js 24+ and the workspace build are required. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/relay/dist/main.js --config deploy/journeygap.relay.example.json --db ./data/journeygap.db
curl http://127.0.0.1:4318/healthz
```

The response is only `{"status":"ok"}`. The default bind address is 127.0.0.1. Use `--port` and an explicit `--host` when needed; binding to 0.0.0.0 must be an intentional operator choice. SIGINT/SIGTERM stop the server and close storage. The package includes the `journeygap-relay` binary for packaged use; package publication is separate and has not occurred.

Configure explicit allowedOrigins and service/journey definitions using the shared [configuration contract](configuration.md). The example permits only localhost development origins. Public deployments require TLS termination, a protected ingress/proxy, rate/volume limits, storage quotas, monitoring and separate authenticated administration. CORS is not authentication: a nonbrowser sender can omit or forge Origin and contaminate public telemetry. Do not trust X-Forwarded-For without a separately designed trusted proxy boundary. The receiver uses the direct peer IP temporarily for rate limiting; behind a proxy, requests share that peer's limit.

POST `/v1/traces` accepts OTLP/HTTP JSON with Content-Type application/json (optional UTF-8 charset) and identity or gzip encoding. The request and decompressed body are capped at 256 KiB. Invalid UTF-8, JSON, JourneyGap schema or IDs return 400; oversized bodies 413; unsupported media/encoding 415; blocked origins 403; methods other than POST/OPTIONS 405. Requests must finish sending their body within 5 seconds. Successful ingestion returns 200 application/json with `{}`. Only validated step rows are persisted; unrelated spans are discarded. Navigation/error counts are process-local observations, not durable session histories.

Allowed-origin browser preflight accepts POST and Content-Type only. Each peer has rateLimitPerMinute requests, including preflight, in a one-minute fixed window. The receiver also limits total ingest requests to 100 times that value per minute, temporary peer buckets to 10000, active connections to 100, and headers to 8 KiB. Rate failures return 429 and Retry-After 60. Storage quota failures return 429. Neither payloads nor IPs are logged. Unhandled ingest failures return a generic 500 without configuration, records or secrets.

See [storage](storage.md) for retention and disk budget details and [privacy](privacy.md) for the operator notice. Health does not disclose configuration. Unknown paths, including administration before its implementation, return 404. Admin reporting and optional upstream forwarding are separate implementation tasks; this receiver does not yet provide them. A static host can serve the browser application but cannot run this Node service.
