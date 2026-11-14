import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { CliError } from "./config.js";

export const INSTALL_FILE = ".journeygap-install.json";
export const SDK_VERSION = "0.1.0";
export const START = "// journeygap:managed:start";
export const END = "// journeygap:managed:end";
export const LOCK_FILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
];
export type Manager = "npm" | "pnpm";
export type InstallState = {
  schemaVersion: 1;
  generatedBy: string;
  entry: string;
  managedBlock: string;
  entryBeforeHash: string;
  packageBeforeHash: string;
  lockBeforeHashes: Record<string, string | null>;
  manager: Manager;
  addedDependency: boolean;
  dependencyName: "@journeygap/web";
  addedDependencyVersion: string | null;
  files: Record<string, string>;
};
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function safePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || absolute === root)
    throw new CliError("Managed paths must stay inside the project");
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new CliError(
          "Symlinked project files require manual integration",
        );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  return absolute;
}
export function textFile(path: string, max = 1048576): string {
  if (!statSync(path).isFile() || statSync(path).size > max)
    throw new CliError("Unsupported file type or size");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      readFileSync(path),
    );
  } catch {
    throw new CliError("Project text files must use UTF-8");
  }
}
export function packageJson(root: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      textFile(safePath(root, "package.json"), 262144).replace(/^\uFEFF/, ""),
    );
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Sanitized error below. */
  }
  throw new CliError("A valid package.json is required");
}
export function dependencies(
  pkg: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const section of [pkg.dependencies, pkg.devDependencies])
    if (section && typeof section === "object" && !Array.isArray(section))
      for (const [name, version] of Object.entries(section))
        if (typeof version === "string") result[name] = version;
  return result;
}
export function manager(root: string, pkg: Record<string, unknown>): Manager {
  const pnpm = existsSync(join(root, "pnpm-lock.yaml"));
  const npm =
    existsSync(join(root, "package-lock.json")) ||
    existsSync(join(root, "npm-shrinkwrap.json"));
  if (
    (pnpm && npm) ||
    existsSync(join(root, "yarn.lock")) ||
    existsSync(join(root, "bun.lock")) ||
    existsSync(join(root, "bun.lockb"))
  )
    throw new CliError(
      "Use an unambiguous npm or pnpm project; no files changed",
    );
  if (pnpm) return "pnpm";
  if (npm) return "npm";
  if (
    typeof pkg.packageManager === "string" &&
    !/^(npm|pnpm)@/.test(pkg.packageManager)
  )
    throw new CliError("Only npm and pnpm are supported");
  return typeof pkg.packageManager === "string" &&
    pkg.packageManager.startsWith("pnpm@")
    ? "pnpm"
    : "npm";
}
export function detectEntry(
  root: string,
  pkg: Record<string, unknown>,
): string {
  if (
    !dependencies(pkg).vite ||
    !existsSync(join(root, "index.html")) ||
    !existsSync(join(root, "tsconfig.json"))
  )
    throw new CliError(
      "Supported target: standalone Vite + TypeScript with index.html and tsconfig.json",
    );
  const html = textFile(safePath(root, "index.html"));
  const candidates = [...html.matchAll(/<script\b[^>]*>/gi)]
    .filter(([tag]) => /\btype\s*=\s*(["'])module\1/i.test(tag))
    .flatMap(([tag]) => {
      const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
      return src && !/^(?:https?:)?\/\//.test(src)
        ? [src.split(/[?#]/, 1)[0] ?? ""]
        : [];
    })
    .filter((src) => /\.(?:ts|tsx|mts)$/.test(src));
  if (candidates.length !== 1 || !candidates[0])
    throw new CliError("Exactly one local TypeScript module entry is required");
  const path = safePath(root, candidates[0].replace(/^\//, ""));
  textFile(path);
  return relative(root, path).split(sep).join("/");
}
export function entryPatch(
  source: string,
  entry: string,
): { text: string; block: string } {
  const file = ts.createSourceFile(
    entry,
    source,
    ts.ScriptTarget.Latest,
    true,
    entry.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (
    source.includes(START) ||
    source.includes(END) ||
    file.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.includes("journeygap.bootstrap"),
    )
  )
    throw new CliError(
      "Existing JourneyGap code requires its original install manifest or manual integration",
    );
  const diagnostics =
    ts.transpileModule(source, {
      fileName: entry,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        jsx: ts.JsxEmit.Preserve,
      },
    }).diagnostics ?? [];
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  )
    throw new CliError("The entry has syntax errors; no changes made");
  let position = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      (ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression))
    )
      position = statement.end;
    else break;
  }
  const statement = ts.factory.createImportDeclaration(
    undefined,
    undefined,
    ts.factory.createStringLiteral("./journeygap.bootstrap.js"),
    undefined,
  );
  const code = ts
    .createPrinter()
    .printNode(ts.EmitHint.Unspecified, statement, file);
  const block = `\n${START}\n${code}\n${END}\n`;
  return {
    text: source.slice(0, position) + block + source.slice(position),
    block,
  };
}
export function managedPaths(entry: string): string[] {
  return [
    "journeygap.config.json",
    join(dirname(entry), "journeygap.bootstrap.ts").split(sep).join("/"),
    join(dirname(entry), "journeygap-env.d.ts").split(sep).join("/"),
  ];
}
export function readInstall(root: string): InstallState | null {
  const path = safePath(root, INSTALL_FILE);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(textFile(path, 65536));
  } catch {
    throw new CliError("Invalid install manifest; inspect it manually");
  }
  if (!value || typeof value !== "object")
    throw new CliError("Invalid install manifest");
  const data = value as InstallState;
  if (
    data.schemaVersion !== 1 ||
    typeof data.entry !== "string" ||
    !/\.(?:ts|tsx|mts)$/.test(data.entry) ||
    typeof data.managedBlock !== "string" ||
    data.managedBlock !== entryPatch("", data.entry).block ||
    !["npm", "pnpm"].includes(data.manager) ||
    typeof data.addedDependency !== "boolean" ||
    data.dependencyName !== "@journeygap/web" ||
    (data.addedDependency
      ? typeof data.addedDependencyVersion !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(data.addedDependencyVersion)
      : data.addedDependencyVersion !== null) ||
    typeof data.generatedBy !== "string" ||
    !/^@journeygap\/cli@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(
      data.generatedBy,
    ) ||
    typeof data.entryBeforeHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.entryBeforeHash) ||
    typeof data.packageBeforeHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.packageBeforeHash) ||
    !data.lockBeforeHashes ||
    typeof data.lockBeforeHashes !== "object" ||
    Object.keys(data.lockBeforeHashes).length !== LOCK_FILES.length ||
    Object.entries(data.lockBeforeHashes).some(
      ([name, value]) =>
        !LOCK_FILES.includes(name) ||
        (value !== null &&
          (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))),
    ) ||
    !data.files ||
    typeof data.files !== "object"
  )
    throw new CliError("Invalid install manifest");
  safePath(root, data.entry);
  const allowed = managedPaths(data.entry);
  if (
    Object.keys(data.files).length !== allowed.length ||
    allowed.some(
      (name) =>
        typeof data.files[name] !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.files[name] ?? ""),
    )
  )
    throw new CliError("Invalid managed file inventory");
  for (const name of allowed) safePath(root, name);
  return data;
}
export function verifyManaged(
  root: string,
  state: InstallState,
  allowMissing = false,
): void {
  for (const [name, expected] of Object.entries(state.files)) {
    const path = safePath(root, name);
    if (!existsSync(path)) {
      if (allowMissing) continue;
      throw new CliError(
        `Missing managed file ${name}; inspect and repair manually`,
      );
    }
    const actual = hash(readFileSync(path));
    if (actual !== expected)
      throw new CliError(
        `Edited file ${name}: expected SHA256 ${expected}, found ${actual}. No changes made. Back up or move edited files and inspect git diff before retrying uninstall; do not discard your changes`,
      );
  }
  const entry = textFile(safePath(root, state.entry));
  if (entry.split(state.managedBlock).length !== 2)
    throw new CliError(
      "Managed entry region is missing, duplicated or edited; inspect git diff and remove it manually",
    );
}

