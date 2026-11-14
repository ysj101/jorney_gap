import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "8.30.1";
const binaries = {
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  darwin_arm64:
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
};
const target = `${process.platform}_${process.arch}`;
const checksum = binaries[target];
if (!checksum)
  throw new Error(
    "Secret scan binary is pinned for Linux x64 and macOS arm64; add a reviewed platform/checksum before use",
  );
const directory = mkdtempSync(join(tmpdir(), "journeygap-secret-scan-"));
try {
  const name = `gitleaks_${version}_${target}.tar.gz`;
  const response = await fetch(
    `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${name}`,
    { signal: AbortSignal.timeout(60000) },
  );
  if (!response.ok) throw new Error("Pinned secret scanner download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length > 32 * 1048576 ||
    createHash("sha256").update(bytes).digest("hex") !== checksum
  )
    throw new Error("Secret scanner checksum mismatch");
  const archive = join(directory, name);
  writeFileSync(archive, bytes);
  execFileSync("tar", ["-xzf", archive, "-C", directory, "gitleaks"], {
    stdio: "pipe",
  });
  // A generated, never-live probe must be detected before trusting this scan.
  // Its value is kept in process memory and never logged or committed.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const probe = `AK${"IA"}${[...randomBytes(16)].map((value) => alphabet[value % 32]).join("")}`;
  let detected = false;
  try {
    execFileSync(
      join(directory, "gitleaks"),
      ["stdin", "--redact", "--no-banner", "--exit-code", "1"],
      { input: `aws_access_key_id = "${probe}"\n`, stdio: "pipe" },
    );
  } catch (error) {
    detected = error.status === 1;
  }
  if (!detected) throw new Error("Secret scanner positive-control failed");
  const report = join(directory, "report.json");
  try {
    execFileSync(
      join(directory, "gitleaks"),
      [
        "git",
        "--redact",
        "--no-banner",
        "--log-opts=--all",
        "--exit-code",
        "1",
        "--report-format",
        "json",
        "--report-path",
        report,
      ],
      { stdio: "inherit" },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
    for (const finding of JSON.parse(readFileSync(report, "utf8")))
      console.error(
        JSON.stringify({
          rule: finding.RuleID,
          file: finding.File,
          line: finding.StartLine,
        }),
      );
    process.exitCode = 1;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
