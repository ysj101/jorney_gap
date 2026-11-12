import { expect, it } from "vitest";
import {
  MAX_OTLP_BYTES,
  OtlpValidationError,
  parseOtlpJson,
  sanitizeAttributes,
} from "../packages/core/src/index.js";
import { baseAttributes, otlpFixture, relayConfig } from "./fixtures/otlp.js";

const parse = (fixture: unknown) =>
  parseOtlpJson(JSON.stringify(fixture), relayConfig, 1794517200100);

it("decodes standard protobuf JSON scalar mappings and preserves exact trace timestamps", () => {
  const result = parse(
    otlpFixture({
      attributes: {
        "app.category": { stringValue: "demo" },
        "app.count": { intValue: "2" },
        "app.active": { boolValue: true },
        "journeygap.app_version": { stringValue: "1.2.3" },
      },
    }),
  );
  expect(result.events[0]).toMatchObject({
    eventType: "step",
    serviceName: "sample-web",
    timestampMs: 1794517200000,
    receivedAtMs: 1794517200100,
    appVersion: "1.2.3",
    attributes: { "app.category": "demo", "app.count": 2, "app.active": true },
  });
  expect(result.journeyEvents).toHaveLength(1);
  const sanitized = result.sanitized.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  expect(sanitized?.startTimeUnixNano).toBe("1794517200000000000");
  expect(sanitized?.attributes).toContainEqual({
    key: "journeygap.schema_version",
    value: { intValue: "1" },
  });
  expect(parse(result.sanitized).events).toEqual(result.events);
});

it("normalizes intValue numbers and doubleValue", () => {
  for (const value of [{ intValue: 2 }, { doubleValue: 1.25 }]) {
    const result = parse(otlpFixture({ attributes: { "app.count": value } }));
    expect(result.events[0]?.attributes["app.count"]).toBe(
      Object.values(value)[0],
    );
  }
});

it("removes private fields at every envelope level", () => {
  const result = parse(
    otlpFixture({
      attributes: {
        "app.email": { stringValue: "fake@example.test" },
        "app.secret": { stringValue: "password" },
        "http.url": {
          stringValue: "https://private.example.test/?token=dummy",
        },
        "journeygap.extra": { stringValue: "private-value" },
      },
      span: {
        events: [{ name: "private-event" }],
        links: [{ traceId: "private-link" }],
        status: { message: "private-status" },
      },
    }),
  );
  const text = JSON.stringify(result);
  for (const secret of [
    "fake@example.test",
    "password",
    "private",
    "http.url",
    "untrusted",
  ])
    expect(text).not.toContain(secret);
});

it("ignores non-JourneyGap spans even from unregistered services and accepts empty requests", () => {
  const empty = {
    events: [],
    journeyEvents: [],
    sanitized: { resourceSpans: [] },
  };
  expect(
    parse(
      otlpFixture({
        serviceName: "unregistered",
        span: { name: "http.request" },
      }),
    ),
  ).toEqual(empty);
  expect(parse({})).toEqual(empty);
});

it.each([
  { serviceName: "unregistered" },
  { span: { name: "journeygap.unknown" } },
  { span: { traceId: "0".repeat(32) } },
  { span: { spanId: "not-a-span-id" } },
  { span: { endTimeUnixNano: "1" } },
  { span: { startTimeUnixNano: "18446744073709551616" } },
  { span: { startTimeUnixNano: 1794517200000000000 } },
  { attributes: { "journeygap.schema_version": { intValue: "2" } } },
  { attributes: { "journeygap.session_id": { stringValue: "not-a-uuid" } } },
  {
    attributes: {
      "journeygap.instance_id": {
        stringValue: "00000000-0000-1000-8000-000000000003",
      },
    },
  },
  { attributes: { "journeygap.step_id": { stringValue: "unknown" } } },
  { attributes: { "journeygap.journey_id": { stringValue: "unknown" } } },
  {
    attributes: {
      "journeygap.schema_version": { intValue: "1", boolValue: true },
    },
  },
])("rejects invalid JourneyGap data: %j", (options) => {
  expect(() => parse(otlpFixture(options))).toThrow(OtlpValidationError);
});

it("supports navigation and errors while producing no journey rows", () => {
  const navigation = parse(
    otlpFixture({
      attributes: {
        "journeygap.event_type": { stringValue: "navigation" },
        "journeygap.route_id": { stringValue: "unknown" },
      },
      span: { name: "journeygap.navigation" },
    }),
  );
  expect(navigation.events[0]).toMatchObject({
    eventType: "navigation",
    routeId: "unknown",
  });
  expect(navigation.journeyEvents).toEqual([]);
  const error = parse(
    otlpFixture({
      attributes: {
        "journeygap.event_type": { stringValue: "error" },
        "journeygap.error_kind": { stringValue: "network" },
      },
      span: { name: "journeygap.error" },
    }),
  );
  expect(error.events[0]).toMatchObject({
    eventType: "error",
    errorKind: "network",
  });
  expect(error.journeyEvents).toEqual([]);
});

it("rejects duplicate attribute keys including unsupported values", () => {
  const attributes = Object.entries(baseAttributes).map(([key, value]) => ({
    key,
    value,
  }));
  attributes.push(
    { key: "app.count", value: { arrayValue: { values: [] } } },
    { key: "app.count", value: { intValue: "2" } },
  );
  expect(() => parse(otlpFixture({ span: { attributes } }))).toThrow(
    OtlpValidationError,
  );
});

it("bounds raw bytes, depth, array sizes and total nodes", () => {
  for (const text of [
    "{",
    "x".repeat(MAX_OTLP_BYTES + 1),
    JSON.stringify({ unknown: "あ".repeat(MAX_OTLP_BYTES / 2) }),
    JSON.stringify({ unknown: Array(1001).fill(0) }),
  ])
    expect(() => parseOtlpJson(text, relayConfig)).toThrow(OtlpValidationError);
  let nested: unknown = {};
  for (let i = 0; i < 18; i++) nested = { child: nested };
  expect(() => parse(nested)).toThrow(OtlpValidationError);
  expect(() =>
    parse({ unknown: Array.from({ length: 30 }, () => Array(1000).fill(0)) }),
  ).toThrow(OtlpValidationError);
});

it("drops unsafe values even if allowlisted, without invoking getters", () => {
  for (const value of [
    "my free text",
    "fake@example.test",
    "https://example.test",
    "x".repeat(101),
    "abcdefghijklmnopqrstuvwxyz123456",
    "Bearer-dummy",
    "token",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    ["demo"],
  ])
    expect(
      sanitizeAttributes({ "app.category": value }, ["app.category"]),
    ).toEqual({});
  const input = {
    "app.category": "demo",
    "app.count": 2,
    "app.active": false,
    "app.email": "demo",
    "not.allowed": true,
  };
  expect(sanitizeAttributes(input, Object.keys(input))).toEqual({
    "app.category": "demo",
    "app.count": 2,
    "app.active": false,
  });
  expect(
    sanitizeAttributes(
      {
        get "app.category"() {
          throw new Error("must not invoke");
        },
      },
      ["app.category"],
    ),
  ).toEqual({});
});
