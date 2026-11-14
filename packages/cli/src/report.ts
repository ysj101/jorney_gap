import {
  analyze,
  type JourneyReport,
  type RelayConfig,
} from "@journeygap/core";
import { EventStore } from "@journeygap/relay";
import { CliError } from "./config.js";

function instant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    throw new CliError("Window timestamps must be ISO UTC dates");
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !==
      (value.includes(".") ? value : value.replace("Z", ".000Z"))
  )
    throw new CliError("Invalid report timestamp");
  return time;
}
export function report(
  database: string,
  config: RelayConfig,
  options: {
    journey: string;
    service?: string;
    days?: string;
    from?: string;
    to?: string;
    graceMinutes?: string;
  },
  now = Date.now(),
): JourneyReport {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(options.journey))
    throw new CliError("Invalid journey ID");
  const service = options.service
    ? config.services.find((item) => item.serviceName === options.service)
    : config.services.length === 1
      ? config.services[0]
      : undefined;
  if (!service)
    throw new CliError(
      "Select a configured --service; reports never combine services",
    );
  const definition = service.journeys.find(
    (item) => item.id === options.journey,
  );
  if (!definition) throw new CliError("Unknown configured journey");
  const days = options.days ?? "7";
  const grace = options.graceMinutes ?? "0";
  if (
    !/^[1-9]\d{0,2}$/.test(days) ||
    Number(days) > 365 ||
    !/^\d{1,4}$/.test(grace) ||
    Number(grace) > 1440 ||
    (options.days !== undefined && options.from !== undefined)
  )
    throw new CliError(
      "Invalid days/grace window; --from and --days are mutually exclusive",
    );
  const toMs = instant(options.to) ?? now;
  const fromMs = instant(options.from) ?? toMs - Number(days) * 86400000;
  if (fromMs > toMs || toMs > now) throw new CliError("Invalid report window");
  const store = new EventStore(database, { readOnly: true });
  try {
    const events = store.list(
      service.serviceName,
      definition.id,
      0,
      Math.min(now, toMs + Number(grace) * 60000),
    );
    const result = analyze(events, definition, now, {
      fromMs,
      toMs,
      graceMs: Number(grace) * 60000,
    });
    if (toMs - fromMs > config.retentionDays * 86400000)
      result.warnings.push(
        "指定期間が保存期間を超えています。期限切れの観測は含まれません。",
      );
    return result;
  } finally {
    store.close();
  }
}

export function formatReport(report: JourneyReport): string {
  const fraction = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const timing = (value: number | null) =>
    value === null ? "n/a" : `${value} ms`;
  const rows = [
    `Journey: ${report.journeyId}  Samples: ${report.observedStarts} (${report.sampleStatus})`,
    `Window: ${new Date(report.window.fromMs).toISOString()} — ${new Date(report.window.toMs).toISOString()}`,
    ...report.stepCounts.map(
      (step) =>
        `${step.stepId}: ${step.reached}/${report.observedStarts} (${fraction(step.rate)}); previous ${fraction(step.conversionFromPrevious)}; median from start ${timing(step.medianMsFromStart)}; from previous ${timing(step.medianMsFromPrevious)}`,
    ),
    `not_observed_after_timeout: ${report.incompleteAfterTimeout}; superseded: ${report.supersededAttempts}; insufficient_evidence: ${report.pendingAttempts}; out_of_order: ${report.outOfOrderEvents}`,
    ...report.findings.flatMap((finding) => [
      `Finding: ${finding.kind} (${finding.confidence}) ${finding.stepId ?? ""}`,
      `Evidence: ${JSON.stringify(finding.evidence)}`,
      finding.interpretation,
    ]),
    ...report.warnings.map((warning) => `Note: ${warning}`),
  ];
  return rows.join("\n");
}
