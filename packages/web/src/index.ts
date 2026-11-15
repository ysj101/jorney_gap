export type {
  JourneyDefinition,
  JourneyGapClient,
  JourneyGapConfig,
  JourneyGapExporterConfig,
  JourneyStep,
  Scalar,
  TrackAttributes,
} from "@journeygap/core";
export { getJourneyGapClient, initJourneyGap, trackStep } from "./client.js";

export type {
  JourneyGapExporter,
  JourneyGapExporterOptions,
} from "./exporter.js";
