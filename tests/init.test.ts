import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { run } from "../packages/cli/src/index.js";
import { initProject } from "../packages/cli/src/init.js";
import {
  INSTALL_FILE,
  type Manager,
  type ProjectRuntime,
  readInstall,
  START,
} from "../packages/cli/src/project.js";

const directories: string[] = [];
const endpoint = "https://ingest.example.test/v1/traces";
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(pm: Manager = "npm", extension = "ts") {
  const root = mkdtempSync(join(tmpdir(), "journeygap-init-"));
  directories.push(root);
  mkdirSync(join(root, "src"));
  const source =
    '// existing uncommitted comment\r\n"use client";\r\nimport "./style.css";\r\nconst answer = "架空のアプリデータ";\r\nconsole.log(answer);\r\n';
  writeFileSync(join(root, "src", `main.${extension}`), source);
  writeFileSync(join(root, "src/style.css"), "body { color: black; }\n");
  writeFileSync(
    join(root, "index.html"),
    `<script type="module" src="/src/main.${extension}"></script>`,
  );
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "sample-web",
        version: "0.0.0",
        devDependencies: { vite: "8.3.8", typescript: "5.9.3" },
      },
      null,
      4,
    )}\n`,
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "bundler",
      },
      include: ["src"],
    }),
  );
  const lock = pm === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  const lockBefore =
    pm === "npm"
      ? '{"lockfileVersion":3,"existingDirtyMetadata":"preserve"}\n'
      : 'lockfileVersion: "9.0"\n# existing user changes\n';
  writeFileSync(join(root, lock), lockBefore);
  const command = vi.fn(
    async (_command: string, args: string[], cwd: string) => {
      if (args.some((arg) => arg.startsWith("@journeygap/web@"))) {
        const path = join(cwd, "package.json");
        const pkg = JSON.parse(readFileSync(path, "utf8"));
        pkg.dependencies = { ...pkg.dependencies, "@journeygap/web": "0.1.0" };
        writeFileSync(path, JSON.stringify(pkg, null, 2));
        writeFileSync(
          join(cwd, lock),
          `${lockBefore}\n# simulated package-manager change\n`,
        );
        mkdirSync(join(cwd, "node_modules/@journeygap/web"), {
          recursive: true,
        });
        writeFileSync(
          join(cwd, "node_modules/@journeygap/web/package.json"),
          JSON.stringify({ name: "@journeygap/web", version: "0.1.0" }),
        );
      }
    },
  );
  const typecheck = vi.fn(async (_cwd: string) => {});
  return {
    root,
    source,
    lock,
    lockBefore,
    tools: { command, typecheck } satisfies ProjectRuntime,
  };
}

it.each(["npm", "pnpm"] as const)(
  "installs once with %s, preserves entry bytes and records ownership hashes",
  async (pm) => {
    const p = fixture(pm);
    const result = await initProject(p.root, { endpoint }, p.tools);
    expect(result.status).toBe("installed");
    const state = readInstall(p.root);
    if (!state) throw new Error("No install manifest");
    expect(state).toMatchObject({
      manager: pm,
      addedDependency: true,
      dependencyName: "@journeygap/web",
      addedDependencyVersion: "0.1.0",
    });
    const source = readFileSync(join(p.root, "src/main.ts"), "utf8");
    expect(source.replace(state.managedBlock, "")).toBe(p.source);
    expect(source.indexOf(START)).toBeGreaterThan(source.indexOf("use client"));
    expect(source.indexOf(START)).toBeGreaterThan(
      source.indexOf('import "./style.css"'),
    );
    expect(
      JSON.parse(readFileSync(join(p.root, "journeygap.config.json"), "utf8")),
    ).toMatchObject({
      enabled: true,
      otlpTracesEndpoint: endpoint,
      serviceName: "sample-web",
    });
    expect(p.tools.command.mock.calls[0]?.[0]).toBe(pm);
    expect(p.tools.command.mock.calls[0]?.[1]).toContain("--ignore-scripts");
    const manifest = readFileSync(join(p.root, INSTALL_FILE));
    expect((await initProject(p.root, { endpoint }, p.tools)).status).toBe(
      "unchanged",
    );
    expect(readFileSync(join(p.root, INSTALL_FILE))).toEqual(manifest);
    expect(p.tools.command).toHaveBeenCalledTimes(1);
    expect(p.tools.typecheck).toHaveBeenCalledTimes(1);
    expect(existsSync(join(p.root, ".journeygap-install.lock"))).toBe(false);
  },
);

it("handles TSX and generates a disabled configuration without an endpoint", async () => {
  const p = fixture("npm", "tsx");
  writeFileSync(
    join(p.root, "src/main.tsx"),
    '"use client";\nconst screen = <main>Host app</main>;\nconsole.log(screen);\n',
  );
  await initProject(p.root, {}, p.tools);
  const state = readInstall(p.root);
  expect(state?.entry).toBe("src/main.tsx");
  expect(
    JSON.parse(readFileSync(join(p.root, "journeygap.config.json"), "utf8")),
  ).toMatchObject({ enabled: false });
  expect(
    readFileSync(join(p.root, "src/journeygap.bootstrap.ts"), "utf8"),
  ).toContain(".catch(() =>");
  expect(
    readFileSync(join(p.root, "src/journeygap-env.d.ts"), "utf8"),
  ).toContain('declare module "*.json?raw"');
});

