import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const targets = {
  linux_x64: {
    asset: "linux_amd64",
    sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  },
  darwin_arm64: {
    asset: "darwin_arm64",
    sha256: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  },
};
const target = targets[`${process.platform}_${process.arch}`];
if (!target)
  throw new Error("Add a reviewed actionlint platform/checksum before use");
const directory = mkdtempSync(join(tmpdir(), "journeygap-workflow-check-"));
try {
  const response = await fetch(
    `https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_${target.asset}.tar.gz`,
    { signal: AbortSignal.timeout(60000) },
  );
  if (!response.ok) throw new Error("Pinned workflow linter download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length > 32 * 1048576 ||
    createHash("sha256").update(bytes).digest("hex") !== target.sha256
  )
    throw new Error("Workflow linter checksum mismatch");
  const archive = join(directory, "actionlint.tar.gz");
  writeFileSync(archive, bytes);
  execFileSync("tar", ["-xzf", archive, "-C", directory, "actionlint"], {
    stdio: "pipe",
  });
  execFileSync(join(directory, "actionlint"), ["-shellcheck=", "-pyflakes="], {
    stdio: "inherit",
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
