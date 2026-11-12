import type { Scalar, TrackAttributes } from "./types.js";

const sensitiveKey =
  /(?:email|url|text|message|body|password|token|secret|cookie|user|account|address|phone|name|answer|input|stack|authorization|bearer|credential|session|(?:^|[._-])id(?:$|[._-]))/i;

/** Values must be declared categorical data, never arbitrary user input. */
export function sanitizeAttributes(
  input: unknown,
  allowlist: readonly string[] = [],
): TrackAttributes {
  const result: TrackAttributes = {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    return result;
  for (const key of allowlist.slice(0, 10)) {
    if (
      !/^app\.[a-z][a-z0-9._-]{0,59}$/.test(key) ||
      key.length > 64 ||
      sensitiveKey.test(key)
    )
      continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    // Do not invoke getters supplied by application code.
    const value: unknown =
      descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (
      typeof value === "boolean" ||
      (typeof value === "number" &&
        Number.isFinite(value) &&
        Math.abs(value) <= Number.MAX_SAFE_INTEGER)
    ) {
      result[key] = value;
    } else if (
      typeof value === "string" &&
      /^[a-z][a-z0-9._-]{0,31}$/.test(value) &&
      !sensitiveKey.test(value) &&
      !/[a-z0-9_-]{24}/i.test(value)
    ) {
      result[key] = value;
    }
  }
  return result;
}

export function safeVersion(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 64 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    !sensitiveKey.test(value)
    ? value
    : undefined;
}

export function scalarToOtlp(value: Scalar): Record<string, Scalar> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number")
    return Number.isSafeInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  return { stringValue: value };
}
