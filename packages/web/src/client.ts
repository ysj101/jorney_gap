import {
  type JourneyGapClient,
  type JourneyGapConfig,
  sanitizeAttributes,
  type TrackAttributes,
  validateConfig,
} from "@journeygap/core";
import {
  CONSENT_KEY,
  clearSession,
  compactConsent,
  persistConsent,
  readConsent,
  SESSION_KEY,
} from "./consent.js";
import { createTelemetry, type Telemetry, type WebEvent } from "./transport.js";

const KEY = Symbol.for("journeygap.client.v1");
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Registry = { client: JourneyGapClient; session: () => string | undefined };
type WithoutIdentity<T> = T extends unknown
  ? Omit<T, "eventId" | "sessionId" | "timestampMs">
  : never;
type EventDetails = WithoutIdentity<WebEvent>;
const noop: JourneyGapClient = {
  trackStep() {},
  trackError() {},
  setConsent() {},
  getConsent: () => false,
  shutdown: async () => {},
};
function registry(target: Window = window): Registry | undefined {
  const value: unknown = Reflect.get(target, KEY);
  return value &&
    typeof value === "object" &&
    "client" in value &&
    "session" in value &&
    typeof value.session === "function"
    ? (value as Registry)
    : undefined;
}

export function getJourneyGapClient(): JourneyGapClient | null {
  try {
    return typeof window !== "undefined" ? (registry()?.client ?? null) : null;
  } catch {
    return null;
  }
}
export function trackStep(
  journeyId: string,
  stepId: string,
  attrs?: TrackAttributes,
): void {
  try {
    getJourneyGapClient()?.trackStep(journeyId, stepId, attrs);
  } catch {
    /* Fail open. */
  }
}

function createClient(config: JourneyGapConfig): Registry {
  let consent = false;
  let sessionId: string | undefined;
  let telemetry: Telemetry | undefined;
  let closed = false;
  let ui: ReturnType<typeof compactConsent> | undefined;
  const attempts = new Map<string, { instanceId: string; position: number }>();
  const calls = new Map<string, string>();
  const shuttingDown = new Set<Promise<void>>();
  const makeId = () => crypto.randomUUID();
  function session(): string {
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(SESSION_KEY);
    } catch {
      /* Storage can be disabled. */
    }
    // New tabs opened from an existing tab can inherit its initial sessionStorage.
    try {
      if (
        stored &&
        window.opener &&
        registry(window.opener)?.session() === stored
      )
        stored = null;
    } catch {
      /* Cross-origin opener is inaccessible. */
    }
    const value = stored && uuid.test(stored) ? stored.toLowerCase() : makeId();
    try {
      window.sessionStorage.setItem(SESSION_KEY, value);
    } catch {
      /* Keep the ID in memory only. */
    }
    return value;
  }
  function stop(clearStored = true): void {
    const previous = telemetry;
    telemetry = undefined;
    sessionId = undefined;
    attempts.clear();
    calls.clear();
    if (clearStored) clearSession();
    if (previous) {
      try {
        previous.discard();
      } catch {
        /* Still attempt resource release. */
      }
      const pending = Promise.resolve()
        .then(() => previous.shutdown())
        .catch(() => {})
        .finally(() => shuttingDown.delete(pending));
      shuttingDown.add(pending);
    }
  }
  function setConsent(value: boolean): void {
    try {
      if (closed || !config.enabled || typeof value !== "boolean") return;
      persistConsent(value);
      if (value === consent) {
        if (!value) stop();
        return;
      }
      consent = value;
      if (value) {
        sessionId = session();
        telemetry = createTelemetry(config);
      } else stop();
      ui?.update(value);
    } catch {
      /* Telemetry construction/storage failure never reaches the app. */
    }
  }
  function send(event: EventDetails): void {
    if (!telemetry || !sessionId) return;
    telemetry.record({
      ...event,
      eventId: makeId(),
      sessionId,
      timestampMs: Date.now(),
    });
  }
  const client: JourneyGapClient = {
    trackStep(journeyId, stepId, attrs) {
      try {
        if (closed || !consent || !telemetry) return;
        const definition = config.journeys.find(
          (journey) => journey.id === journeyId,
        );
        const position =
          definition?.steps.findIndex((step) => step.id === stepId) ?? -1;
        if (!definition || position < 0) return;
        const attributes = sanitizeAttributes(
          attrs,
          config.attributesAllowlist,
        );
        const signature = `${stepId}/${JSON.stringify(attributes)}`;
        if (calls.get(journeyId) === signature) return;
        calls.set(journeyId, signature);
        queueMicrotask(() => {
          if (calls.get(journeyId) === signature) calls.delete(journeyId);
        });
        if (position === 0)
          attempts.set(journeyId, { instanceId: makeId(), position: 0 });
        const attempt = attempts.get(journeyId);
        if (!attempt) return;
        if (position === attempt.position + 1) attempt.position = position;
        send({
          eventType: "step",
          instanceId: attempt.instanceId,
          journeyId,
          stepId,
          attributes,
        });
      } catch {
        /* Observe only, never change host behavior. */
      }
    },
    trackError(kind) {
      try {
        if (
          !closed &&
          consent &&
          telemetry &&
          ["render", "network", "unknown"].includes(kind)
        )
          send({ eventType: "error", errorKind: kind });
      } catch {
        /* No exception text is recorded. */
      }
    },
    setConsent,
    getConsent: () => !closed && config.enabled && consent,
    async shutdown() {
      if (closed) return;
      closed = true;
      consent = false;
      for (const cleanup of [
        () => stop(false),
        () => ui?.remove(),
        () => window.removeEventListener("storage", storage),
        () => window.removeEventListener("pagehide", pagehide),
        () => {
          if (registry() === entry) Reflect.deleteProperty(window, KEY);
        },
      ]) {
        try {
          cleanup();
        } catch {
          /* A failed cleanup must not prevent the others. */
        }
      }
      await Promise.all(shuttingDown);
    },
  };
  const entry = { client, session: () => sessionId };
  const storage = (event: StorageEvent) => {
    if (
      (event.key === CONSENT_KEY || event.key === null) &&
      event.newValue !== "true"
    )
      setConsent(false);
  };
  const pagehide = () => {
    void telemetry?.flush().catch(() => {});
  };
  if (config.enabled) {
    window.addEventListener("storage", storage);
    window.addEventListener("pagehide", pagehide);
    if (config.consent.ui === "compact") {
      try {
        ui = compactConsent(setConsent, false);
        if (readConsent()) setConsent(true);
        else clearSession();
      } catch {
        /* An unavailable consent UI leaves telemetry off. */
      }
    }
  }
  return entry;
}

export function initJourneyGap(input: JourneyGapConfig): JourneyGapClient {
  try {
    if (typeof window === "undefined" || typeof document === "undefined")
      return noop;
    const existing = registry();
    if (existing) return existing.client;
    const validated = validateConfig(input);
    if (!validated.valid) return noop;
    const value = createClient(validated.value);
    if (!Reflect.set(window, KEY, value)) {
      void value.client.shutdown().catch(() => {});
      return noop;
    }
    return value.client;
  } catch {
    return noop;
  }
}
