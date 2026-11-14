import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { gunzipSync } from "node:zlib";
import {
  MAX_OTLP_BYTES,
  OtlpValidationError,
  parseOtlpJson,
  validateRelayConfig,
} from "@journeygap/core";
import { AdminError, createAdmin } from "./admin.js";
import { EventStore, StorageQuotaError } from "./storage.js";

export type RelayOptions = {
  config: unknown;
  databasePath: string;
  adminToken: string;
  now?: () => number;
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", failed);
      req.removeListener("aborted", aborted);
      if (error) {
        req.pause();
        reject(error);
      } else resolve(Buffer.concat(chunks, size));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OTLP_BYTES)
        finish(new HttpError(413, "Payload too large"));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => finish(new HttpError(400, "Incomplete request"));
    const aborted = () => finish(new HttpError(400, "Incomplete request"));
    const timer = setTimeout(
      () => finish(new HttpError(408, "Request timed out")),
      5000,
    );
    req
      .on("data", data)
      .once("end", end)
      .once("error", failed)
      .once("aborted", aborted);
  });
}

/** Loopback-first reference receiver. No request payloads, IPs or secrets are logged. */
export function createRelay(options: RelayOptions) {
  const validated = validateRelayConfig(options.config);
  if (!validated.valid) throw new Error("Invalid Relay configuration");
  const config = validated.value;
  const now = options.now ?? Date.now;
  if (!/^[\x21-\x7e]{32,256}$/.test(options.adminToken))
    throw new Error(
      "A server-only admin token of 32–256 printable characters is required",
    );
  const store = new EventStore(options.databasePath, {
    retentionDays: config.retentionDays,
    ...(config.maxEvents === undefined ? {} : { maxEvents: config.maxEvents }),
    ...(config.maxDatabaseBytes === undefined
      ? {}
      : { maxDatabaseBytes: config.maxDatabaseBytes }),
    now,
  });
  // Fixed-size, temporary IP buckets. No forwarded header is trusted or persisted.
  const buckets = new Map<string, { count: number; expires: number }>();
  const admin = createAdmin({ token: options.adminToken, config, store, now });
  let globalBucket = { count: 0, expires: 0 };
  const stats = {
    acceptedRequests: 0,
    rejectedRequests: 0,
    storedEvents: 0,
    duplicateEvents: 0,
    navigationEvents: 0,
    errorEvents: 0,
  };
  function allowRequest(req: IncomingMessage): boolean {
    const time = now();
    if (time >= globalBucket.expires)
      globalBucket = { count: 0, expires: time + 60000 };
    if (++globalBucket.count > config.rateLimitPerMinute * 100) return false;
    for (const [ip, bucket] of buckets)
      if (time >= bucket.expires) buckets.delete(ip);
    const ip = req.socket.remoteAddress ?? "unknown";
    let bucket = buckets.get(ip);
    if (!bucket) {
      if (buckets.size >= 10000) return false;
      bucket = { count: 0, expires: time + 60000 };
      buckets.set(ip, bucket);
    }
    return ++bucket.count <= config.rateLimitPerMinute;
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = req.url?.split("?", 1)[0];
    if (path === "/admin/v1/report") {
      if (!allowRequest(req)) throw new HttpError(429, "Rate limit exceeded");
      try {
        json(res, 200, admin(req));
      } catch (error) {
        if (error instanceof AdminError) {
          if (error.status === 401)
            res.setHeader(
              "WWW-Authenticate",
              'Bearer realm="JourneyGap admin"',
            );
          if (error.status === 405) res.setHeader("Allow", "GET");
          throw new HttpError(error.status, error.message);
        }
        throw error;
      }
      return;
    }
    if (path === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok" });
      return;
    }
    if (path !== "/v1/traces") {
      json(res, 404, { error: "Not found" });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin))
      throw new HttpError(403, "Origin not allowed");
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (!allowRequest(req)) {
      res.setHeader("Retry-After", "60");
      throw new HttpError(429, "Rate limit exceeded");
    }
    if (req.method === "OPTIONS") {
      if (!origin || req.headers["access-control-request-method"] !== "POST")
        throw new HttpError(403, "Preflight not allowed");
      const headers = String(
        req.headers["access-control-request-headers"] ?? "",
      )
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (headers.some((header) => header !== "content-type"))
        throw new HttpError(403, "Preflight headers not allowed");
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      throw new HttpError(405, "Method not allowed");
    }
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        req.headers["content-type"] ?? "",
      )
    )
      throw new HttpError(415, "Expected application/json");
    const encoding = req.headers["content-encoding"];
    if (
      encoding !== undefined &&
      encoding !== "identity" &&
      encoding !== "gzip"
    )
      throw new HttpError(415, "Unsupported content encoding");
    if (Number(req.headers["content-length"] ?? 0) > MAX_OTLP_BYTES)
      throw new HttpError(413, "Payload too large");
    let body = await readBody(req);
    if (encoding === "gzip") {
      try {
        body = gunzipSync(body, { maxOutputLength: MAX_OTLP_BYTES });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ERR_BUFFER_TOO_LARGE"
        )
          throw new HttpError(413, "Payload too large");
        throw new HttpError(400, "Invalid compressed payload");
      }
    }
    const parsed = parseOtlpJson(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
      config,
      now(),
    );
    const result = store.insert(parsed.journeyEvents);
    stats.acceptedRequests++;
    stats.storedEvents += result.inserted;
    stats.duplicateEvents += result.duplicates;
    stats.navigationEvents += parsed.events.filter(
      (event) => event.eventType === "navigation",
    ).length;
    stats.errorEvents += parsed.events.filter(
      (event) => event.eventType === "error",
    ).length;
    json(res, 200, {});
  }
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 },
    (req, res) => {
      void handle(req, res).catch((error: unknown) => {
        stats.rejectedRequests++;
        if (res.destroyed || res.writableEnded) return;
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
        if (error instanceof HttpError)
          json(res, error.status, { error: error.message });
        else if (
          error instanceof OtlpValidationError ||
          error instanceof TypeError
        )
          json(res, 400, { error: "Invalid OTLP JSON payload" });
        else if (error instanceof StorageQuotaError)
          json(res, 429, { error: "Storage capacity exceeded" });
        else json(res, 500, { error: "Ingest unavailable" });
      });
    },
  );
  server.maxConnections = 100;
  const sweep = setInterval(() => {
    for (const [ip, bucket] of buckets)
      if (now() >= bucket.expires) buckets.delete(ip);
  }, 60000);
  sweep.unref();
  let closed = false;
  return {
    server,
    store,
    config,
    stats: () => ({ ...stats }),
    async listen(port = 4318, host = "127.0.0.1"): Promise<string> {
      if (closed) throw new Error("Relay is closed");
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(port, host, () => {
          server.removeListener("error", failed);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Relay address unavailable");
      return `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      buckets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      store.close();
    },
  };
}
