import { safeVersion, sanitizeAttributes, scalarToOtlp } from "./privacy.js";
import { isDefinedStep } from "./schema.js";
import type {
  JourneyEvent,
  RelayConfig,
  Scalar,
  TrackAttributes,
} from "./types.js";

export const MAX_OTLP_BYTES = 256 * 1024;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = /^[a-z][a-z0-9._-]{0,63}$/;
type Obj = Record<string, unknown>;

export type ClientEvent = {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  timestampMs: number;
  receivedAtMs: number;
  serviceName: string;
  appVersion?: string;
  attributes: TrackAttributes;
} & (
  | { eventType: "step"; instanceId: string; journeyId: string; stepId: string }
  | { eventType: "navigation"; routeId: string }
  | { eventType: "error"; errorKind: "render" | "network" | "unknown" }
);
export type StoredJourneyEvent = JourneyEvent & {
  serviceName: string;
  appVersion?: string;
};
export type OtlpAttribute = { key: string; value: Record<string, Scalar> };
export type SanitizedSpan = {
  traceId: string;
  spanId: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
};
export type SanitizedOtlp = {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string }; spans: SanitizedSpan[] }>;
  }>;
};

export class OtlpValidationError extends Error {
  constructor() {
    super("Invalid OTLP JSON payload");
  }
}
function fail(): never {
  throw new OtlpValidationError();
}
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as Obj;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000) return fail();
  return value;
}
function checkBounds(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (depth > 16 || ++budget.count > 20000) fail();
  if (Array.isArray(value)) {
    for (const child of array(value)) checkBounds(child, depth + 1, budget);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value))
      checkBounds(child, depth + 1, budget);
  }
}
function scalar(value: unknown): Scalar | undefined {
  const item = object(value);
  if (Object.keys(item).length !== 1) return undefined;
  if (typeof item.stringValue === "string") return item.stringValue;
  if (typeof item.boolValue === "boolean") return item.boolValue;
  if (typeof item.doubleValue === "number" && Number.isFinite(item.doubleValue))
    return item.doubleValue;
  if (
    (typeof item.intValue === "string" && /^-?\d+$/.test(item.intValue)) ||
    typeof item.intValue === "number"
  ) {
    const number = Number(item.intValue);
    if (Number.isSafeInteger(number)) return number;
  }
  return undefined;
}
function attributes(value: unknown): Record<string, Scalar> {
  const result: Record<string, Scalar> = Object.create(null);
  const seen = new Set<string>();
  for (const raw of array(value ?? [])) {
    const attr = object(raw);
    if (typeof attr.key !== "string" || seen.has(attr.key)) fail();
    seen.add(attr.key);
    // Ignore unsupported AnyValue variants, never forward their contents.
    const decoded = scalar(attr.value);
    if (decoded !== undefined) result[attr.key] = decoded;
  }
  return result;
}
function requiredString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail();
  return value;
}
function nanos(value: unknown): bigint {
  if (
    typeof value !== "string" &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  )
    return fail();
  const text = String(value);
  if (!/^\d{1,20}$/.test(text)) return fail();
  const number = BigInt(text);
  if (number <= 0n || number > 18446744073709551615n) return fail();
  return number;
}
function attr(key: string, value: Scalar): OtlpAttribute {
  return { key, value: scalarToOtlp(value) };
}

