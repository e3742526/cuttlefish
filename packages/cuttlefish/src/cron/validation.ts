import crypto from "node:crypto";
import cron from "node-cron";
import type { CronDelivery, CronJob } from "../shared/types.js";

const CREATE_FIELDS = new Set(["id", "name", "enabled", "schedule", "timezone", "engine", "model", "employee", "prompt", "delivery"]);
const UPDATE_FIELDS = new Set(["name", "enabled", "schedule", "timezone", "engine", "model", "employee", "prompt", "delivery"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function validateTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`timezone is not valid: ${tz}`);
  }
}

function validateDelivery(value: unknown): CronDelivery | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new Error("delivery must be an object");
  const connector = optionalString(value, "connector");
  const channel = optionalString(value, "channel");
  if (!connector || !channel) throw new Error("delivery.connector and delivery.channel are required strings");
  return { connector, channel };
}

function rejectUnknown(body: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown cron fields: ${unknown.join(", ")}`);
}

// Any ASCII control character (0x00-0x1f), including newline/CR/tab, or DEL (0x7f).
const MAX_ASCII_CONTROL_CODE = 0x1f;
const DEL_CODE = 0x7f;

function isUnsafeLogIdChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code <= MAX_ASCII_CONTROL_CODE || code === DEL_CODE || ch === "/" || ch === "\\";
}

/**
 * Strips characters that are unsafe for use as a filesystem path segment or in
 * a single-line log entry (path separators and control characters, including
 * newlines) from a cron job id, and strips leading "." segments so the id
 * cannot resolve to "." / ".." path components. `id` is attacker/user-controlled
 * via the cron API body and is used verbatim to build the per-job run-log path
 * (SEC-CFDB-005); sanitizing here — mirroring the path-safety checks in
 * gateway/api/match-route.ts — keeps the log path inside the run-log directory
 * and prevents embedded newlines/control chars from forging fake log entries,
 * without rejecting jobs whose id predates this restriction.
 */
export function sanitizeCronLogId(id: string): string {
  const raw = String(id ?? "");
  let cleaned = "";
  for (const ch of raw) {
    cleaned += isUnsafeLogIdChar(ch) ? "_" : ch;
  }
  cleaned = cleaned.replace(/^\.+/, "");
  return cleaned || "unknown";
}

export function buildCronJob(body: unknown): CronJob {
  if (!isPlainObject(body)) throw new Error("Cron job must be an object");
  rejectUnknown(body, CREATE_FIELDS);
  const schedule = optionalString(body, "schedule") ?? "0 * * * *";
  if (!cron.validate(schedule)) throw new Error("schedule must be a valid cron expression");
  return {
    id: optionalString(body, "id") ?? crypto.randomUUID(),
    name: optionalString(body, "name") ?? "untitled",
    enabled: optionalBoolean(body, "enabled") ?? true,
    schedule,
    timezone: validateTimezone(optionalString(body, "timezone")),
    engine: optionalString(body, "engine"),
    model: optionalString(body, "model"),
    employee: optionalString(body, "employee"),
    prompt: optionalString(body, "prompt") ?? "",
    delivery: validateDelivery(body.delivery),
  };
}

/**
 * Validates the on-disk shape of a persisted cron job entry (DAT-BUS-005), used
 * only by `loadJobs()`. Unlike `buildCronJob` (the API write-boundary validator),
 * this deliberately does NOT reject an entry solely for having an invalid cron
 * `schedule` string: GET /api/cron intentionally surfaces already-persisted jobs
 * with a broken schedule (`scheduleValid: false`, see `gateway/api/routes/cron.ts`)
 * instead of hiding them, and the scheduler skips them at schedule time with a
 * warning — dropping them at load time would defeat that visibility. This
 * validator only rejects entries with the wrong field *types*, which the
 * scheduler/API layers do not defend against.
 */
export function parseStoredCronJob(body: unknown): CronJob {
  if (!isPlainObject(body)) throw new Error("Cron job must be an object");
  const id = optionalString(body, "id");
  if (!id) throw new Error("id must be a non-empty string");
  // Unlike buildCronJob, tolerate unknown/legacy fields and a missing/invalid
  // schedule string here — those are load-time compatibility concerns, not
  // shape errors.
  const scheduleRaw = body.schedule;
  if (scheduleRaw !== undefined && typeof scheduleRaw !== "string") {
    throw new Error("schedule must be a string");
  }
  return {
    id,
    name: optionalString(body, "name") ?? "untitled",
    enabled: optionalBoolean(body, "enabled") ?? true,
    schedule: (scheduleRaw as string | undefined) ?? "0 * * * *",
    timezone: validateTimezone(optionalString(body, "timezone")),
    engine: optionalString(body, "engine"),
    model: optionalString(body, "model"),
    employee: optionalString(body, "employee"),
    prompt: optionalString(body, "prompt") ?? "",
    delivery: validateDelivery(body.delivery),
  };
}

export function patchCronJob(existing: CronJob, body: unknown): CronJob {
  if (!isPlainObject(body)) throw new Error("Cron update must be an object");
  rejectUnknown(body, UPDATE_FIELDS);
  const next: CronJob = { ...existing };
  if (body.name !== undefined) next.name = optionalString(body, "name") ?? existing.name;
  if (body.enabled !== undefined) next.enabled = optionalBoolean(body, "enabled") ?? existing.enabled;
  if (body.schedule !== undefined) {
    const schedule = optionalString(body, "schedule");
    if (!schedule || !cron.validate(schedule)) throw new Error("schedule must be a valid cron expression");
    next.schedule = schedule;
  }
  if (body.timezone !== undefined) next.timezone = validateTimezone(optionalString(body, "timezone"));
  if (body.engine !== undefined) next.engine = optionalString(body, "engine");
  if (body.model !== undefined) next.model = optionalString(body, "model");
  if (body.employee !== undefined) next.employee = optionalString(body, "employee");
  if (body.prompt !== undefined) next.prompt = optionalString(body, "prompt") ?? "";
  if (body.delivery !== undefined) next.delivery = validateDelivery(body.delivery);
  return next;
}
