# Analysis contract

`analyze(events, definition, nowMs, options?)` in `@journeygap/core` returns aggregate counts and evidence, never per-session histories. Pass validated step events from **one service**; Relay/CLI must filter service and journey inputs before calling it. Multiple journeys can be present; the function selects the definition's journey. Events are deduplicated by eventId, sorted by client timestamp, with equal timestamps retaining the input receipt order. Invalid events and clock skew greater than 24 hours relative to receivedAtMs are excluded and counted. A missing receipt timestamp cannot support a clock-skew check; import sets it on receipt.

Each session/instance begins only with the first defined step. Later steps advance only in order. Earlier-step repeats do not reset progress. An event that skips a step is counted as out_of_order, never replayed later as an implicit success. Starting a new instance in the same session closes an active prior attempt as superseded; completed and timed-out attempts remain closed. Different tabs and journeys do not supersede each other. Timeout is measured from the attempt's observed start, not from the latest step; events at or after that deadline do not complete the old attempt.

Default cohort window: the seven days ending at nowMs. Set fromMs/toMs to select starts (both bounds inclusive). Completion and progress are included through `min(nowMs, toMs + graceMs)`; grace defaults to zero and is limited to 24 hours. Starts outside the cohort never increase the denominator. The same cutoff determines whether an incomplete attempt has timed out; reports describe observations available through that cutoff. This avoids using later events to change a historical report unexpectedly. The caller must load start and follow-up events, including the grace period, rather than prefiltering all rows to the start window.

`stepCounts` contains reached counts, fraction of starts (0–1), fraction of the preceding step, medians from start and medians from the preceding step. Ratios and medians with no denominator or samples are null (`n/a` in text reports). Even-sized medians average the middle two observed values. Counts do not imply causality.

Findings:

- large_drop requires at least 20 starts, at least 20 observations of the preceding step, and conversion below dropThreshold (default 0.6).
- slow_step requires at least 20 observations of the current step and median time from the preceding step exceeding slowStepThresholdMs (default 60000).
- insufficient_data covers low samples, pending attempts, and excluded events; out_of_order is reported separately. Evidence includes observation bounds, exclusions, sample counts, ratios, medians and thresholds as applicable.

Confidence is at most medium, reduced to low for pending attempts, excluded events, or order anomalies. Sample status is insufficient below 20 starts even though raw counts remain visible. `incompleteAfterTimeout` and `statusCounts.not_observed_after_timeout` mean only that completion was not observed before the deadline. `pendingAttempts` and `statusCounts.insufficient_evidence` count attempts not yet closed at the cutoff. Superseded attempts are counted separately. Missing observations can result from consent withdrawal, network failures, sampling, or browser closure; they do not prove abandonment, confusion or any psychological state.

The synthetic fixture in `tests/fixtures/journeys.ts` contains 40 independent attempts (40 starts, 30 reviews, 10 completions) with deterministic timestamps and UUIDs. It exercises rates, timing, both candidate findings, and incomplete attempts without external services.
