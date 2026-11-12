import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("validates configuration and runs analysis without runtime code generation", () => {
  const code = `
    import { validateConfig, validateRelayConfig, analyze } from './packages/core/dist/index.js';
    const journey = { id: 'test', steps: [{ id: 'started' }, { id: 'completed', terminal: true }], timeoutMinutes: 30 };
    const config = { schemaVersion: 1, enabled: true, serviceName: 'test', otlpTracesEndpoint: 'https://example.org/v1/traces', consent: { mode: 'opt-in', ui: 'external' }, journeys: [journey] };
    if (!validateConfig(config).valid) throw Error('valid configuration rejected');
    if (validateConfig({ ...config, otlpTracesEndpoint: 'javascript:alert(1)' }).valid) throw Error('invalid endpoint accepted');
    if (!validateRelayConfig({ schemaVersion: 1, allowedOrigins: ['https://example.org'], services: [{ serviceName: 'test', journeys: [journey] }], retentionDays: 14, rateLimitPerMinute: 60 }).valid) throw Error('relay rejected');
    if (analyze([], journey, Date.now()).observedStarts !== 0) throw Error('analysis failed');
  `;
  expect(
    execFileSync(
      process.execPath,
      [
        "--disallow-code-generation-from-strings",
        "--input-type=module",
        "-e",
        code,
      ],
      { encoding: "utf8" },
    ),
  ).toBe("");
});
