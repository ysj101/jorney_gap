# Web telemetry transport

`@journeygap/web` exports initJourneyGap, getJourneyGapClient and trackStep, together with the shared public types. Initialize once in a browser; repeated calls in the same tab return the same client. The module-level trackStep is a no-op before initialization. Invalid configuration, disabled collection, unavailable storage/crypto, or exporter failures stop only measurement.

```ts
import { initJourneyGap, trackStep } from "@journeygap/web";

const client = initJourneyGap({
  schemaVersion: 1,
  enabled: true,
  serviceName: "sample-web",
  otlpTracesEndpoint: "http://localhost:4318/v1/traces",
  consent: { mode: "opt-in", ui: "compact" },
  routes: [
    { id: "home", pattern: "/" },
    { id: "item", pattern: "/items/:id" },
  ],
  journeys: [
    {
      id: "first-task",
      steps: [
        { id: "started" },
        { id: "reviewed" },
        { id: "completed", terminal: true },
      ],
      timeoutMinutes: 30,
    },
  ],
});

// Call at actual application-defined milestones. Calls before consent do nothing.
trackStep("first-task", "started");
trackStep("first-task", "reviewed");
trackStep("first-task", "completed");
client.trackError("network"); // No error message, URL or stack is accepted.
```

Compact consent offers native allow/refuse buttons with equal choices and a live status. It does not capture focus or block the application and requires no inline script/style CSP exception. Controls remain available for withdrawal. Only the choice is stored in localStorage (`journeygap.consent.v1`). A prior explicit compact grant can resume collection on reload. External mode renders no UI and requires `client.setConsent(true)` from the host consent manager on every initialization, even if a previous choice is stored. Call setConsent(false) to withdraw immediately; cross-tab withdrawal and cleared consent storage also stop collection.

Session IDs are cryptographic UUIDv4 values created only after grant and stored only in sessionStorage (`journeygap.session.v1`). A copied opener session is rotated for a newly opened tab when the same-origin opener is accessible. Reload/reinitialization can reuse the same tab session; withdrawal deletes it. Each journey has an independent current instance; the first step creates a new instance, and another first step supersedes the previous one. Identical consecutive calls in one JavaScript turn are suppressed to reduce StrictMode/effect repeats, while later restarts get new IDs. Undefined combinations and nonfirst steps without an observed start do nothing. Valid order anomalies within an instance remain observable for the analyzer.

shutdown removes the SDK's UI/listeners, discards pending data, and releases its provider without changing the saved preference or the host's UI. The session remains available for a same-tab restart unless consent was withdrawn. Existing application storage is never read or uploaded except the SDK's own choice and session keys. A tab-scoped ID is a pseudonymous identifier, not a guarantee of absolute anonymity; operators must provide the adapted privacy notice.

The transport uses a dedicated OpenTelemetry TracerProvider with resource service.name and a safe service.version when available. It never registers or replaces a global provider. Each event is a completed, independent short span started with ROOT_CONTEXT, with event/session/attempt correlations carried as explicit attributes. No automatic device, URL, user-agent or host-resource detection is installed. Declared journey/step IDs are checked again and custom values pass the shared privacy filter.

Queue capacity is 100 events including the active batch; oldest unsent events are dropped on overflow. Batches run every five seconds, at most 20 spans per request. There is no persistent browser queue. Withdrawal discards the waiting queue synchronously, cancels the batching timer, aborts the active request and retry delay, and prevents subsequent records. Already delivered observations cannot be recalled. Lifecycle callers can await shutdown to release exporter/provider resources.

## Navigation

After consent the current route is observed, followed by hashchange, popstate and safe History API changes. Routes are slash-separated literal/`:parameter` templates, not regular expressions. More literal templates take precedence over dynamic alternatives; ties retain configuration order. Only the configured route ID is exported, never the matched URL or parameter. Unknown paths normalize to unknown. Queries and fragment identifiers are discarded; a `#/...` hash router is matched as a route path with its query/secondary fragment removed. Consecutive events for the same route ID are suppressed, including dynamic parameter changes within one template.

An explicit same-origin `<base href="/demo/">` supplies a subpath prefix for pathname matching; hash routing is independent of that prefix. Without a base element, configure templates for the actual pathname (including its deployment prefix). The SDK does not guess a base from a URL that might itself be a dynamic route. Static builds can use explicit prefixed patterns, a base element, or hash routes without collecting the raw prefix.

History methods are patched only when they match native prototype functions. An existing foreign patch or nonnative implementation uses hashchange/popstate fallback. A failed/nonwritable patch is rolled back. Wrappers preserve the original operation's return/exception behavior and catch only observation errors. Shutdown restores only methods still owned by this SDK; a later foreign wrapper is left intact, with the embedded JourneyGap observer disabled. Withdrawal resets deduplication so a later grant observes the then-current route again. No navigation event or event ID is generated while consent is off.

## Official exporter and bounded transport

Pinned dependencies: API 1.9.0, sdk-trace 2.11.0, resources 2.11.0, exporter-trace-otlp-http 0.222.0. sdk-trace replaces the deprecated sdk-trace-base package name. The official OTLPTraceExporter supplies serialization and response handling; the SDK does not construct a proprietary trace JSON format.

This exporter version does not expose public retry-count or AbortSignal options. Its stock transport can exceed two retries when Retry-After is zero. A narrowly scoped adapter in `packages/web/src/otlp.ts` therefore replaces only the exporter's internal transport after verifying its shape, retaining the official serializer/delegate. Unsupported shapes stop telemetry initialization and are caught by the public client's fail-open boundary. This internal seam requires dependency upgrades to pass the real HTTP, serialization, abort and retry regression tests; do not upgrade it independently of those checks.

Each batch has a three-second total deadline, an initial attempt and at most two retries with 250/500 ms exponential delays. Only transient network failures and HTTP 429/502/503/504 retry. Retry-After can extend a delay only within the deadline; it cannot increase the attempt count. Response bodies are bounded to 64 KiB. HTTP requests omit credentials and referrers, refuse redirects, set application/json, and use best-effort keepalive. Cancellation stops both active fetch and retry waiting. Default diagnostics are silent and error messages contain no payloads or endpoint values.

The exporter invokes completion callbacks before releasing its pending-export slot. The batch processor awaits exporter forceFlush between batches to preserve the configured single-flight limit. Tests exercise all 100 retained events across five actual serialized batches, not only the first batch.

Browser CORS/CSP, page unload delivery and app responsiveness are verified by the browser acceptance suite; Node transport tests alone do not prove those browser properties. Standard Collector round-trip tests are tracked separately from transport unit tests.
