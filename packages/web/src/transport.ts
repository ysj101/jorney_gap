import {
  isDefinedStep,
  type JourneyGapConfig,
  safeVersion,
  sanitizeAttributes,
  type TrackAttributes,
} from "@journeygap/core";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  type ReadableSpan,
  type SpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { createBoundedExporter } from "./otlp.js";

export type WebEvent = {
  eventId: string;
  sessionId: string;
  timestampMs: number;
  attributes?: TrackAttributes;
} & (
  | { eventType: "step"; instanceId: string; journeyId: string; stepId: string }
  | { eventType: "navigation"; routeId: string }
  | { eventType: "error"; errorKind: "render" | "network" | "unknown" }
);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Internal factory, called only after consent. Never registers a global provider. */
export function createTelemetry(config: JourneyGapConfig) {
  const output = createBoundedExporter(config.otlpTracesEndpoint);
  const queue: ReadableSpan[] = [];
  let stopped = false;
  let flushing: Promise<void> | undefined;
  let inFlight = 0;
  const counters = { dropped: 0, exported: 0, failed: 0 };
  function discard(): void {
    stopped = true;
    counters.dropped += queue.length;
    queue.length = 0;
    clearInterval(timer);
    output.discard();
  }
  async function flushBatches(): Promise<void> {
    while (!stopped && queue.length) {
      const batch = queue.splice(0, 20);
      inFlight = batch.length;
      const success = await new Promise<boolean>((resolve) => {
        try {
          output.exporter.export(batch, (result) => resolve(result.code === 0));
        } catch {
          resolve(false);
        }
      });
      // The official exporter invokes its callback before releasing the pending
      // export slot. Await that slot before submitting the next bounded batch.
      await output.exporter.forceFlush().catch(() => {});
      if (success) counters.exported += batch.length;
      else counters.failed += batch.length;
      inFlight = 0;
    }
  }
  function flush(): Promise<void> {
    if (!flushing)
      flushing = flushBatches().finally(() => {
        flushing = undefined;
      });
    return flushing;
  }
  const processor: SpanProcessor = {
    onStart() {},
    onEnd(span) {
      if (stopped) return;
      if (queue.length + inFlight >= 100) {
        queue.shift();
        counters.dropped++;
      }
      queue.push(span);
    },
    forceFlush: flush,
    async shutdown() {
      discard();
      await flushing;
      await output.exporter.shutdown();
    },
  };
  const resource: Record<string, string> = {
    "service.name": config.serviceName,
  };
  const version = safeVersion(config.serviceVersion);
  if (version) resource["service.version"] = version;
  const provider = new TracerProvider({
    resource: resourceFromAttributes(resource),
    spanProcessors: [processor],
    spanLimits: {
      attributeCountLimit: 32,
      attributeValueLengthLimit: 100,
      eventCountLimit: 0,
      linkCountLimit: 0,
    },
  });
  const tracer = provider.getTracer("@journeygap/web", "0.1.0");
  const timer = setInterval(() => {
    void flush().catch(() => {});
  }, 5000);
  // Node-based integration tests must not be held open by browser batching.
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return {
    record(event: WebEvent): void {
      try {
        if (
          stopped ||
          !config.enabled ||
          !uuid.test(event.eventId) ||
          !uuid.test(event.sessionId) ||
          !Number.isSafeInteger(event.timestampMs) ||
          event.timestampMs < 0
        )
          return;
        const attributes: Record<string, string | number | boolean> = {
          ...sanitizeAttributes(event.attributes, config.attributesAllowlist),
          "journeygap.schema_version": 1,
          "journeygap.event_id": event.eventId,
          "journeygap.session_id": event.sessionId,
          "journeygap.event_type": event.eventType,
        };
        if (version) attributes["journeygap.app_version"] = version;
        if (event.eventType === "step") {
          if (
            !uuid.test(event.instanceId) ||
            !isDefinedStep(config, event.journeyId, event.stepId)
          )
            return;
          attributes["journeygap.instance_id"] = event.instanceId;
          attributes["journeygap.journey_id"] = event.journeyId;
          attributes["journeygap.step_id"] = event.stepId;
        } else if (event.eventType === "navigation") {
          attributes["journeygap.route_id"] = config.routes?.some(
            (route) => route.id === event.routeId,
          )
            ? event.routeId
            : "unknown";
        } else if (event.eventType === "error") {
          if (!["render", "network", "unknown"].includes(event.errorKind))
            return;
          attributes["journeygap.error_kind"] = event.errorKind;
        } else return;
        const span = tracer.startSpan(
          `journeygap.${event.eventType}`,
          { attributes, startTime: event.timestampMs },
          ROOT_CONTEXT,
        );
        span.end(event.timestampMs);
      } catch {
        /* Observation is fail-open. */
      }
    },
    flush,
    discard,
    shutdown: () => provider.shutdown().catch(() => {}),
    stats: () => ({
      ...counters,
      queued: queue.length,
      inFlight,
      requests: output.requests(),
    }),
  };
}
export type Telemetry = ReturnType<typeof createTelemetry>;
