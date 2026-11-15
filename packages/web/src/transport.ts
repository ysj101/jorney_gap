import {
  isDefinedStep,
  type JourneyGapConfig,
  type JourneyGapExporterConfig,
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
import type {
  JourneyGapExporter,
  JourneyGapExporterOptions,
} from "./exporter.js";
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

/** Prevent a broken extension from keeping flush/shutdown pending forever. */
async function bounded(
  operation: () => Promise<unknown> | undefined,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
  } catch {
    /* Extension failures affect measurement only. */
  } finally {
    clearTimeout(timer);
  }
}

/** Internal factory, called only after consent. Never registers a global provider. */
export function createTelemetry(
  config: JourneyGapConfig | JourneyGapExporterConfig,
  options?: JourneyGapExporterOptions,
) {
  const output: JourneyGapExporter = options
    ? options.createExporter()
    : createBoundedExporter((config as JourneyGapConfig).otlpTracesEndpoint);
  if (
    !output ||
    typeof output.exporter?.export !== "function" ||
    typeof output.exporter.shutdown !== "function" ||
    typeof output.discard !== "function"
  ) {
    try {
      output?.discard?.();
    } catch {
      /* Release partially constructed adapters. */
    }
    throw new Error("Invalid custom exporter");
  }
  const queue: ReadableSpan[] = [];
  let stopped = false;
  let flushing: Promise<void> | undefined;
  let inFlight = 0;
  const pendingExports = new Set<(success: boolean) => void>();
  const counters = { dropped: 0, exported: 0, failed: 0 };
  function discard(): void {
    stopped = true;
    counters.dropped += queue.length;
    queue.length = 0;
    clearInterval(timer);
    for (const finish of pendingExports) finish(false);
    try {
      output.discard();
    } catch {
      /* Continue releasing provider resources. */
    }
  }
  async function flushBatches(): Promise<void> {
    while (!stopped && queue.length) {
      const batch = queue.splice(0, 20);
      inFlight = batch.length;
      const success = await new Promise<boolean>((resolve) => {
        let finished = false;
        const finish = (ok: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          pendingExports.delete(finish);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), 3000);
        pendingExports.add(finish);
        try {
          output.exporter.export(batch, (result) => finish(result.code === 0));
        } catch {
          finish(false);
        }
      });
      // The official exporter invokes its callback before releasing the pending
      // export slot. Await that slot before submitting the next bounded batch.
      await bounded(() =>
        output.forceFlush
          ? output.forceFlush()
          : output.exporter.forceFlush?.(),
      );
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
      await bounded(() => output.exporter.shutdown());
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
      requests: output.requests?.() ?? 0,
    }),
  };
}
export type Telemetry = ReturnType<typeof createTelemetry>;
