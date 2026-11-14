import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { doctorProject } from "../packages/cli/src/doctor.js";
import { initProject } from "../packages/cli/src/init.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(endpoint?: string) {
  const root = mkdtempSync(join(tmpdir(), "journeygap-doctor-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "index.html"),
    '<script type="module" src="/src/main.ts"></script>',
  );
  writeFileSync(join(root, "src/main.ts"), 'console.log("host");');
  writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "sample-web", devDependencies: { vite: "8.3.8" } }),
  );
  await initProject(root, endpoint ? { endpoint } : {}, {
    async command() {
      mkdirSync(join(root, "node_modules/@journeygap/web"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "node_modules/@journeygap/web/package.json"),
        '{"version":"0.1.0"}',
      );
    },
    async typecheck() {},
  });
  writeFileSync(join(root, "dist/app.js"), 'console.log("host");');
  return root;
}
it("checks disabled integration without creating any network requests", async () => {
  const root = await fixture();
  const request = vi.fn<typeof fetch>();
  const result = await doctorProject(
    root,
    { origin: "https://app.example.test" },
    request,
  );
  expect(result.ok).toBe(true);
  expect(request).not.toHaveBeenCalled();
  expect(result.checks.find((c) => c.check === "cors")?.status).toBe(
    "unchecked",
  );
  expect(result.limitation).toContain("cannot guarantee");
});
it("performs a real specified-Origin preflight and inspects deployed CSP without sending telemetry", async () => {
  const requests: string[] = [];
  let blocked = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "OPTIONS") {
      res.setHeader(
        "access-control-allow-origin",
        blocked ? "https://wrong.example.test" : (req.headers.origin ?? ""),
      );
      res.setHeader("access-control-allow-methods", "POST");
      res.setHeader("access-control-allow-headers", "content-type");
    } else
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; connect-src 'self'",
      );
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const root = await fixture(`${origin}/v1/traces`);
    expect((await doctorProject(root, { origin })).ok).toBe(true);
    expect(requests).toEqual(["OPTIONS /v1/traces", "HEAD /"]);
    blocked = true;
    expect(
      (await doctorProject(root, { origin })).checks.find(
        (c) => c.check === "cors",
      )?.status,
    ).toBe("fail");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it("detects a denying meta CSP and edited management regions", async () => {
  const root = await fixture("https://ingest.example.test/v1/traces");
  writeFileSync(
    join(root, "index.html"),
    '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'">',
  );
  writeFileSync(join(root, "src/main.ts"), 'console.log("manually replaced");');
  const result = await doctorProject(root);
  expect(
    result.checks.filter((c) => c.status === "fail").map((c) => c.check),
  ).toEqual(["installation", "csp"]);
});
it("reports recognizable bundled secrets without printing values or submitted configuration", async () => {
  const root = await fixture();
  const synthetic = "synthetic-test-credential-00000";
  writeFileSync(
    join(root, "dist/app.js"),
    `const header="Bearer ${synthetic}";`,
  );
  const result = await doctorProject(root);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(synthetic);
  const path = join(root, "journeygap.config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.headers = { Authorization: synthetic };
  writeFileSync(path, JSON.stringify(config));
  expect(JSON.stringify(await doctorProject(root))).not.toContain(synthetic);
});
it("leaves unbuilt output unchecked and rejects credential-bearing Origin arguments without echo", async () => {
  const root = await fixture();
  rmSync(join(root, "dist"), { recursive: true });
  expect(
    (await doctorProject(root)).checks.find((c) => c.check === "bundle")
      ?.status,
  ).toBe("unchecked");
  await expect(
    doctorProject(root, {
      origin: "https://synthetic:password@app.example.test",
    }),
  ).rejects.toThrow("plain HTTP(S) origin");
});
