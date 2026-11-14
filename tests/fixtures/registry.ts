import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
/** Read-only, loopback npm fixture registry: no account, publishing or credentials. */
export async function packageRegistry(
  directory: string,
  packages = ["core", "web"],
) {
  const entries = new Map<
    string,
    { manifest: Record<string, unknown>; tar: Buffer }
  >();
  for (const name of packages) {
    await execute(
      "pnpm",
      [
        "--filter",
        `@journeygap/${name}`,
        "pack",
        "--pack-destination",
        directory,
      ],
      { cwd: resolve("."), timeout: 30000 },
    );
    const path = join(directory, `journeygap-${name}-0.1.0.tgz`);
    const metadata = await execute("tar", [
      "-xOf",
      path,
      "package/package.json",
    ]);
    entries.set(name, {
      manifest: JSON.parse(metadata.stdout),
      tar: readFileSync(path),
    });
  }
  let origin = "";
  const server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? "").split("?", 1)[0] ?? "");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    for (const [name, entry] of entries) {
      if (path === `/${name}.tgz`) {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": entry.tar.length,
        });
        res.end(entry.tar);
        return;
      }
      if (path === `/@journeygap/${name}`) {
        const dist = {
          tarball: `${origin}/${name}.tgz`,
          shasum: createHash("sha1").update(entry.tar).digest("hex"),
          integrity: `sha512-${createHash("sha512").update(entry.tar).digest("base64")}`,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            name: `@journeygap/${name}`,
            "dist-tags": { latest: "0.1.0" },
            time: { "0.1.0": "2025-01-01T00:00:00.000Z" },
            versions: { "0.1.0": { ...entry.manifest, dist } },
          }),
        );
        return;
      }
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Registry address unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
