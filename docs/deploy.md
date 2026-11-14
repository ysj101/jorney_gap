# Running the reference Relay

Node.js 24+ and the workspace build are required. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
export JOURNEYGAP_ADMIN_TOKEN="$(openssl rand -hex 32)"
node packages/relay/dist/main.js --config deploy/journeygap.relay.example.json --db ./data/journeygap.db
curl http://127.0.0.1:4318/healthz
```

The response is only `{"status":"ok"}`. Startup requires a server-only JOURNEYGAP_ADMIN_TOKEN of 32–256 printable nonspace characters; use a cryptographically random value and keep it outside browser configuration. The CLI reads the process environment; it does not automatically load `.env`. The default bind address is 127.0.0.1. Use `--port` and an explicit `--host` when needed; binding to 0.0.0.0 must be an intentional operator choice. SIGINT/SIGTERM stop the server and close storage. The package includes the `journeygap-relay` binary for packaged use; package publication is separate and has not occurred.

Configure explicit allowedOrigins and service/journey definitions using the shared [configuration contract](configuration.md). The example permits only localhost development origins. Public deployments require TLS termination, a protected ingress/proxy, rate/volume limits, storage quotas, monitoring and separate authenticated administration. CORS is not authentication: a nonbrowser sender can omit or forge Origin and contaminate public telemetry. Do not trust X-Forwarded-For without a separately designed trusted proxy boundary. The receiver uses the direct peer IP temporarily for rate limiting; behind a proxy, requests share that peer's limit.

POST `/v1/traces` accepts OTLP/HTTP JSON with Content-Type application/json (optional UTF-8 charset) and identity or gzip encoding. The request and decompressed body are capped at 256 KiB. Invalid UTF-8, JSON, JourneyGap schema or IDs return 400; oversized bodies 413; unsupported media/encoding 415; blocked origins 403; methods other than POST/OPTIONS 405. Requests must finish sending their body within 5 seconds. Successful ingestion returns 200 application/json with `{}`. Only validated step rows are persisted; unrelated spans are discarded. Navigation/error counts are process-local observations, not durable session histories.

Allowed-origin browser preflight accepts POST and Content-Type only. Each peer has rateLimitPerMinute requests, including preflight, in a one-minute fixed window. The receiver also limits total ingest requests to 100 times that value per minute, temporary peer buckets to 10000, active connections to 100, and headers to 8 KiB. Rate failures return 429 and Retry-After 60. Storage quota failures return 429. Neither payloads nor IPs are logged. Unhandled ingest failures return a generic 500 without configuration, records or secrets.

## Authenticated reports

```sh
curl -H "Authorization: Bearer $JOURNEYGAP_ADMIN_TOKEN" \
  'http://127.0.0.1:4318/admin/v1/report?journey=first-task&days=7'
```

GET `/admin/v1/report` requires the server token even on loopback. Authentication uses a constant-time comparison of fixed-length digests; failures return 401 without reflecting submitted headers. There are no browser CORS headers on admin responses. Keep this path on an operator-only interface/proxy route. Never insert the token into a URL, a web bundle, a trace or a log.

`journey` must be configured. `service` is optional only when exactly one service is configured; otherwise it is required to avoid mixing services that share journey IDs. `days` defaults to 7 and accepts integer values 1–365. Duplicate or unknown query parameters are rejected. Unknown configured journeys return 404; malformed/ambiguous arguments return 400; methods other than GET return 405 after authentication. Reports return aggregate evidence and uncertainty, not individual event/session rows or server configuration. A window exceeding retention produces an explicit warning. Admin requests share the receiver's peer/global rate limits. Responses are not cached.

See [storage](storage.md) for retention and disk budget details and [privacy](privacy.md) for the operator notice. Health does not disclose configuration. Unknown paths return 404. Optional upstream forwarding is a separate implementation task. A static host can serve the browser application but cannot run this Node service.
