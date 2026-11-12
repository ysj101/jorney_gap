import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("published package boundaries", () => {
  for (const name of ["core", "web", "relay", "cli"]) {
    it(`${name} exposes an importable ESM build with declarations`, async () => {
      const manifest = JSON.parse(
        readFileSync(`packages/${name}/package.json`, "utf8"),
      );
      expect(manifest.name).toBe(`@journeygap/${name}`);
      expect(manifest.exports["."].types).toBe("./dist/index.d.ts");
      const result = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", `await import('@journeygap/${name}')`],
        { cwd: `packages/${name}`, encoding: "utf8" },
      );
      expect(result).toBe("");
      expect(
        readFileSync(`packages/${name}/dist/index.d.ts`, "utf8"),
      ).toContain("export");
    });
  }
});
