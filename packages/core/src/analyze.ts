import { validateJourney } from "./generated/validators.cjs";
import type { JourneyDefinition, JourneyEvent } from "./types.js";

export type Finding = {
  kind: "large_drop" | "slow_step" | "out_of_order" | "insufficient_data";
  stepId?: string;
  evidence: Record<string, number | string>;
  interpretation: string;
  confidence: "low" | "medium";
};
export type JourneyReport = {
  journeyId: string;
  window: { fromMs: number; toMs: number };
  observedStarts: number;
  observedCompletions: number;
  stepCounts: Array<{
    stepId: string;
    reached: number;
    medianMsFromStart: number | null;
    rate: number | null;
    conversionFromPrevious: number | null;
    medianMsFromPrevious: number | null;
  }>;
  incompleteAfterTimeout: number;
  supersededAttempts: number;
  outOfOrderEvents: number;
  sampleStatus: "sufficient" | "insufficient";
  findings: Finding[];
  pendingAttempts: number;
  excludedEvents: number;
  duplicateEvents: number;
  statusCounts: {
    not_observed_after_timeout: number;
    insufficient_evidence: number;
  };
  warnings: string[];
};
export type AnalyzeOptions = {
  fromMs?: number;
  toMs?: number;
  graceMs?: number;
  dropThreshold?: number;
  slowStepThresholdMs?: number;
};

type Attempt = {
  sessionId: string;
  start: number;
  times: number[];
  cohort: boolean;
  state: "active" | "complete" | "superseded" | "timeout";
};
const DAY = 86400000;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validateDefinition = validateJourney as (
  value: unknown,
) => value is JourneyDefinition;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const right = sorted[middle];
  if (right === undefined) return null;
  return sorted.length % 2
    ? right
    : ((sorted[middle - 1] ?? right) + right) / 2;
}

