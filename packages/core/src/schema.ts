import { validateRelay, validateWeb } from "./generated/validators.cjs";
import type {
  JourneyDefinition,
  JourneyGapConfig,
  RelayConfig,
} from "./types.js";

const webValidator = validateWeb as (
  value: unknown,
) => value is JourneyGapConfig;
const relayValidator = validateRelay as (
  value: unknown,
) => value is RelayConfig;

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: string[] };

/** HTTPS everywhere except explicit loopback development. No embedded secrets. */
export function isSafeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith("/v1/traces") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function duplicateIds(items: { id: string }[], context: string): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const item of items) {
    if (seen.has(item.id)) errors.push(`${context}: duplicate ID`);
    seen.add(item.id);
  }
  return errors;
}

function journeyErrors(journeys: JourneyDefinition[]): string[] {
  const errors = duplicateIds(journeys, "journeys");
  for (const journey of journeys) {
    errors.push(...duplicateIds(journey.steps, "steps"));
    if (
      journey.steps.at(-1)?.terminal !== true ||
      journey.steps.slice(0, -1).some((step) => step.terminal === true)
    ) {
      errors.push("Only the final step must be terminal");
    }
  }
  return errors;
}

function clone(input: unknown): unknown {
  // Reject non-JSON, cyclic, and oversized configuration without exposing values.
  const json = JSON.stringify(input);
  if (json === undefined || json.length > 262144)
    throw new Error("Invalid config");
  return JSON.parse(json);
}

export function validateConfig(
  input: unknown,
): ValidationResult<JourneyGapConfig> {
  try {
    const value = clone(input);
    if (!webValidator(value))
      return {
        valid: false,
        errors: ["Configuration does not match JSON Schema"],
      };
    const errors = journeyErrors(value.journeys);
    if (!isSafeEndpoint(value.otlpTracesEndpoint))
      errors.push(
        "Endpoint must be HTTPS or loopback HTTP without credentials/query/fragment",
      );
    if (value.routes) {
      errors.push(...duplicateIds(value.routes, "routes"));
      const patterns = new Set(value.routes.map((route) => route.pattern));
      if (patterns.size !== value.routes.length)
        errors.push("Duplicate route patterns");
      if (
        value.routes.some(
          (route) =>
            !/^\/(?:[a-zA-Z0-9._~-]+|:[a-zA-Z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9._~-]+|:[a-zA-Z][a-zA-Z0-9_]*))*\/?$/.test(
              route.pattern,
            ) && route.pattern !== "/",
        )
      )
        errors.push("Invalid route pattern");
    }
    return errors.length ? { valid: false, errors } : { valid: true, value };
  } catch {
    return { valid: false, errors: ["Invalid JSON configuration"] };
  }
}

export function validateRelayConfig(
  input: unknown,
): ValidationResult<RelayConfig> {
  try {
    const value = clone(input);
    if (!relayValidator(value))
      return {
        valid: false,
        errors: ["Relay configuration does not match JSON Schema"],
      };
    const errors: string[] = [];
    const services = new Set(
      value.services.map((service) => service.serviceName),
    );
    if (services.size !== value.services.length)
      errors.push("Duplicate services");
    for (const service of value.services)
      errors.push(...journeyErrors(service.journeys));
    for (const origin of value.allowedOrigins) {
      const url = new URL(origin);
      if (url.origin !== origin || !isSafeEndpoint(`${origin}/v1/traces`))
        errors.push("Origin must be an HTTPS origin or loopback HTTP");
    }
    return errors.length ? { valid: false, errors } : { valid: true, value };
  } catch {
    return { valid: false, errors: ["Invalid JSON Relay configuration"] };
  }
}

export function isDefinedStep(
  config: Pick<JourneyGapConfig, "journeys">,
  journeyId: string,
  stepId: string,
): boolean {
  return config.journeys.some(
    (journey) =>
      journey.id === journeyId &&
      journey.steps.some((step) => step.id === stepId),
  );
}
