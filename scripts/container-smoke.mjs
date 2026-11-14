import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { otlpFixture } from "../tests/fixtures/otlp.ts";

const project = process.argv[2] ?? "journeygap-ci";
const directory = mkdtempSync(join(tmpdir(), "journeygap-collector-"));
try {
  const response = await fetch("http://127.0.0.1:4318/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(otlpFixture()),
  });
  assert.equal(response.status, 200);
  let matched = false;
  for (let n = 0; n < 20 && !matched; n++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const path = join(directory, "traces.jsonl");
    try {
      execFileSync(
        "docker",
        [
          "compose",
          "-p",
          project,
          "cp",
          "collector:/data/journeygap-traces.jsonl",
          path,
        ],
        { stdio: "pipe" },
      );
      const envelopes = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const spans = envelopes
        .flatMap((envelope) => envelope.resourceSpans ?? [])
        .flatMap((resource) => resource.scopeSpans ?? [])
        .flatMap((scope) => scope.spans ?? []);
      matched = spans.some(
        (span) =>
          span.name === "journeygap.step" &&
          span.attributes?.some(
            (attr) =>
              attr.key === "journeygap.event_id" &&
              attr.value.stringValue === "00000000-0000-4000-8000-000000000001",
          ),
      );
    } catch {
      /* Collector batch/file creation is asynchronous. */
    }
  }
  assert(
    matched,
    "Collector did not persist the forwarded synthetic JourneyGap span",
  );
  console.log("Container OTLP forwarding verified");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
