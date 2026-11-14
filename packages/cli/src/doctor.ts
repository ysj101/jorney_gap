import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateConfig } from "@journeygap/core";
import { CliError } from "./config.js";
import {
  canonicalRoot,
  readInstall,
  safePath,
  textFile,
  verifyManaged,
} from "./project.js";

export type Diagnostic = {
  check: string;
  status: "pass" | "fail" | "unchecked";
  detail: string;
};
export type DoctorResult = {
  ok: boolean;
  checks: Diagnostic[];
  limitation: string;
};
const limitation =
  "Static inspection and a server-side preflight cannot guarantee browser success. Rebuild after config changes and verify the deployed page, CSP, consent and Network panel in a real browser.";
function allows(
  policy: string,
  endpoint: URL,
  origin: string | undefined,
): boolean {
  const directives = policy
    .split(";")
    .map((value) => value.trim().split(/\s+/));
  const directive =
    directives.find((value) => value[0]?.toLowerCase() === "connect-src") ??
    directives.find((value) => value[0]?.toLowerCase() === "default-src");
  if (!directive) return true;
  return directive.slice(1).some((source) => {
    if (source === "'self'") return endpoint.origin === origin;
    if (source === "*") return true;
    if (source === "https:" || source === "http:")
      return endpoint.protocol === source;
    try {
      const url = new URL(source);
      return (
        url.origin === endpoint.origin &&
        (url.pathname === "/" || endpoint.pathname.startsWith(url.pathname))
      );
    } catch {
      return false;
    }
  });
}
function scanBundle(root: string): "clean" | "secret" | "limited" | "missing" {
  const dist = safePath(root, "dist");
  if (!existsSync(dist)) return "missing";
  const pending = [dist];
  let count = 0;
  let bytes = 0;
  while (pending.length) {
    const dir = pending.pop();
    if (!dir) break;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (++count > 2000 || item.isSymbolicLink()) return "limited";
      const path = safePath(root, join(dir, item.name));
      if (item.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!/\.(?:[cm]?js|json|html|map)$/i.test(item.name)) continue;
      const size = statSync(path).size;
      bytes += size;
      if (size > 8 * 1048576 || bytes > 32 * 1048576) return "limited";
      const text = textFile(path, 8 * 1048576);
      if (
        /\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_.=-]{8,}/i.test(text) ||
        /["'](?:authorization|x-api-key|api-key)["']\s*:\s*["'][^"']{8,}["']/i.test(
          text,
        ) ||
        /https?:\/\/[^\s/"']+:[^\s/"']+@/i.test(text)
      )
        return "secret";
    }
  }
  return "clean";
}
export async function doctorProject(
  cwd: string,
  options: { origin?: string } = {},
  request: typeof fetch = fetch,
): Promise<DoctorResult> {
  const root = canonicalRoot(cwd);
  const checks: Diagnostic[] = [];
  const add = (check: string, status: Diagnostic["status"], detail: string) => {
    checks.push({ check, status, detail });
  };
  let origin: string | undefined;
  if (options.origin !== undefined) {
    try {
      const value = new URL(options.origin);
      if (
        !/^https?:$/.test(value.protocol) ||
        value.username ||
        value.password ||
        value.search ||
        value.hash ||
        value.pathname !== "/"
      )
        throw new Error();
      origin = value.origin;
    } catch {
      throw new CliError(
        "--origin must be a plain HTTP(S) origin without credentials, path, query or fragment",
      );
    }
  }
  let input: unknown;
  try {
    input = JSON.parse(
      textFile(safePath(root, "journeygap.config.json"), 262144),
    );
  } catch {
    add(
      "config",
      "fail",
      "Missing, oversized or invalid Web configuration; values are not printed",
    );
    return { ok: false, checks, limitation };
  }
  const config = validateConfig(input);
  if (!config.valid) {
    add(
      "config",
      "fail",
      "Web schema rejected configuration, including unknown fields or secret headers; values are not printed",
    );
    return { ok: false, checks, limitation };
  }
  add("config", "pass", "Web schema and explicit opt-in consent are valid");
  const endpoint = new URL(config.value.otlpTracesEndpoint);
  add(
    "endpoint",
    "pass",
    endpoint.protocol === "https:"
      ? "HTTPS public endpoint without credentials"
      : "Loopback HTTP endpoint: local development only",
  );
  add(
    "exporter",
    "pass",
    config.value.enabled
      ? "Enabled: official OTLP/HTTP JSON exporter is configured; creation waits for consent"
      : "Disabled: no exporter or transmission will start",
  );
  try {
    const state = readInstall(root);
    if (!state)
      add(
        "installation",
        "fail",
        "No ownership manifest; use init or review manual integration",
      );
    else {
      verifyManaged(root, state);
      add(
        "installation",
        "pass",
        "Owned files and managed import hashes match",
      );
    }
  } catch {
    add(
      "installation",
      "fail",
      "Managed files/import or manifest changed; preserve edits and inspect manually",
    );
  }
  try {
    const result = scanBundle(root);
    add(
      "bundle",
      result === "clean" ? "pass" : result === "secret" ? "fail" : "unchecked",
      result === "clean"
        ? "No recognizable hardcoded authorization values in bounded dist scan; this is not proof of absence"
        : result === "secret"
          ? "Potential public-bundle credential detected; values and paths withheld. Remove it and rotate any real credential"
          : "Build output missing or inspection limit reached; inspect deployed assets manually",
    );
  } catch {
    add(
      "bundle",
      "unchecked",
      "Bundle could not be fully inspected; values were not printed",
    );
  }
  const policies: string[] = [];
  try {
    const html = textFile(safePath(root, "index.html"));
    for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
      if (!/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(tag))
        continue;
      const content = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
      if (content)
        policies.push(
          (content[2] ?? content[3] ?? "")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'"),
        );
    }
  } catch {
    /* No local meta policy can be established. */
  }
  if (origin && config.value.enabled) {
    try {
      const response = await request(config.value.otlpTracesEndpoint, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      const allow = response.headers.get("access-control-allow-origin");
      const methods =
        response.headers
          .get("access-control-allow-methods")
          ?.toLowerCase()
          .split(/\s*,\s*/) ?? [];
      const headers =
        response.headers
          .get("access-control-allow-headers")
          ?.toLowerCase()
          .split(/\s*,\s*/) ?? [];
      add(
        "cors",
        response.ok &&
          (allow === origin || allow === "*") &&
          methods.includes("post") &&
          (headers.includes("content-type") || headers.includes("*"))
          ? "pass"
          : "fail",
        "Specified-Origin preflight checked without cookies or telemetry; browser validation is still required",
      );
      await response.body?.cancel();
    } catch {
      add(
        "cors",
        "fail",
        "Preflight failed or timed out; no response payload printed",
      );
    }
    try {
      const response = await request(origin, {
        method: "HEAD",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      const policy = response.headers.get("content-security-policy");
      if (policy) policies.push(policy);
      if (!response.ok)
        add("csp-header", "unchecked", "Deployed document headers unavailable");
      await response.body?.cancel();
    } catch {
      add("csp-header", "unchecked", "Deployed document headers unavailable");
    }
  } else
    add(
      "cors",
      "unchecked",
      config.value.enabled
        ? "Specify --origin to check preflight; no network probe performed"
        : "Disabled configuration; no network probe performed",
    );
  add(
    "csp",
    !policies.length
      ? "unchecked"
      : policies.every((policy) => allows(policy, endpoint, origin))
        ? "pass"
        : "fail",
    policies.length
      ? "Inspected connect-src/default-src against endpoint. Unsupported source expressions conservatively fail; inspect all deployed policies"
      : "No enforced policy observed; inspect deployed connect-src/default-src",
  );
  return {
    ok: !checks.some((check) => check.status === "fail"),
    checks,
    limitation,
  };
}