type Snapshot = { path: string; data: Buffer | null; mode: number };
export function snapshot(root: string, names: string[]): Snapshot[] {
  return [...new Set(names)].map((name) => {
    const path = safePath(root, name);
    if (existsSync(path)) {
      const info = statSync(path);
      if (!info.isFile() || info.size > 16777216)
        throw new CliError("Unsupported snapshot file size or type");
      return { path, data: readFileSync(path), mode: info.mode & 0o777 };
    }
    return { path, data: null, mode: 0o644 };
  });
}
export function restore(files: Snapshot[]): void {
  for (const file of files) {
    if (file.data === null) {
      if (existsSync(file.path)) unlinkSync(file.path);
    } else {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.data);
      chmodSync(file.path, file.mode);
    }
  }
}
export async function locked<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const path = safePath(root, ".journeygap-install.lock");
  const owner = JSON.stringify({ pid: process.pid, operation: randomUUID() });
  try {
    writeFileSync(path, owner, { flag: "wx", mode: 0o600 });
  } catch {
    throw new CliError(
      "An install lock exists or cannot be created; inspect it before retrying",
    );
  }
  try {
    return await action();
  } finally {
    if (existsSync(path) && readFileSync(path, "utf8") === owner)
      unlinkSync(path);
  }
}
const execute = promisify(execFile);
export type ProjectRuntime = {
  command: (command: string, args: string[], cwd: string) => Promise<void>;
  typecheck: (cwd: string) => Promise<void>;
};
export const runtime: ProjectRuntime = {
  async command(command, args, cwd) {
    await execute(command, args, { cwd, timeout: 120000, maxBuffer: 1048576 });
  },
  async typecheck(cwd) {
    let compiler: string;
    try {
      compiler = createRequire(join(cwd, "package.json")).resolve(
        "typescript/lib/tsc.js",
      );
    } catch {
      compiler = createRequire(import.meta.url).resolve(
        "typescript/lib/tsc.js",
      );
    }
    const path = existsSync(join(cwd, "tsconfig.app.json"))
      ? "tsconfig.app.json"
      : "tsconfig.json";
    const config = ts.readConfigFile(join(cwd, path), ts.sys.readFile);
    if (config.error) throw new CliError("Invalid TypeScript configuration");
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
    const temporary = mkdtempSync(join(tmpdir(), "journeygap-typecheck-"));
    try {
      await execute(
        process.execPath,
        [
          compiler,
          "--noEmit",
          "-p",
          path,
          ...(parsed.options.incremental || parsed.options.composite
            ? ["--tsBuildInfoFile", join(temporary, "check.tsbuildinfo")]
            : []),
        ],
        { cwd, timeout: 60000, maxBuffer: 1048576 },
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
};
export const canonicalRoot = (cwd: string) => realpathSync(cwd);
