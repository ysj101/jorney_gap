import { expect, it } from "vitest";
import { analyze } from "../packages/core/src/index.js";
import { BASE, cohortFixture, event, journey } from "./fixtures/journeys.js";

const NOW = BASE + 3600000;

it("computes observed funnel counts, rates, timing and evidence over 40 synthetic attempts", () => {
  const report = analyze(cohortFixture, journey, NOW);
  expect(report.observedStarts).toBe(40);
  expect(report.observedCompletions).toBe(10);
  expect(report.stepCounts.map((step) => step.reached)).toEqual([40, 30, 10]);
  expect(report.stepCounts.map((step) => step.rate)).toEqual([1, 0.75, 0.25]);
  expect(report.stepCounts.map((step) => step.medianMsFromStart)).toEqual([
    0, 70000, 90000,
  ]);
  expect(report.stepCounts[2]?.conversionFromPrevious).toBeCloseTo(1 / 3);
  expect(report.incompleteAfterTimeout).toBe(30);
  expect(report.sampleStatus).toBe("sufficient");
  expect(report.supersededAttempts).toBe(0);
  expect(
    report.findings.find((item) => item.kind === "large_drop"),
  ).toMatchObject({
    stepId: "completed",
    confidence: "medium",
    evidence: { numerator: 10, denominator: 30, excludedEvents: 0 },
  });
  expect(
    report.findings.find((item) => item.kind === "slow_step"),
  ).toMatchObject({
    stepId: "reviewed",
    evidence: { samples: 30, medianMs: 70000 },
  });
  expect(report.statusCounts.not_observed_after_timeout).toBe(30);
  // Reports contain aggregates, not session/attempt histories.
  expect(JSON.stringify(report)).not.toContain(cohortFixture[0]?.sessionId);
});

it("deduplicates event IDs and step repeats without inflating progress", () => {
  const input = [
    event(1, "started", BASE),
    event(2, "reviewed", BASE + 1),
    event(3, "reviewed", BASE + 2),
    event(4, "started", BASE + 3),
    event(5, "completed", BASE + 4),
  ];
  const report = analyze([...input, ...input], journey, NOW);
  expect(report.duplicateEvents).toBe(5);
  expect(report.observedStarts).toBe(1);
  expect(report.observedCompletions).toBe(1);
  expect(report.stepCounts.map((step) => step.reached)).toEqual([1, 1, 1]);
});

it("sorts by timestamp and preserves receipt order for equal times", () => {
  expect(
    analyze(
      [
        event(3, "completed", BASE + 2),
        event(1, "started", BASE),
        event(2, "reviewed", BASE + 1),
      ],
      journey,
      NOW,
    ).observedCompletions,
  ).toBe(1);
  const report = analyze(
    [
      event(1, "started", BASE),
      event(2, "completed", BASE),
      event(3, "reviewed", BASE),
    ],
    journey,
    NOW,
  );
  expect(report.observedCompletions).toBe(0);
  expect(report.outOfOrderEvents).toBe(1);
  expect(report.stepCounts.map((step) => step.reached)).toEqual([1, 1, 0]);
});

it("never treats a skipped step as reached, even if it arrives later", () => {
  const report = analyze(
    [
      event(1, "started", BASE),
      event(2, "completed", BASE + 1),
      event(3, "reviewed", BASE + 2),
    ],
    journey,
    NOW,
  );
  expect(report.observedCompletions).toBe(0);
  expect(report.outOfOrderEvents).toBe(1);
  expect(
    report.findings.find((finding) => finding.kind === "out_of_order")
      ?.confidence,
  ).toBe("low");
});

it("closes a previous attempt as superseded when a new instance starts in the same tab", () => {
  const report = analyze(
    [
      event(1, "started", BASE),
      event(2, "started", BASE + 1, 2, 1),
      event(3, "reviewed", BASE + 2, 1),
      event(4, "reviewed", BASE + 3, 2, 1),
      event(5, "completed", BASE + 4, 2, 1),
    ],
    journey,
    NOW,
  );
  expect(report.observedStarts).toBe(2);
  expect(report.supersededAttempts).toBe(1);
  expect(report.incompleteAfterTimeout).toBe(0);
  expect(report.observedCompletions).toBe(1);
});

it("isolates concurrent sessions and journeys, allowing repeated instance IDs in other sessions", () => {
  const otherJourney = { ...journey, id: "second-task" };
  const events = [
    event(1, "started", BASE, 1, 1),
    event(2, "started", BASE, 1, 2),
    { ...event(3, "started", BASE, 1, 1), journeyId: "second-task" },
    event(4, "reviewed", BASE + 1, 1, 1),
    event(5, "completed", BASE + 2, 1, 1),
  ];
  const first = analyze(events, journey, NOW);
  expect(first.observedStarts).toBe(2);
  expect(first.supersededAttempts).toBe(0);
  expect(first.observedCompletions).toBe(1);
  expect(analyze(events, otherJourney, NOW).observedStarts).toBe(1);
});

