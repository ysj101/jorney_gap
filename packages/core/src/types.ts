import type { FromSchema } from "json-schema-to-ts";
import type {
  configSchema,
  exporterConfigSchema,
  journeySchema,
  relayConfigSchema,
} from "./config-schema.js";

export type JourneyDefinition = FromSchema<typeof journeySchema>;
export type JourneyStep = JourneyDefinition["steps"][number];
export type JourneyGapExporterConfig = FromSchema<typeof exporterConfigSchema>;
export type JourneyGapConfig = FromSchema<typeof configSchema>;
export type RelayConfig = FromSchema<typeof relayConfigSchema>;
export type Scalar = string | number | boolean;
export type TrackAttributes = Record<string, Scalar>;
export type JourneyGapClient = {
  trackStep(journeyId: string, stepId: string, attrs?: TrackAttributes): void;
  trackError(kind: "render" | "network" | "unknown"): void;
  setConsent(value: boolean): void;
  getConsent(): boolean;
  shutdown(): Promise<void>;
  /** Best effort; exporter acceptance is not backend delivery confirmation. */
  flush?(): Promise<void>;
};

export type JourneyEvent = {
  schemaVersion: 1;
  eventId: string;
  timestampMs: number;
  receivedAtMs?: number;
  sessionId: string;
  instanceId: string;
  journeyId: string;
  stepId: string;
};
