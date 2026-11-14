import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test as base } from "@playwright/test";
import { createRelay } from "../../packages/relay/src/index.js";
import { packageRegistry } from "../fixtures/registry.js";

const execute = promisify(execFile);
export async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  return `http://127.0.0.1:${address.port}`;
}
export async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
export const test = base.extend<
  Record<never, never>,
  { lab: Awaited<ReturnType<typeof laboratory>> }
>({
  lab: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
    async ({}, use) => {
      const lab = await laboratory();
      try {
        await use(lab);
      } finally {
        await lab.close();
      }
    },
    { scope: "worker", timeout: 180000 },
  ],
});
export { expect } from "@playwright/test";

async function laboratory() {
  const root = mkdtempSync(join(tmpdir(), "journeygap-browser-"));
  const cleanups: Array<() => Promise<void>> = [];
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    for (const action of cleanups.reverse()) {
      try {
        await action();
      } catch {
        /* Continue cleanup. */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
  try {
    const app = join(root, "app");
    cpSync(resolve("examples/vite-basic"), app, {
      recursive: true,
      filter: (path) => !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(path),
    });
    const registry = await packageRegistry(root, [
      "core",
      "web",
      "relay",
      "cli",
    ]);
    cleanups.push(() => registry.close());
    const collector = process.env.JOURNEYGAP_COLLECTOR_ENDPOINT;
    const payloads: string[] = [];
    let active = "on";
    let received = 0;
    const staticServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const relative = decodeURIComponent(pathname).replace(/^\/field\//, "");
      if (!pathname.startsWith("/field/") || relative.includes("..")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let file = join(root, active, relative || "index.html");
      if (!existsSync(file) || !statSync(file).isFile())
        file = join(root, active, "index.html");
      res.setHeader(
        "content-security-policy",
        `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${relayOrigin} ${deniedOrigin} ${collector ? new URL(collector).origin : ""}; base-uri 'self'; object-src 'none'`,
      );
      res.setHeader(
        "Content-Type",
        (
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
          } as Record<string, string>
        )[extname(file)] ?? "application/octet-stream",
      );
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(readFileSync(file));
    });
    cleanups.push(() => close(staticServer));
    let relayOrigin = "";
    let deniedOrigin = "";
    const origin = await listen(staticServer, collector ? 4173 : 0);
    const journeys = ["first-task", "second-task"].map((id) => ({
      id,
      steps: [
        { id: "started" },
        { id: "reviewed" },
        { id: "completed", terminal: true },
      ],
      timeoutMinutes: 30,
    }));
    const relay = createRelay({
      config: {
        schemaVersion: 1,
        allowedOrigins: [origin],
        services: [{ serviceName: "sample-web", journeys }],
        retentionDays: 14,
        rateLimitPerMinute: 600,
      },
      ...(collector
        ? { upstream: { endpoint: collector, development: true } }
        : {}),
      databasePath: join(root, "relay.db"),
      adminToken: "synthetic-browser-admin-token-not-a-real-secret",
    });
    cleanups.push(() => relay.close());
    relay.server.on("request", (req) => {
      if (req.method === "POST") {
        received++;
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () =>
          payloads.push(Buffer.concat(chunks).toString("utf8")),
        );
      }
    });
    relayOrigin = await relay.listen(0);
    const denied = createRelay({
      config: {
        schemaVersion: 1,
        allowedOrigins: ["https://denied.example.test"],
        retentionDays: 14,
        rateLimitPerMinute: 600,
        services: [{ serviceName: "sample-web", journeys }],
      },
      databasePath: ":memory:",
      adminToken: "synthetic-browser-admin-token-not-a-real-secret",
    });
    cleanups.push(() => denied.close());
    deniedOrigin = await denied.listen(0);
    writeFileSync(
      join(app, ".npmrc"),
      `@journeygap:registry=${registry.origin}\n`,
    );
    const command = async (args: string[]) => {
      await execute("npm", args, {
        cwd: app,
        timeout: 120000,
        maxBuffer: 2097152,
      });
    };
    const cli = resolve("packages/cli/dist/main.js");
    const invoke = async (args: string[]) =>
      execute(process.execPath, [cli, ...args], {
        cwd: app,
        timeout: 120000,
        maxBuffer: 2097152,
      });
    // Exercise the actual CLI entrypoint, not a workspace dependency in the app.
    await invoke(["init", "--endpoint", `${relayOrigin}/v1/traces`]);
    await invoke(["init", "--endpoint", `${relayOrigin}/v1/traces`]);
    const configPath = join(app, "journeygap.config.json");
    const original = readFileSync(configPath, "utf8");
    for (const mode of [
      "on",
      "off",
      "denied",
      ...(collector ? ["collector"] : []),
    ]) {
      const config = JSON.parse(original);
      if (mode === "off") config.enabled = false;
      if (mode === "denied")
        config.otlpTracesEndpoint = `${deniedOrigin}/v1/traces`;
      if (mode === "collector") config.otlpTracesEndpoint = collector;
      writeFileSync(configPath, JSON.stringify(config));
      await command(["run", "build"]);
      cpSync(join(app, "dist"), join(root, mode), { recursive: true });
    }
    writeFileSync(configPath, original);
    await invoke(["uninstall"]);
    await invoke(["uninstall"]);
    await command(["run", "build"]);
    cpSync(join(app, "dist"), join(root, "removed"), { recursive: true });
    return {
      origin,
      relayOrigin,
      deniedOrigin,
      relay,
      payloads,
      root,
      app,
      requests: () => received,
      setMode: (mode: string) => {
        active = mode;
      },
      async stopRelay() {
        await relay.close();
      },
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
