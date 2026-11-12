import type { RelayConfig } from "../../packages/core/src/index.js";

export const relayConfig: RelayConfig = {
  schemaVersion: 1,
  allowedOrigins: ["http://localhost:5173"],
  services: [
    {
      serviceName: "sample-web",
      journeys: [
        {
          id: "first-task",
          steps: [{ id: "started" }, { id: "completed", terminal: true }],
          timeoutMinutes: 30,
        },
      ],
      attributesAllowlist: [
        "app.category",
        "app.count",
        "app.active",
        "app.email",
        "app.secret",
      ],
    },
  ],
  retentionDays: 14,
  rateLimitPerMinute: 60,
};

export const baseAttributes: Record<string, unknown> = {
  "journeygap.schema_version": { intValue: "1" },
  "journeygap.event_id": {
    stringValue: "00000000-0000-4000-8000-000000000001",
  },
  "journeygap.session_id": {
    stringValue: "00000000-0000-4000-8000-000000000002",
  },
  "journeygap.instance_id": {
    stringValue: "00000000-0000-4000-8000-000000000003",
  },
  "journeygap.event_type": { stringValue: "step" },
  "journeygap.journey_id": { stringValue: "first-task" },
  "journeygap.step_id": { stringValue: "started" },
};

export function otlpFixture(
  options: {
    attributes?: Record<string, unknown>;
    span?: Record<string, unknown>;
    serviceName?: string;
  } = {},
) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: options.serviceName ?? "sample-web" },
            },
            { key: "service.version", value: { stringValue: "0.1.0" } },
            {
              key: "deployment.environment.name",
              value: { stringValue: "test" },
            },
            { key: "host.name", value: { stringValue: "private-host" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "untrusted", version: "secret" },
            spans: [
              {
                traceId: "1234567890abcdef1234567890abcdef",
                spanId: "1234567890abcdef",
                name: "journeygap.step",
                kind: 1,
                startTimeUnixNano: "1794517200000000000",
                endTimeUnixNano: "1794517200001000000",
                attributes: Object.entries({
                  ...baseAttributes,
                  ...options.attributes,
                }).map(([key, value]) => ({ key, value })),
                ...options.span,
              },
            ],
          },
        ],
      },
    ],
  };
}
