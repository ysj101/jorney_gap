import type { SpanExporter } from "@opentelemetry/sdk-trace";

/** One consent epoch. discard must synchronously stop new work and abort requests. */
export interface JourneyGapExporter {
  exporter: SpanExporter;
  discard(): void;
  forceFlush?(): Promise<void>;
  requests?(): number;
}

/** Called only after opt-in; called again with fresh resources after regrant. */
export interface JourneyGapExporterOptions {
  createExporter(): JourneyGapExporter;
}
