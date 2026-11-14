import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const allowed = new Set([
  "MIT",
  "MIT OR Apache-2.0",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "MPL-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
]);
const licenses = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    maxBuffer: 8 * 1048576,
  }),
);
let count = 0;
for (const [license, packages] of Object.entries(licenses)) {
  assert(allowed.has(license), `Unreviewed dependency license: ${license}`);
  for (const pkg of packages) {
    assert(pkg.name && pkg.versions?.length, "Missing dependency identity");
    count++;
  }
}
const directory = mkdtempSync(join(tmpdir(), "journeygap-license-pack-"));
try {
  for (const name of ["core", "web", "relay", "cli"]) {
    const pkgPath = resolve(`packages/${name}`);
    const pkg = JSON.parse(readFileSync(join(pkgPath, "package.json"), "utf8"));
    assert.equal(pkg.license, "Apache-2.0");
    assert.equal(
      readFileSync(join(pkgPath, "LICENSE"), "utf8"),
      readFileSync("LICENSE", "utf8"),
    );
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
    const archive = join(directory, `journeygap-${name}-${pkg.version}.tgz`);
    const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert(
      names.includes("package/LICENSE") &&
        names.includes("package/README.md") &&
        names.includes("package/dist/index.js"),
      "Package must contain license, documentation and built exports",
    );
    assert(
      names.every((path) =>
        /^package\/(?:dist\/|schema\/|LICENSE$|README\.md$|package\.json$)/.test(
          path,
        ),
      ),
      "Unexpected package content; inspect before publication",
    );
    const metadata = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    assert(
      !JSON.stringify(metadata.dependencies ?? {}).includes("workspace:"),
      "Unresolved workspace dependency",
    );
  }
  mkdirSync("artifacts", { recursive: true });
  const inventory = Object.fromEntries(
    Object.entries(licenses).map(([license, packages]) => [
      license,
      packages.map(({ name, versions, license, homepage }) => ({
        name,
        versions,
        license,
        homepage,
      })),
    ]),
  );
  writeFileSync(
    "artifacts/dependency-licenses.json",
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  console.log(
    `Reviewed ${count} installed dependency entries and all four public package archives`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
