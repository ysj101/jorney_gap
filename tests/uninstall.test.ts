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
import { afterEach, expect, it, vi } from "vitest";
import { initProject } from "../packages/cli/src/init.js";
import {
  INSTALL_FILE,
  type ProjectRuntime,
  readInstall,
} from "../packages/cli/src/project.js";
import { uninstallProject } from "../packages/cli/src/uninstall.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "journeygap-uninstall-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "index.html"),
    '<script type="module" src="/src/main.ts"></script>',
  );
  writeFileSync(join(root, "src/main.ts"), 'console.log("host");\n');
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "sample-web", devDependencies: { vite: "8.3.8" } }),
  );
  writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(join(root, "package-lock.json"), "{}");
  const command = vi.fn(
    async (_command: string, args: string[], cwd: string) => {
      const path = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      if (args[0] === "uninstall") delete pkg.dependencies["@journeygap/web"];
      else {
        pkg.dependencies = { ...pkg.dependencies, "@journeygap/web": "0.1.0" };
        mkdirSync(join(cwd, "node_modules/@journeygap/web"), {
          recursive: true,
        });
        writeFileSync(
          join(cwd, "node_modules/@journeygap/web/package.json"),
          '{"version":"0.1.0"}',
        );
      }
      writeFileSync(path, JSON.stringify(pkg));
    },
  );
  const typecheck = vi.fn(async (_root: string) => {});
  const tools = { command, typecheck } satisfies ProjectRuntime;
  await initProject(root, {}, tools);
  command.mockClear();
  typecheck.mockClear();
  return { root, tools };
}
it("removes only owned changes, preserves later edits and is repeatable", async () => {
  const { root, tools } = await fixture();
  const state = readInstall(root);
  if (!state) throw new Error("Missing manifest");
  const entry = join(root, state.entry);
  writeFileSync(
    entry,
    `${readFileSync(entry, "utf8")}\nconsole.log("later change");\n`,
  );
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies.unrelated = "1.0.0";
  writeFileSync(pkgPath, JSON.stringify(pkg));
  writeFileSync(join(root, "package-lock.json"), '{"laterChange":true}');
  expect((await uninstallProject(root, tools)).dependency).toBe("removed");
  expect(readFileSync(entry, "utf8")).toBe(
    'console.log("host");\n\nconsole.log("later change");\n',
  );
  expect(JSON.parse(readFileSync(pkgPath, "utf8")).dependencies.unrelated).toBe(
    "1.0.0",
  );
  expect(readFileSync(join(root, "package-lock.json"), "utf8")).toContain(
    "laterChange",
  );
  expect(existsSync(join(root, INSTALL_FILE))).toBe(false);
  expect((await uninstallProject(root, tools)).status).toBe("unchanged");
});
it.each(["journeygap.config.json", "src/journeygap.bootstrap.ts"])(
  "preserves edited %s and stops before removing dependencies",
  async (name) => {
    const { root, tools } = await fixture();
    const path = join(root, name);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// user edit`);
    await expect(uninstallProject(root, tools)).rejects.toThrow("Edited file");
    expect(tools.command).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toContain("user edit");
  },
);
it.each([
  'import "@journeygap/web";',
  'const moduleName="optional"; import(moduleName);',
  '/// <reference types="@journeygap/web" />',
])(
  "retains a dependency potentially used outside the integration: %s",
  async (source) => {
    const { root, tools } = await fixture();
    writeFileSync(join(root, "src/other.ts"), source);
    expect((await uninstallProject(root, tools)).dependency).toBe("retained");
    expect(tools.command).not.toHaveBeenCalled();
  },
);
it("can remove an optional Vite glob probe without breaking the app", async () => {
  const { root, tools } = await fixture();
  writeFileSync(
    join(root, "src/other.ts"),
    'const modules=import.meta.glob("/node_modules/@journeygap/web/dist/index.js");',
  );
  expect((await uninstallProject(root, tools)).dependency).toBe("removed");
});
it("restores the installed state when host typechecking fails", async () => {
  const { root, tools } = await fixture();
  const state = readInstall(root);
  if (!state) throw new Error("Missing manifest");
  const names = [
    "package.json",
    "package-lock.json",
    state.entry,
    INSTALL_FILE,
    ...Object.keys(state.files),
  ];
  const before = names.map((name) => readFileSync(join(root, name)));
  tools.typecheck.mockRejectedValueOnce(new Error("private diagnostic"));
  await expect(uninstallProject(root, tools)).rejects.toThrow(
    "owned changes were restored",
  );
  names.forEach((name, index) => {
    expect(readFileSync(join(root, name))).toEqual(before[index]);
  });
});
