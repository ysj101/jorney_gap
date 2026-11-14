import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  analyze,
  type JourneyReport,
  type RelayConfig,
} from "@journeygap/core";
import type { EventStore } from "./storage.js";

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function createAdmin(options: {
  token: string;
  config: RelayConfig;
  store: EventStore;
  now: () => number;
}) {
  if (!/^[\x21-\x7e]{32,256}$/.test(options.token))
    throw new Error(
      "A server-only admin token of 32–256 printable characters is required",
    );
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${options.token}`);
  return (req: IncomingMessage): JourneyReport => {
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expected))
      throw new AdminError(401, "Authentication required");
    if (req.method !== "GET") throw new AdminError(405, "Method not allowed");
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    const keys = [...url.searchParams.keys()];
    if (
      keys.some((key) => !["service", "journey", "days"].includes(key)) ||
      new Set(keys).size !== keys.length
    )
      throw new AdminError(400, "Invalid report parameters");
    const journeyId = url.searchParams.get("journey");
    const serviceName =
      url.searchParams.get("service") ??
      (options.config.services.length === 1
        ? options.config.services[0]?.serviceName
        : undefined);
    if (
      !journeyId ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(journeyId) ||
      !serviceName ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(serviceName)
    )
      throw new AdminError(
        400,
        "A configured service and journey are required",
      );
    const service = options.config.services.find(
      (item) => item.serviceName === serviceName,
    );
    const definition = service?.journeys.find((item) => item.id === journeyId);
    if (!definition) throw new AdminError(404, "Journey not found");
    const daysText = url.searchParams.get("days") ?? "7";
    if (!/^[1-9]\d{0,2}$/.test(daysText) || Number(daysText) > 365)
      throw new AdminError(400, "Invalid report window");
    const now = options.now();
    const events = options.store.list(serviceName, journeyId, 0, now);
    const report = analyze(events, definition, now, {
      fromMs: now - Number(daysText) * 86400000,
      toMs: now,
    });
    if (Number(daysText) > options.config.retentionDays)
      report.warnings.push(
        "指定期間が保存期間を超えています。期限切れの観測は含まれません。",
      );
    return report;
  };
}
