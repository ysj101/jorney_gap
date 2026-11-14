import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const names = ["core", "web", "relay", "cli"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const version = JSON.parse(
  readFileSync("packages/core/package.json", "utf8"),
).version;
assert(
  /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version),
  "Invalid package version",
);
const directory = resolve(process.argv[3] ?? "artifacts/release");
if (process.argv[2] !== "--verify") {
  assert.equal(
    process.argv.length,
    2,
    "Only --verify [directory] is supported",
  );
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const packages = [];
  for (const name of names) {
    const pkg = JSON.parse(
      readFileSync(`packages/${name}/package.json`, "utf8"),
    );
    assert.equal(pkg.version, version, "Package versions must match");
    execFileSync(
      "pnpm",
      [
        "--filter",
        `@journeygap/${name}`,
        "pack",
        "--pack-destination",
        directory,
      ],
      { stdio: "pipe" },
    );
    const file = `journeygap-${name}-${version}.tgz`;
    packages.push({
      name: pkg.name,
      file,
      sha256: digest(readFileSync(join(directory, file))),
    });
  }
  cpSync(
    "artifacts/dependency-licenses.json",
    join(directory, "dependency-licenses.json"),
  );
  writeFileSync(
    join(directory, "release.json"),
    `${JSON.stringify({ schemaVersion: 1, commit, version, packages }, null, 2)}\n`,
  );
  writeFileSync(
    join(directory, "SHA256SUMS"),
    readdirSync(directory)
      .sort()
      .map(
        (file) => `${digest(readFileSync(join(directory, file)))}  ${file}\n`,
      )
      .join(""),
  );
}
const manifest = JSON.parse(
  readFileSync(join(directory, "release.json"), "utf8"),
);
assert.equal(manifest.schemaVersion, 1);
assert.equal(
  manifest.commit,
  commit,
  "Artifact commit differs from checked-out source",
);
assert.equal(manifest.version, version);
assert.equal(manifest.packages.length, 4);
const expected = [
  "release.json",
  "dependency-licenses.json",
  "SHA256SUMS",
  ...names.map((name) => `journeygap-${name}-${version}.tgz`),
];
assert.deepEqual(
  readdirSync(directory).sort(),
  expected.sort(),
  "Unexpected artifact contents",
);
for (const [index, name] of names.entries()) {
  const pkg = manifest.packages[index];
  assert.equal(pkg.name, `@journeygap/${name}`);
  assert.equal(pkg.file, `journeygap-${name}-${version}.tgz`);
  assert.equal(
    digest(readFileSync(join(directory, pkg.file))),
    pkg.sha256,
    "Package checksum mismatch",
  );
  const metadata = JSON.parse(
    execFileSync(
      "tar",
      ["-xOf", join(directory, pkg.file), "package/package.json"],
      { encoding: "utf8" },
    ),
  );
  assert.equal(metadata.name, pkg.name);
  assert.equal(metadata.version, version);
}
const sums = readFileSync(join(directory, "SHA256SUMS"), "utf8")
  .trim()
  .split("\n");
assert.equal(sums.length, 6);
const seen = new Set();
for (const line of sums) {
  const match = /^([a-f0-9]{64}) {2}([a-zA-Z0-9._-]+)$/.exec(line);
  assert(
    match &&
      expected.includes(match[2]) &&
      match[2] !== "SHA256SUMS" &&
      !seen.has(match[2]),
    "Invalid checksum manifest",
  );
  seen.add(match[2]);
  assert.equal(digest(readFileSync(join(directory, match[2]))), match[1]);
}
console.log(
  `Verified four release archives for ${version} at ${commit.slice(0, 12)}. No package was published.`,
);
