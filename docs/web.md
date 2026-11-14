# Web telemetry transport

The SDK transport is implemented internally; the consent-gated public client is a separate implementation task. Do not instantiate telemetry before consent. Browser initialization and navigation examples will be added with those APIs.

The transport uses a dedicated OpenTelemetry TracerProvider with resource service.name and a safe service.version when available. It never registers or replaces a global provider. Each event is a completed, independent short span started with ROOT_CONTEXT, with event/session/attempt correlations carried as explicit attributes. No automatic device, URL, user-agent or host-resource detection is installed. Declared journey/step IDs are checked again and custom values pass the shared privacy filter.

Queue capacity is 100 events including the active batch; oldest unsent events are dropped on overflow. Batches run every five seconds, at most 20 spans per request. There is no persistent browser queue. Withdrawal discards the waiting queue synchronously, cancels the batching timer, aborts the active request and retry delay, and prevents subsequent records. Already delivered observations cannot be recalled. Lifecycle callers can await shutdown to release exporter/provider resources.

## Official exporter and bounded transport

Pinned dependencies: API 1.9.0, sdk-trace 2.11.0, resources 2.11.0, exporter-trace-otlp-http 0.222.0. sdk-trace replaces the deprecated sdk-trace-base package name. The official OTLPTraceExporter supplies serialization and response handling; the SDK does not construct a proprietary trace JSON format.

This exporter version does not expose public retry-count or AbortSignal options. Its stock transport can exceed two retries when Retry-After is zero. A narrowly scoped adapter in `packages/web/src/otlp.ts` therefore replaces only the exporter's internal transport after verifying its shape, retaining the official serializer/delegate. Unsupported shapes stop telemetry initialization and are caught by the public client's fail-open boundary. This internal seam requires dependency upgrades to pass the real HTTP, serialization, abort and retry regression tests; do not upgrade it independently of those checks.

Each batch has a three-second total deadline, an initial attempt and at most two retries with 250/500 ms exponential delays. Only transient network failures and HTTP 429/502/503/504 retry. Retry-After can extend a delay only within the deadline; it cannot increase the attempt count. Response bodies are bounded to 64 KiB. HTTP requests omit credentials and referrers, refuse redirects, set application/json, and use best-effort keepalive. Cancellation stops both active fetch and retry waiting. Default diagnostics are silent and error messages contain no payloads or endpoint values.

The exporter invokes completion callbacks before releasing its pending-export slot. The batch processor awaits exporter forceFlush between batches to preserve the configured single-flight limit. Tests exercise all 100 retained events across five actual serialized batches, not only the first batch.

Browser CORS/CSP, page unload delivery and app responsiveness are verified by the browser acceptance suite; Node transport tests alone do not prove those browser properties. Standard Collector round-trip tests are tracked separately from transport unit tests.