/** Caller must scope events to one service. Input order breaks equal-time ties. */
export function analyze(
  events: JourneyEvent[],
  definition: JourneyDefinition,
  nowMs: number,
  options: AnalyzeOptions = {},
): JourneyReport {
  if (
    !validateDefinition(definition) ||
    definition.steps.at(-1)?.terminal !== true ||
    definition.steps.slice(0, -1).some((step) => step.terminal) ||
    new Set(definition.steps.map((step) => step.id)).size !==
      definition.steps.length
  )
    throw new Error("Invalid journey definition");
  const fromMs = options.fromMs ?? nowMs - 7 * DAY;
  const toMs = options.toMs ?? nowMs;
  const graceMs = options.graceMs ?? 0;
  const dropThreshold = options.dropThreshold ?? 0.6;
  const slowStepThresholdMs = options.slowStepThresholdMs ?? 60000;
  if (
    ![nowMs, fromMs, toMs, graceMs, slowStepThresholdMs].every(
      Number.isSafeInteger,
    ) ||
    nowMs < 0 ||
    fromMs > toMs ||
    toMs > nowMs ||
    graceMs < 0 ||
    graceMs > 1440 * 60000 ||
    slowStepThresholdMs < 0 ||
    !Number.isFinite(dropThreshold) ||
    dropThreshold < 0 ||
    dropThreshold > 1
  )
    throw new Error("Invalid analysis options");
  const observationEnd = Math.min(nowMs, toMs + graceMs);
  const timeoutMs = definition.timeoutMinutes * 60000;
  const index = new Map(definition.steps.map((step, n) => [step.id, n]));
  const seen = new Set<string>();
  let excludedEvents = 0;
  let duplicateEvents = 0;
  let clockSkewEvents = 0;
  let unknownReceiptEvents = 0;
  const selected: JourneyEvent[] = [];
  for (const event of events) {
    if (event.journeyId !== definition.id) continue;
    if (
      event.schemaVersion !== 1 ||
      !uuid.test(event.eventId) ||
      !uuid.test(event.sessionId) ||
      !uuid.test(event.instanceId) ||
      !index.has(event.stepId) ||
      !Number.isSafeInteger(event.timestampMs) ||
      event.timestampMs < 0 ||
      (event.receivedAtMs !== undefined &&
        (!Number.isSafeInteger(event.receivedAtMs) || event.receivedAtMs < 0))
    ) {
      excludedEvents++;
      continue;
    }
    if (
      event.receivedAtMs !== undefined &&
      Math.abs(event.receivedAtMs - event.timestampMs) > DAY
    ) {
      clockSkewEvents++;
      excludedEvents++;
      continue;
    }
    if (event.timestampMs > observationEnd) continue;
    const eventKey = event.eventId.toLowerCase();
    if (seen.has(eventKey)) {
      duplicateEvents++;
      continue;
    }
    seen.add(eventKey);
    if (event.receivedAtMs === undefined) unknownReceiptEvents++;
    selected.push(event);
  }
  selected.sort((a, b) => a.timestampMs - b.timestampMs);
  const attempts = new Map<string, Attempt>();
  const active = new Map<string, Attempt>();
  let outOfOrderEvents = 0;
  for (const event of selected) {
    const sessionId = event.sessionId.toLowerCase();
    const key = `${sessionId}/${event.instanceId.toLowerCase()}`;
    const position = index.get(event.stepId);
    if (position === undefined) continue;
    let attempt = attempts.get(key);
    if (!attempt) {
      if (position !== 0) {
        if (event.timestampMs >= fromMs) outOfOrderEvents++;
        continue;
      }
      const previous = active.get(sessionId);
      if (previous?.state === "active")
        previous.state =
          event.timestampMs - previous.start >= timeoutMs
            ? "timeout"
            : "superseded";
      attempt = {
        sessionId,
        start: event.timestampMs,
        times: [event.timestampMs],
        cohort: event.timestampMs >= fromMs && event.timestampMs <= toMs,
        state: "active",
      };
      attempts.set(key, attempt);
      active.set(sessionId, attempt);
      continue;
    }
    if (attempt.state !== "active") continue;
    if (event.timestampMs - attempt.start >= timeoutMs) {
      attempt.state = "timeout";
      continue;
    }
    if (position < attempt.times.length) continue;
    if (position !== attempt.times.length) {
      if (attempt.cohort) outOfOrderEvents++;
      continue;
    }
    attempt.times.push(event.timestampMs);
    if (attempt.times.length === definition.steps.length)
      attempt.state = "complete";
  }
  const cohort = [...attempts.values()].filter((attempt) => attempt.cohort);
  for (const attempt of cohort)
    if (
      attempt.state === "active" &&
      observationEnd - attempt.start >= timeoutMs
    )
      attempt.state = "timeout";
  const observedStarts = cohort.length;
  const pendingAttempts = cohort.filter(
    (attempt) => attempt.state === "active",
  ).length;
  const incompleteAfterTimeout = cohort.filter(
    (attempt) => attempt.state === "timeout",
  ).length;
  const stepCounts: JourneyReport["stepCounts"] = definition.steps.map(
    (step, position) => {
      const reachedAttempts = cohort.filter(
        (attempt) => attempt.times[position] !== undefined,
      );
      const previousReached = position
        ? cohort.filter((attempt) => attempt.times[position - 1] !== undefined)
            .length
        : observedStarts;
      return {
        stepId: step.id,
        reached: reachedAttempts.length,
        medianMsFromStart: median(
          reachedAttempts.map(
            (attempt) =>
              (attempt.times[position] ?? attempt.start) - attempt.start,
          ),
        ),
        rate: observedStarts ? reachedAttempts.length / observedStarts : null,
        conversionFromPrevious: previousReached
          ? reachedAttempts.length / previousReached
          : null,
        medianMsFromPrevious: position
          ? median(
              reachedAttempts.map(
                (attempt) =>
                  (attempt.times[position] ?? attempt.start) -
                  (attempt.times[position - 1] ?? attempt.start),
              ),
            )
          : null,
      };
    },
  );
  const evidence = {
    fromMs,
    toMs,
    graceMs,
    observationEndMs: observationEnd,
    excludedEvents,
    clockSkewEvents,
    unknownReceiptEvents,
    pendingAttempts,
  };
  const findings: Finding[] = [];
  const confidence =
    pendingAttempts ||
    excludedEvents ||
    outOfOrderEvents ||
    unknownReceiptEvents
      ? "low"
      : "medium";
  if (observedStarts < 20 || pendingAttempts || excludedEvents)
    findings.push({
      kind: "insufficient_data",
      evidence: { ...evidence, observedStarts, minimumSamples: 20 },
      interpretation:
        "観測数不足、未確定の試行、または除外イベントがあります。観測された件数のみを示し、原因は断定できません。",
      confidence: "low",
    });
  for (let n = 1; n < stepCounts.length; n++) {
    const step = stepCounts[n];
    const previous = stepCounts[n - 1];
    if (!step || !previous) continue;
    if (
      observedStarts >= 20 &&
      previous.reached >= 20 &&
      step.conversionFromPrevious !== null &&
      step.conversionFromPrevious < dropThreshold
    )
      findings.push({
        kind: "large_drop",
        stepId: step.stepId,
        evidence: {
          ...evidence,
          numerator: step.reached,
          denominator: previous.reached,
          rate: step.conversionFromPrevious,
          threshold: dropThreshold,
        },
        interpretation:
          "次のステップの観測到達率が閾値を下回りました。操作の発見しやすさ・エラー・中断などを確認する候補であり、原因の証明ではありません。",
        confidence,
      });
    if (
      step.reached >= 20 &&
      step.medianMsFromPrevious !== null &&
      step.medianMsFromPrevious > slowStepThresholdMs
    )
      findings.push({
        kind: "slow_step",
        stepId: step.stepId,
        evidence: {
          ...evidence,
          samples: step.reached,
          medianMs: step.medianMsFromPrevious,
          thresholdMs: slowStepThresholdMs,
        },
        interpretation:
          "前段からの観測時間の中央値が閾値を超えました。時間がかかった理由や利用者の感情は判断できません。",
        confidence,
      });
  }
  if (outOfOrderEvents)
    findings.push({
      kind: "out_of_order",
      evidence: { ...evidence, count: outOfOrderEvents },
      interpretation:
        "順序外のイベントを観測しました。欠損や接続順序を確認してください。到達扱いにはしていません。",
      confidence: "low",
    });
  const warnings = [
    "観測欠損はブラウザ閉鎖、通信断、同意撤回、サンプリング等と区別できません。送達保証はありません。",
  ];
  if (clockSkewEvents)
    warnings.push(
      "受信時刻とのずれが24時間を超えたイベントを集計から除外しました。",
    );
  if (unknownReceiptEvents)
    warnings.push(
      "元の受信時刻が不明な観測があり、時計ずれを検証できません。オフライン取込時刻は元の受信時刻ではありません。",
    );
  return {
    journeyId: definition.id,
    window: { fromMs, toMs },
    observedStarts,
    observedCompletions: cohort.filter(
      (attempt) => attempt.state === "complete",
    ).length,
    stepCounts,
    incompleteAfterTimeout,
    supersededAttempts: cohort.filter(
      (attempt) => attempt.state === "superseded",
    ).length,
    outOfOrderEvents,
    sampleStatus: observedStarts >= 20 ? "sufficient" : "insufficient",
    findings,
    pendingAttempts,
    excludedEvents,
    duplicateEvents,
    statusCounts: {
      not_observed_after_timeout: incompleteAfterTimeout,
      insufficient_evidence: pendingAttempts,
    },
    warnings,
  };
}
