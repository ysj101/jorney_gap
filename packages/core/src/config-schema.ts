// This source drives both public types and the published JSON Schemas.
const id = { type: "string", pattern: "^[a-z][a-z0-9._-]{0,63}$" } as const;
const attributesAllowlist = {
  type: "array",
  maxItems: 10,
  uniqueItems: true,
  items: {
    type: "string",
    maxLength: 64,
    pattern: "^app\\.[a-z][a-z0-9._-]*$",
  },
} as const;

export const journeySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "steps", "timeoutMinutes"],
  properties: {
    id,
    steps: {
      type: "array",
      minItems: 2,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id, terminal: { type: "boolean" } },
      },
    },
    timeoutMinutes: { type: "integer", minimum: 1, maximum: 1440, default: 30 },
  },
} as const;

export const configSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://journeygap.dev/schema/journeygap.schema.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "enabled",
    "serviceName",
    "otlpTracesEndpoint",
    "consent",
    "journeys",
  ],
  properties: {
    schemaVersion: { const: 1 },
    enabled: { type: "boolean" },
    serviceName: id,
    serviceVersion: { type: "string", maxLength: 64 },
    otlpTracesEndpoint: {
      type: "string",
      maxLength: 2048,
      pattern: "^https?://[^\\s?#@]+/v1/traces$",
    },
    consent: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "ui"],
      properties: {
        mode: { const: "opt-in" },
        ui: { enum: ["compact", "external"] },
      },
    },
    routes: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "pattern"],
        properties: {
          id,
          pattern: {
            type: "string",
            maxLength: 256,
            pattern: "^/(?:[a-zA-Z0-9._~-]+|:[a-zA-Z][a-zA-Z0-9_]*|/)*$",
          },
        },
      },
    },
    journeys: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: journeySchema,
    },
    attributesAllowlist,
  },
} as const;

export const relayConfigSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://journeygap.dev/schema/relay.schema.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "allowedOrigins",
    "services",
    "retentionDays",
    "rateLimitPerMinute",
  ],
  properties: {
    schemaVersion: { const: 1 },
    allowedOrigins: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 2048,
        pattern: "^https?://[^\\s/?#@]+$",
      },
    },
    services: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["serviceName", "journeys"],
        properties: {
          serviceName: id,
          journeys: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: journeySchema,
          },
          attributesAllowlist,
        },
      },
    },
    retentionDays: { type: "integer", minimum: 1, maximum: 365, default: 14 },
    rateLimitPerMinute: { type: "integer", minimum: 1, maximum: 100000 },
    maxDatabaseBytes: {
      type: "integer",
      minimum: 1048576,
      maximum: 1099511627776,
    },
    maxEvents: { type: "integer", minimum: 1, maximum: 100000000 },
  },
} as const;
