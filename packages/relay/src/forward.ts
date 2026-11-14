import { isSafeEndpoint, type SanitizedOtlp } from "@journeygap/core";

export type ForwardOptions = {
  endpoint: string;
  authorization?: string;
  development?: boolean;
};

/** Fixed destination, bounded queue, no redirects, retries, payload logging or durable delivery. */
export function createForwarder(options: ForwardOptions) {
  const endpoint = options.endpoint;
  const authorization = options.authorization;
  const developmentHttp =
    options.development === true &&
    process.env.NODE_ENV !== "production" &&
    endpoint.startsWith("http:") &&
    isSafeEndpoint(endpoint.replace(/^http:/, "https:"));
  if (!isSafeEndpoint(endpoint) && !developmentHttp)
    throw new Error("Invalid upstream endpoint");
  if (
    options.authorization !== undefined &&
    !/^(?:Bearer|Basic) [\x21-\x7e]{1,4096}$/.test(options.authorization)
  )
    throw new Error("Invalid upstream authentication header");
  const queue: string[] = [];
  const stats = { succeeded: 0, failed: 0, dropped: 0 };
  let closed = false;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;

  async function drain(): Promise<void> {
    while (!closed && queue.length) {
      const body = queue.shift();
      if (body === undefined) break;
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), 3000);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body,
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
        });
        // No upstream text is logged or included in receiver responses.
        await response.body?.cancel();
        if (response.status === 200) stats.succeeded++;
        else stats.failed++;
      } catch {
        stats.failed++;
      } finally {
        clearTimeout(timer);
        controller = undefined;
      }
    }
  }
  return {
    enqueue(envelope: SanitizedOtlp): void {
      if (closed || !envelope.resourceSpans.length) return;
      if (queue.length >= 4) {
        stats.dropped++;
        return;
      }
      const body = JSON.stringify(envelope);
      if (Buffer.byteLength(body) > 262144) {
        stats.dropped++;
        return;
      }
      queue.push(body);
      if (!running)
        running = drain().finally(() => {
          running = undefined;
        });
    },
    stats: () => ({
      ...stats,
      queued: queue.length,
      inFlight: running !== undefined,
    }),
    async idle(): Promise<void> {
      await running;
    },
    async close(): Promise<void> {
      closed = true;
      stats.dropped += queue.length;
      queue.length = 0;
      controller?.abort();
      await running;
    },
  };
}
