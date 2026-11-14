import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

type Response =
  | { status: "success"; data?: Uint8Array }
  | { status: "failure"; error: Error };
const failure = (): Response => ({
  status: "failure",
  error: new Error("JourneyGap export failed"),
});

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Official exporter and serializer; a version-checked transport adapter supplies abort/retry bounds. */
export function createBoundedExporter(endpoint: string) {
  const exporter = new OTLPTraceExporter({
    url: endpoint,
    headers: {},
    concurrencyLimit: 1,
    timeoutMillis: 3000,
  });
  const active = new Set<AbortController>();
  let closed = false;
  let requests = 0;
  const transport = {
    async send(data: Uint8Array): Promise<Response> {
      if (closed) return failure();
      const controller = new AbortController();
      active.add(controller);
      const deadline = Date.now() + 3000;
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        for (
          let attempt = 0;
          attempt <= 2 && !closed && !controller.signal.aborted;
          attempt++
        ) {
          let retryAfter = 0;
          try {
            requests++;
            const response = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: new Uint8Array(data),
              signal: controller.signal,
              credentials: "omit",
              redirect: "error",
              referrerPolicy: "no-referrer",
              keepalive: true,
            });
            if (response.status === 200) {
              const chunks: Uint8Array[] = [];
              let size = 0;
              const reader = response.body?.getReader();
              if (reader) {
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  size += chunk.value.length;
                  if (size > 65536) {
                    controller.abort();
                    return failure();
                  }
                  chunks.push(chunk.value);
                }
              }
              const body = new Uint8Array(size);
              let offset = 0;
              for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.length;
              }
              return size
                ? { status: "success", data: body }
                : { status: "success" };
            }
            await response.body?.cancel();
            if (![429, 502, 503, 504].includes(response.status))
              return failure();
            const header = response.headers.get("Retry-After");
            if (header)
              retryAfter = /^\d+$/.test(header)
                ? Number(header) * 1000
                : Math.max(0, Date.parse(header) - Date.now());
          } catch {
            if (closed || controller.signal.aborted) return failure();
          }
          if (attempt === 2) return failure();
          const delay = Math.max(
            250 * 2 ** attempt,
            Number.isFinite(retryAfter) ? retryAfter : 0,
          );
          if (
            delay >= deadline - Date.now() ||
            !(await wait(delay, controller.signal))
          )
            return failure();
        }
        return failure();
      } finally {
        clearTimeout(timer);
        active.delete(controller);
      }
    },
    shutdown(): Promise<void> {
      closed = true;
      for (const controller of active) controller.abort();
      return Promise.resolve();
    },
  };
  // The pinned exporter has no public transport/abort/retry configuration. Keep its
  // official JSON serializer, queue and result handling; replace only this seam.
  // Shape changes fail closed and are covered by real HTTP tests before upgrades.
  const delegate: unknown = Reflect.get(exporter, "_delegate");
  if (!delegate || typeof delegate !== "object")
    throw new Error("Unsupported OTLP exporter version");
  const original: unknown = Reflect.get(delegate, "_transport");
  if (
    !original ||
    typeof original !== "object" ||
    typeof Reflect.get(original, "send") !== "function" ||
    !Reflect.set(delegate, "_transport", transport)
  )
    throw new Error("Unsupported OTLP exporter transport");
  return {
    exporter,
    discard: () => {
      void transport.shutdown();
    },
    requests: () => requests,
  };
}