it("distinguishes pending evidence from timeout and rejects events after an attempt timeout", () => {
  const events = [event(1, "started", BASE)];
  const pending = analyze(events, journey, BASE + 1);
  expect(pending.statusCounts).toEqual({
    not_observed_after_timeout: 0,
    insufficient_evidence: 1,
  });
  expect(
    pending.findings.every((finding) => finding.confidence === "low"),
  ).toBe(true);
  const timedOut = analyze(
    [...events, event(2, "reviewed", NOW), event(3, "completed", NOW + 1)],
    journey,
    NOW + 2,
  );
  expect(timedOut.statusCounts.not_observed_after_timeout).toBe(1);
  expect(timedOut.observedCompletions).toBe(0);
  expect(timedOut.stepCounts[1]?.reached).toBe(0);
});

it("uses start cohorts and configurable grace without counting earlier or later starts", () => {
  const events = [
    event(1, "started", BASE - 1, 1),
    event(2, "started", BASE, 2),
    event(3, "reviewed", BASE + 1, 2),
    event(4, "completed", BASE + 3, 2),
    event(5, "started", BASE + 3, 3),
  ];
  const options = { fromMs: BASE, toMs: BASE + 2 };
  expect(analyze(events, journey, NOW, options).observedCompletions).toBe(0);
  const report = analyze(events, journey, NOW, { ...options, graceMs: 2 });
  expect(report.observedStarts).toBe(1);
  expect(report.observedCompletions).toBe(1);
});

it("excludes over-24h clock skew and invalid events and warns without leaking records", () => {
  const report = analyze(
    [
      event(1, "started", BASE),
      { ...event(2, "reviewed", BASE + 1), receivedAtMs: BASE + 86400002 },
      { ...event(3, "completed", BASE + 2), eventId: "invalid" },
    ],
    journey,
    NOW,
  );
  expect(report.excludedEvents).toBe(2);
  expect(report.warnings.some((warning) => warning.includes("24"))).toBe(true);
  expect(report.observedCompletions).toBe(0);
});

it("computes medians for even counts and applies configurable finding thresholds", () => {
  const events = [
    event(1, "started", BASE, 1),
    event(2, "reviewed", BASE + 2, 1),
    event(3, "started", BASE, 2),
    event(4, "reviewed", BASE + 4, 2),
  ];
  expect(analyze(events, journey, NOW).stepCounts[1]?.medianMsFromStart).toBe(
    3,
  );
  expect(
    analyze(cohortFixture, journey, NOW, {
      dropThreshold: 0.2,
      slowStepThresholdMs: 100000,
    }).findings,
  ).toEqual([]);
});

it("reports raw counts at low samples and null ratios when no starts were observed", () => {
  const empty = analyze([], journey, NOW);
  expect(
    empty.stepCounts.every(
      (step) =>
        step.rate === null &&
        step.conversionFromPrevious === null &&
        step.medianMsFromStart === null,
    ),
  ).toBe(true);
  expect(empty.sampleStatus).toBe("insufficient");
  const low = analyze(
    cohortFixture.filter(
      (item) => item.sessionId === cohortFixture[0]?.sessionId,
    ),
    journey,
    NOW,
  );
  expect(low.observedStarts).toBe(1);
  expect(low.observedCompletions).toBe(1);
  expect(low.findings.map((item) => item.kind)).toEqual(["insufficient_data"]);
});

it("does not supersede a completed or already timed-out attempt on restart", () => {
  const completed = [
    event(1, "started", BASE),
    event(2, "reviewed", BASE + 1),
    event(3, "completed", BASE + 2),
    event(4, "started", BASE + 3, 2, 1),
  ];
  expect(analyze(completed, journey, NOW).supersededAttempts).toBe(0);
  const expired = analyze(
    [event(1, "started", BASE), event(2, "started", BASE + 1800000, 2, 1)],
    journey,
    NOW,
  );
  expect(expired.supersededAttempts).toBe(0);
  expect(expired.incompleteAfterTimeout).toBe(2);
});

it("requires 20 observations before offering drop or slow candidates", () => {
  const small = cohortFixture.filter(
    (item) => Number.parseInt(item.sessionId.slice(-12), 16) <= 19,
  );
  const report = analyze(small, journey, NOW);
  expect(report.sampleStatus).toBe("insufficient");
  expect(
    report.findings.some(
      (finding) =>
        finding.kind === "large_drop" || finding.kind === "slow_step",
    ),
  ).toBe(false);
  const twenty = cohortFixture.filter(
    (item) => Number.parseInt(item.sessionId.slice(-12), 16) <= 20,
  );
  expect(analyze(twenty, journey, NOW).sampleStatus).toBe("sufficient");
});

it("validates analysis options and journey definitions", () => {
  for (const options of [
    { fromMs: NOW + 1 },
    { toMs: NOW + 1 },
    { graceMs: -1 },
    { dropThreshold: 2 },
    { slowStepThresholdMs: Number.NaN },
  ])
    expect(() => analyze([], journey, NOW, options)).toThrow(
      "Invalid analysis options",
    );
  expect(() =>
    analyze([], { ...journey, steps: [{ id: "only", terminal: true }] }, NOW),
  ).toThrow("Invalid journey definition");
});
