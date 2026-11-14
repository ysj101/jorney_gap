import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("prepares actual archives, verifies them, and refuses modified artifacts or a mismatched source revision", () => {
  const directory = mkdtempSync(join(tmpdir(), "journeygap-release-test-"));
  const command = (args: string[]) =>
    execFileSync(process.execPath, args, { stdio: "pipe", timeout: 60000 });
  try {
    command(["scripts/licenses.mjs"]);
    command(["scripts/pack.mjs"]);
    cpSync("artifacts/release", directory, { recursive: true });
    expect(() =>
      command(["scripts/pack.mjs", "--verify", directory]),
    ).not.toThrow();
    const version = JSON.parse(
      readFileSync("packages/web/package.json", "utf8"),
    ).version;
    const path = join(directory, `journeygap-web-${version}.tgz`);
    const original = readFileSync(path);
    writeFileSync(
      path,
      Buffer.concat([original, Buffer.from("synthetic-corruption")]),
    );
    expect(() =>
      command(["scripts/pack.mjs", "--verify", directory]),
    ).toThrow();
    writeFileSync(path, original);
    const manifestPath = join(directory, "release.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.commit = "0".repeat(40);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      command(["scripts/pack.mjs", "--verify", directory]),
    ).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
