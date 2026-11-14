import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { initProject } from "../packages/cli/src/init.js";
import { readInstall } from "../packages/cli/src/project.js";
import { uninstallProject } from "../packages/cli/src/uninstall.js";
import { packageRegistry } from "./fixtures/registry.js";

it.each(["npm", "pnpm"] as const)(
  "installs actual packed packages with %s and builds an independent Vite app without tsconfig changes",
  async (manager) => {
    const root = mkdtempSync(join(tmpdir(), "journeygap-real-init-"));
    const registry = await packageRegistry(root);
    try {
      const app = join(root, "app");
      mkdirSync(join(app, "src"), { recursive: true });
      writeFileSync(
        join(app, "package.json"),
        JSON.stringify({
          name: "sample-web",
          version: "0.0.0",
          private: true,
          type: "module",
          packageManager: manager === "pnpm" ? "pnpm@10.30.2" : "npm@11.0.0",
          devDependencies: { vite: "8.3.8", typescript: "5.9.3" },
        }),
      );
      writeFileSync(
        join(app, ".npmrc"),
        `@journeygap:registry=${registry.origin}\n`,
      );
      writeFileSync(
        join(app, "index.html"),
        '<html><head><title>Independent app</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>',
      );
      writeFileSync(
        join(app, "src/main.ts"),
        'document.querySelector("#app")!.textContent = "Host app still works";\n',
      );
      const config = JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2023", "DOM"],
          strict: true,
          noUncheckedSideEffectImports: true,
          skipLibCheck: true,
        },
        include: ["src"],
      });
      writeFileSync(join(app, "tsconfig.json"), config);
      expect(
        (
          await initProject(app, {
            endpoint: "http://localhost:4318/v1/traces",
          })
        ).status,
      ).toBe("installed");
      expect(readFileSync(join(app, "tsconfig.json"), "utf8")).toBe(config);
      expect(readInstall(app)?.addedDependency).toBe(true);
      const execute = promisify(execFile);
      await execute(
        manager,
        manager === "npm"
          ? ["exec", "--", "vite", "build"]
          : ["exec", "vite", "build"],
        {
          cwd: app,
          timeout: 60000,
          maxBuffer: 1048576,
        },
      );
      expect(existsSync(join(app, "dist/index.html"))).toBe(true);
      expect(
        (
          await initProject(app, {
            endpoint: "http://localhost:4318/v1/traces",
          })
        ).status,
      ).toBe("unchanged");
      const pkgPath = join(app, "package.json");
      await execute(
        manager,
        manager === "npm"
          ? [
              "install",
              "is-number@7.0.0",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
            ]
          : ["add", "is-number@7.0.0", "--ignore-scripts"],
        { cwd: app, timeout: 60000, maxBuffer: 1048576 },
      );
      expect((await uninstallProject(app)).dependency).toBe("removed");
      expect((await uninstallProject(app)).status).toBe("unchanged");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      expect(pkg.dependencies["is-number"]).toBeTruthy();
      expect(pkg.dependencies["@journeygap/web"]).toBeUndefined();
      await execute(
        manager,
        manager === "npm"
          ? ["exec", "--", "vite", "build"]
          : ["exec", "vite", "build"],
        { cwd: app, timeout: 60000, maxBuffer: 1048576 },
      );
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
