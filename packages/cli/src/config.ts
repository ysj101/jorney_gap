import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  type RelayConfig,
  validateConfig,
  validateRelayConfig,
} from "@journeygap/core";
import { EventStore } from "@journeygap/relay";

export class CliError extends Error {}
export function localPath(cwd: string, value: string): string {
  if (!value || value.length > 4096 || value.includes("\0"))
    throw new CliError("Invalid local file path");
  return resolve(cwd, value);
}
export function readConfiguration(path: string): RelayConfig {
  if (!statSync(path).isFile() || statSync(path).size > 262144)
    throw new CliError("Configuration must be a JSON file of at most 256 KiB");
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError("Invalid configuration JSON");
  }
  const relay = validateRelayConfig(input);
  if (relay.valid) return relay.value;
  const web = validateConfig(input);
  if (!web.valid)
    throw new CliError("Configuration must match the Web or Relay schema");
  return {
    schemaVersion: 1,
    allowedOrigins: ["https://offline.invalid"],
    services: [
      {
        serviceName: web.value.serviceName,
        journeys: web.value.journeys,
        ...(web.value.attributesAllowlist
          ? { attributesAllowlist: web.value.attributesAllowlist }
          : {}),
      },
    ],
    retentionDays: 14,
    rateLimitPerMinute: 60,
  };
}
export function loadConfiguration(
  cwd: string,
  explicit: string | undefined,
  database: string,
): RelayConfig {
  if (explicit !== undefined)
    return readConfiguration(localPath(cwd, explicit));
  if (existsSync(database)) {
    try {
      const store = new EventStore(database, { readOnly: true });
      try {
        const config = store.getConfig();
        if (config) return config;
      } finally {
        store.close();
      }
    } catch {
      /* A project configuration can supply definitions for v1 migration. */
    }
  }
  for (const name of ["journeygap.relay.json", "journeygap.config.json"]) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return readConfiguration(path);
  }
  throw new CliError(
    "Journey definitions are required: use --config, a project configuration, or a Relay database with saved definitions",
  );
}
