/**
 * Config secret redaction for the `/api/config` surface.
 *
 * Extracted from `api.ts` (audit AS-001) without behavior change: secret-bearing
 * fields are replaced with a `***` sentinel before config is sent to the UI, and
 * `deepMerge` round-trips that sentinel back to the stored value on PUT.
 */

const REDACTED_SECRET = "***";

/** Splits a key on non-alphanumeric boundaries AND camelCase transitions, lowercased. */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

export function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("cookie") ||
    normalized.includes("bearer") ||
    normalized.includes("connectionstring") ||
    normalized === "authorization"
  ) {
    return true;
  }
  // "pat"/"dsn" are only meaningful as a whole delimited segment (e.g.
  // "GITHUB_PAT", "SENTRY_DSN") — matched as a raw substring they'd
  // false-positive on ordinary keys like "path" or "pattern".
  const segments = keySegments(key);
  return segments.includes("pat") || segments.includes("dsn") || segments.includes("connstr");
}

// CF2-208: a DSN/connection string or any `scheme://user:pass@host` value can
// carry credentials regardless of what its key is named (e.g. a `url` or
// `endpoint` field). Detected by shape, not key.
const URL_USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]*:[^/?#@\s]+@/i;

export function looksLikeCredentialBearingValue(value: unknown): boolean {
  return typeof value === "string" && URL_USERINFO_RE.test(value);
}

/**
 * Replace any secret-bearing fields with the "***" sentinel before sending
 * config to the UI.
 * deepMerge round-trips the sentinel back to the original value on PUT.
 */
export function sanitizeConfigForApi<T>(value: T, key = ""): T {
  if (
    value !== undefined && value !== null && value !== "" &&
    (isSensitiveConfigKey(key) || looksLikeCredentialBearingValue(value))
  ) {
    return REDACTED_SECRET as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigForApi(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeConfigForApi(childValue, childKey);
    }
    return out as T;
  }
  return value;
}

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    // Skip sanitized secret placeholders — keep original value. A field can
    // have been redacted either because its key looked sensitive, or because
    // its *original* value looked like a credential-bearing URL/DSN (key-
    // agnostic) — check the original target value's shape too, since the
    // incoming placeholder itself carries no shape information to recover.
    if (sv === REDACTED_SECRET && (isSensitiveConfigKey(key) || looksLikeCredentialBearingValue(tv))) continue;
    if (Array.isArray(sv)) {
      // For arrays (e.g. instances), preserve secrets from matching items
      if (Array.isArray(tv)) {
        result[key] = sv.map((item: unknown) => {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const srcItem = item as Record<string, unknown>;
            // Find matching target item by id
            const matchTarget = (tv as unknown[]).find(
              (t) => t && typeof t === "object" && (t as Record<string, unknown>).id === srcItem.id
            ) as Record<string, unknown> | undefined;
            if (matchTarget) return deepMerge(matchTarget, srcItem);
          }
          return item;
        });
      } else {
        result[key] = sv;
      }
    } else if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}