it("refuses unsafe endpoints and unsupported projects without changing files or installing", async () => {
  const p = fixture();
  const before = readFileSync(join(p.root, "package.json"));
  await expect(
    initProject(
      p.root,
      { endpoint: "https://user:dummy@example.test/v1/traces" },
      p.tools,
    ),
  ).rejects.toThrow("Invalid public OTLP endpoint");
  expect(readFileSync(join(p.root, "package.json"))).toEqual(before);
  expect(p.tools.command).not.toHaveBeenCalled();
  rmSync(join(p.root, "tsconfig.json"));
  await expect(initProject(p.root, { endpoint }, p.tools)).rejects.toThrow(
    "Supported target",
  );
  expect(readdirSync(join(p.root, "src"))).toEqual(["main.ts", "style.css"]);
  expect(p.tools.command).not.toHaveBeenCalled();
});

it.each(["install", "typecheck"])(
  "rolls back a failed %s while preserving preexisting dirty package/lock/source bytes",
  async (phase) => {
    const p = fixture();
    const before = readFileSync(join(p.root, "package.json"));
    if (phase === "install")
      p.tools.command.mockImplementationOnce(async () => {
        writeFileSync(
          join(p.root, "package.json"),
          "partial package-manager output",
        );
        throw new Error("synthetic-private-install-error");
      });
    else
      p.tools.typecheck.mockRejectedValueOnce(
        new Error("synthetic-private-typecheck-error"),
      );
    await expect(initProject(p.root, { endpoint }, p.tools)).rejects.toThrow(
      "project files were restored",
    );
    expect(readFileSync(join(p.root, "package.json"))).toEqual(before);
    expect(readFileSync(join(p.root, p.lock), "utf8")).toBe(p.lockBefore);
    expect(readFileSync(join(p.root, "src/main.ts"), "utf8")).toBe(p.source);
    for (const name of [
      INSTALL_FILE,
      "journeygap.config.json",
      "src/journeygap.bootstrap.ts",
      "src/journeygap-env.d.ts",
      ".journeygap-install.lock",
    ])
      expect(existsSync(join(p.root, name))).toBe(false);
  },
);

it("preserves an entry edited concurrently during typecheck while removing only its own import", async () => {
  const p = fixture();
  p.tools.typecheck.mockImplementationOnce(async () => {
    const path = join(p.root, "src/main.ts");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\nconst userAdded = 1;\n`,
    );
    throw new Error("typecheck failed");
  });
  await expect(initProject(p.root, { endpoint }, p.tools)).rejects.toThrow();
  expect(readFileSync(join(p.root, "src/main.ts"), "utf8")).toBe(
    `${p.source}\nconst userAdded = 1;\n`,
  );
});

it("stops at user-edited generated files and requires an exact reviewed approval for config changes", async () => {
  const p = fixture();
  await initProject(p.root, {}, p.tools);
  let approval = "";
  try {
    await initProject(p.root, { endpoint }, p.tools);
  } catch (error) {
    if (error instanceof Error)
      approval =
        /--approve-config-change ([a-f0-9]{24})/.exec(error.message)?.[1] ?? "";
  }
  expect(approval).toHaveLength(24);
  expect(
    JSON.parse(readFileSync(join(p.root, "journeygap.config.json"), "utf8"))
      .enabled,
  ).toBe(false);
  await expect(
    initProject(p.root, { endpoint, approveConfigChange: "wrong" }, p.tools),
  ).rejects.toThrow("Configuration diff");
  expect(
    (
      await initProject(
        p.root,
        { endpoint, approveConfigChange: approval },
        p.tools,
      )
    ).status,
  ).toBe("config-updated");
  expect(
    JSON.parse(readFileSync(join(p.root, "journeygap.config.json"), "utf8"))
      .enabled,
  ).toBe(true);
  const path = join(p.root, "src/journeygap.bootstrap.ts");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n// user edit\n`);
  await expect(initProject(p.root, { endpoint }, p.tools)).rejects.toThrow(
    "Edited file",
  );
  expect(readFileSync(path, "utf8")).toContain("user edit");
});

it("does not take ownership of a preexisting SDK dependency", async () => {
  const p = fixture();
  const path = join(p.root, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.dependencies = { "@journeygap/web": "^0.1.0" };
  writeFileSync(path, JSON.stringify(pkg));
  mkdirSync(join(p.root, "node_modules/@journeygap/web"), { recursive: true });
  writeFileSync(
    join(p.root, "node_modules/@journeygap/web/package.json"),
    JSON.stringify({ name: "@journeygap/web", version: "0.1.0" }),
  );
  await initProject(p.root, { endpoint }, p.tools);
  expect(p.tools.command).not.toHaveBeenCalled();
  expect(readInstall(p.root)?.addedDependency).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(pkg));
});

it("rejects symlinked entries and ambiguous package managers without side effects", async () => {
  const p = fixture();
  const entry = join(p.root, "src/main.ts");
  rmSync(entry);
  symlinkSync(join(p.root, "src/style.css"), entry);
  await expect(initProject(p.root, { endpoint }, p.tools)).rejects.toThrow(
    "Symlinked",
  );
  expect(p.tools.command).not.toHaveBeenCalled();
  rmSync(entry);
  writeFileSync(entry, p.source);
  writeFileSync(join(p.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await expect(initProject(p.root, { endpoint }, p.tools)).rejects.toThrow(
    "unambiguous",
  );
  expect(p.tools.command).not.toHaveBeenCalled();
});

it("does not interpret --force as permission to overwrite an existing project file", async () => {
  const p = fixture();
  const errors: string[] = [];
  expect(
    await run(
      ["init", "--force"],
      { out() {}, error: (text) => errors.push(text) },
      p.root,
    ),
  ).toBe(1);
  expect(errors[0]).toContain("--force");
  expect(existsSync(join(p.root, INSTALL_FILE))).toBe(false);
});
