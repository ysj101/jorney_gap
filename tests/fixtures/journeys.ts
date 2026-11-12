import type {
  JourneyDefinition,
  JourneyEvent,
} from "../../packages/core/src/index.js";

export const BASE = 1794517200000;
export const journey: JourneyDefinition = {
  id: "first-task",
  steps: [
    { id: "started" },
    { id: "reviewed" },
    { id: "completed", terminal: true },
  ],
  timeoutMinutes: 30,
};
export function syntheticId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
export function event(
  n: number,
  stepId: string,
  timestampMs: number,
  attempt = 1,
  session = attempt,
): JourneyEvent {
  return {
    schemaVersion: 1,
    eventId: syntheticId(n),
    sessionId: syntheticId(session),
    instanceId: syntheticId(attempt),
    journeyId: "first-task",
    stepId,
    timestampMs,
    receivedAtMs: timestampMs + 10,
  };
}

// 40 independent synthetic sessions: 40 starts, 30 reviews, 10 completions.
export const cohortFixture: JourneyEvent[] = Array.from(
  { length: 40 },
  (_, i) => [
    event(i * 3 + 1, "started", BASE + i, i + 1),
    ...(i < 30 ? [event(i * 3 + 2, "reviewed", BASE + i + 70000, i + 1)] : []),
    ...(i < 10 ? [event(i * 3 + 3, "completed", BASE + i + 90000, i + 1)] : []),
  ],
).flat();
