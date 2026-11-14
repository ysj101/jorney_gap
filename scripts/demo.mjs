import { execFile, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createRelay } from "../packages/relay/dist/index.js";
import { packageRegistry } from "../tests/fixtures/registry.ts";

const root = mkdtempSync(join(tmpdir(), "journeygap-demo-"));
const app = join(root, "app");
let registry, relay, child;
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  child?.kill("SIGTERM");
  if (relay) await relay.close();
  if (registry) await registry.close();
  rmSync(root, { recursive: true, force: true });
}
process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
try {
  cpSync(resolve("examples/vite-basic"), app, {
    recursive: true,
    filter: (path) => !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(path),
  });
  registry = await packageRegistry(root);
  writeFileSync(
    join(app, ".npmrc"),
    `@journeygap:registry=${registry.origin}\n`,
  );
  const config = {
    schemaVersion: 1,
    allowedOrigins: ["http://127.0.0.1:5173"],
    services: [
      {
        serviceName: "sample-web",
        journeys: ["first-task", "second-task"].map((id) => ({
          id,
          steps: [
            { id: "started" },
            { id: "reviewed" },
            { id: "completed", terminal: true },
          ],
          timeoutMinutes: 30,
        })),
      },
    ],
    retentionDays: 14,
    rateLimitPerMinute: 600,
  };
  relay = createRelay({
    config,
    databasePath: join(root, "demo.db"),
    adminToken: "synthetic-local-demo-admin-token-not-a-real-secret",
  });
  await relay.listen(4318);
  await promisify(execFile)(
    process.execPath,
    [
      resolve("packages/cli/dist/main.js"),
      "init",
      "--endpoint",
      "http://127.0.0.1:4318/v1/traces",
    ],
    { cwd: app, timeout: 120000, maxBuffer: 2097152 },
  );
  console.log(
    `Temporary independent app: ${app}\nBrowser: http://127.0.0.1:5173/field/\nDatabase: ${join(root, "demo.db")}\nCLI: ${resolve("packages/cli/dist/main.js")}\nCtrl-C removes this synthetic demo and database.`,
  );
  child = spawn(
    "npm",
    [
      "exec",
      "--",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
      "--strictPort",
    ],
    { cwd: app, stdio: "inherit" },
  );
  child.once("exit", () => void cleanup());
  child.once("error", () => {
    process.exitCode = 1;
    void cleanup();
  });
} catch {
  console.error(
    "Demo failed. Build first and ensure ports 4318/5173 are available. No request or credential data was printed.",
  );
  process.exitCode = 1;
  await cleanup();
}
