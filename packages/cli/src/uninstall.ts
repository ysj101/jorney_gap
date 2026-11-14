import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { CliError } from "./config.js";
import {
  canonicalRoot,
  dependencies,
  entryPatch,
  hash,
  INSTALL_FILE,
  LOCK_FILES,
  locked,
  manager,
  type ProjectRuntime,
  packageJson,
  readInstall,
  restore,
  runtime,
  safePath,
  snapshot,
  textFile,
  verifyManaged,
} from "./project.js";

function optionalGlob(node: ts.Node): boolean {
  let value = node;
  while (value.parent && ts.isArrayLiteralExpression(value.parent))
    value = value.parent;
  const call = value.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    call.arguments[0] === value &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "glob" &&
    ts.isMetaProperty(call.expression.expression) &&
    call.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}
function otherUses(root: string, owned: Set<string>): boolean {
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (
        ["node_modules", ".git", ".pnpm-store"].includes(item.name) ||
        (directory === root &&
          [
            "dist",
            "build",
            "coverage",
            "test-results",
            "playwright-report",
            ".output",
          ].includes(item.name))
      )
        continue;
      if (++count > 2000 || item.isSymbolicLink()) return true;
      const path = join(directory, item.name);
      const name = relative(root, path).split(sep).join("/");
      if (
        owned.has(name) ||
        name === "package.json" ||
        LOCK_FILES.includes(name)
      )
        continue;
      if (item.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (
        !/\.(?:[cm]?[jt]sx?|vue|svelte|html|css|scss|less|json)$/.test(
          item.name,
        )
      )
        continue;
      if (statSync(path).size > 1048576) return true;
      const source = textFile(path);
      if (!/\.[cm]?[jt]sx?$/.test(item.name)) {
        if (source.toLowerCase().includes("@journeygap/web")) return true;
        continue;
      }
      const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      let used = [
        ...file.typeReferenceDirectives,
        ...file.referencedFiles,
      ].some((reference) => reference.fileName.includes("@journeygap/web"));
      function visit(node: ts.Node): void {
        if (
          ts.isStringLiteralLike(node) &&
          node.text.toLowerCase().includes("@journeygap/web") &&
          !optionalGlob(node)
        )
          used = true;
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === "require")) &&
          (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
        )
          used = true;
        if (!used) ts.forEachChild(node, visit);
      }
      visit(file);
      if (used) return true;
    }
  }
  return false;
}

export type UninstallResult = {
  status: "uninstalled" | "unchanged";
  dependency: "removed" | "retained" | "absent";
  files: string[];
};
export async function uninstallProject(
  cwd: string,
  tools: ProjectRuntime = runtime,
): Promise<UninstallResult> {
  const root = canonicalRoot(cwd);
  return locked(root, async () => {
    const state = readInstall(root);
    if (!state)
      return {
        status: "unchanged",
        dependency: dependencies(packageJson(root))["@journeygap/web"]
          ? "retained"
          : "absent",
        files: [],
      };
    verifyManaged(root, state, true);
    const pkg = packageJson(root);
    const pm = manager(root, pkg);
    const current = dependencies(pkg)[state.dependencyName];
    const remove =
      !!current &&
      state.addedDependency &&
      current === state.addedDependencyVersion &&
      !otherUses(root, new Set([...Object.keys(state.files), INSTALL_FILE]));
    const originals = snapshot(root, [
      "package.json",
      ...LOCK_FILES,
      state.entry,
      ...Object.keys(state.files),
      INSTALL_FILE,
    ]);
    const deleted = new Set<string>();
    let entryAfter: string | undefined;
    let entryBefore: string | undefined;
    try {
      if (remove)
        await tools.command(
          pm,
          pm === "npm"
            ? [
                "uninstall",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                state.dependencyName,
              ]
            : ["remove", "--config.ignore-scripts=true", state.dependencyName],
          root,
        );
      // Re-read after the package-manager operation to preserve unrelated edits.
      verifyManaged(root, state, true);
      entryBefore = textFile(safePath(root, state.entry));
      entryAfter = entryBefore.replace(state.managedBlock, "");
      writeFileSync(safePath(root, state.entry), entryAfter);
      for (const [name, expected] of Object.entries(state.files)) {
        const path = safePath(root, name);
        if (existsSync(path)) {
          if (hash(readFileSync(path)) !== expected)
            throw new CliError("Generated file changed during uninstall");
          unlinkSync(path);
          deleted.add(name);
        }
      }
      await tools.typecheck(root);
      const manifest = originals.find(
        (file) => file.path === safePath(root, INSTALL_FILE),
      )?.data;
      if (
        !manifest ||
        hash(readFileSync(safePath(root, INSTALL_FILE))) !== hash(manifest)
      )
        throw new CliError("Install manifest changed during uninstall");
      unlinkSync(safePath(root, INSTALL_FILE));
      return {
        status: "uninstalled",
        dependency: remove ? "removed" : current ? "retained" : "absent",
        files: [state.entry, ...deleted, INSTALL_FILE],
      };
    } catch {
      let complete = true;
      try {
        if (remove)
          restore(
            originals.filter(
              (file) =>
                file.path === safePath(root, "package.json") ||
                LOCK_FILES.some((name) => file.path === safePath(root, name)),
            ),
          );
        for (const name of deleted) {
          const path = safePath(root, name);
          const original = originals.find((file) => file.path === path);
          if (original?.data && !existsSync(path))
            writeFileSync(path, original.data, {
              flag: "wx",
              mode: original.mode,
            });
        }
        if (entryAfter !== undefined && entryBefore !== undefined) {
          const source = textFile(safePath(root, state.entry));
          if (source === entryAfter)
            writeFileSync(safePath(root, state.entry), entryBefore);
          else if (!source.includes(state.managedBlock))
            writeFileSync(
              safePath(root, state.entry),
              entryPatch(source, state.entry).text,
            );
        }
        if (remove) {
          try {
            await tools.command(
              pm,
              pm === "npm"
                ? ["install", "--ignore-scripts", "--no-audit", "--no-fund"]
                : ["install", "--ignore-scripts", "--no-frozen-lockfile"],
              root,
            );
          } catch {
            complete = false;
          }
          restore(
            originals.filter(
              (file) =>
                file.path === safePath(root, "package.json") ||
                LOCK_FILES.some((name) => file.path === safePath(root, name)),
            ),
          );
        }
      } catch {
        complete = false;
      }
      throw new CliError(
        complete
          ? "Uninstall failed; owned changes were restored and unrelated entry edits preserved. Inspect git diff and run the app typecheck"
          : "Uninstall failed; rollback needs manual inspection of files/dependencies. No git history was changed",
      );
    }
  });
}