/** Parse bounded OTLP JSON; return only allowlisted reconstructed spans. */
export function parseOtlpJson(
  text: string,
  config: RelayConfig,
  receivedAtMs = Date.now(),
): {
  events: ClientEvent[];
  journeyEvents: StoredJourneyEvent[];
  sanitized: SanitizedOtlp;
} {
  if (
    new TextEncoder().encode(text).length > MAX_OTLP_BYTES ||
    !Number.isSafeInteger(receivedAtMs) ||
    receivedAtMs < 0
  )
    fail();
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return fail();
  }
  checkBounds(input);
  const events: ClientEvent[] = [];
  const journeyEvents: StoredJourneyEvent[] = [];
  const sanitized: SanitizedOtlp = { resourceSpans: [] };
  for (const rawResource of array(object(input).resourceSpans ?? [])) {
    const resource = object(rawResource);
    const resourceAttrs = attributes(
      object(resource.resource ?? {}).attributes,
    );
    const serviceName = resourceAttrs["service.name"];
    const service = config.services.find(
      (item) => item.serviceName === serviceName,
    );
    const spans: SanitizedSpan[] = [];
    for (const rawScope of array(resource.scopeSpans ?? [])) {
      for (const rawSpan of array(object(rawScope).spans ?? [])) {
        const span = object(rawSpan);
        if (
          typeof span.name !== "string" ||
          !span.name.startsWith("journeygap.")
        )
          continue;
        if (!service || typeof serviceName !== "string") fail();
        const data = attributes(span.attributes);
        const get = (key: string) => data[`journeygap.${key}`];
        if (get("schema_version") !== 1) fail();
        const eventId = requiredString(get("event_id"), uuid).toLowerCase();
        const sessionId = requiredString(get("session_id"), uuid).toLowerCase();
        const eventType = get("event_type");
        if (
          !["step", "navigation", "error"].includes(String(eventType)) ||
          span.name !== `journeygap.${eventType}`
        )
          fail();
        const traceId = requiredString(
          span.traceId,
          /^[0-9a-f]{32}$/i,
        ).toLowerCase();
        const spanId = requiredString(
          span.spanId,
          /^[0-9a-f]{16}$/i,
        ).toLowerCase();
        if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) fail();
        const start = nanos(span.startTimeUnixNano);
        const end = nanos(span.endTimeUnixNano);
        if (end < start) fail();
        const timestampMs = Number(start / 1000000n);
        const custom = sanitizeAttributes(data, service.attributesAllowlist);
        const appVersion = safeVersion(get("app_version"));
        const base = {
          schemaVersion: 1 as const,
          eventId,
          sessionId,
          timestampMs,
          receivedAtMs,
          serviceName,
          attributes: custom,
          ...(appVersion === undefined ? {} : { appVersion }),
        };
        const spanAttrs: OtlpAttribute[] = [
          attr("journeygap.schema_version", 1),
          attr("journeygap.event_id", eventId),
          attr("journeygap.session_id", sessionId),
          attr("journeygap.event_type", String(eventType)),
        ];
        let event: ClientEvent;
        if (eventType === "step") {
          const instanceId = requiredString(
            get("instance_id"),
            uuid,
          ).toLowerCase();
          const journeyId = requiredString(get("journey_id"), id);
          const stepId = requiredString(get("step_id"), id);
          if (!isDefinedStep(service, journeyId, stepId)) fail();
          event = { ...base, eventType, instanceId, journeyId, stepId };
          journeyEvents.push({
            schemaVersion: 1,
            eventId,
            sessionId,
            timestampMs,
            receivedAtMs,
            instanceId,
            journeyId,
            stepId,
            serviceName,
            ...(appVersion === undefined ? {} : { appVersion }),
          });
          spanAttrs.push(
            attr("journeygap.instance_id", instanceId),
            attr("journeygap.journey_id", journeyId),
            attr("journeygap.step_id", stepId),
          );
        } else if (eventType === "navigation") {
          const routeId = requiredString(get("route_id"), id);
          event = { ...base, eventType, routeId };
          spanAttrs.push(attr("journeygap.route_id", routeId));
        } else {
          const errorKind = get("error_kind");
          if (
            errorKind !== "render" &&
            errorKind !== "network" &&
            errorKind !== "unknown"
          )
            fail();
          event = { ...base, eventType: "error", errorKind };
          spanAttrs.push(attr("journeygap.error_kind", errorKind));
        }
        if (appVersion !== undefined)
          spanAttrs.push(attr("journeygap.app_version", appVersion));
        for (const [key, value] of Object.entries(custom))
          spanAttrs.push(attr(key, value));
        events.push(event);
        spans.push({
          traceId,
          spanId,
          name: `journeygap.${eventType}`,
          kind: 1,
          startTimeUnixNano: start.toString(),
          endTimeUnixNano: end.toString(),
          attributes: spanAttrs,
        });
      }
    }
    if (spans.length && typeof serviceName === "string") {
      const allowedResourceAttrs = [attr("service.name", serviceName)];
      const version = safeVersion(resourceAttrs["service.version"]);
      if (version) allowedResourceAttrs.push(attr("service.version", version));
      const environment = safeVersion(
        resourceAttrs["deployment.environment.name"],
      );
      if (environment)
        allowedResourceAttrs.push(
          attr("deployment.environment.name", environment),
        );
      sanitized.resourceSpans.push({
        resource: { attributes: allowedResourceAttrs },
        scopeSpans: [{ scope: { name: "@journeygap/web" }, spans }],
      });
    }
  }
  return { events, journeyEvents, sanitized };
}
