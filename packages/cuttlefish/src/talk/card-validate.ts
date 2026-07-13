/**
 * Cuttlefish Talk — card validator.
 *
 * The cards surface lets any process (the orchestrator, a tool dispatcher, an
 * employee callback) push structured content to the /talk UI over the HTTP card
 * routes in routes.ts. Those routes accept untrusted JSON (the producer is the
 * orchestrator LLM via curl), so this is the gate: `validateCard` rejects
 * anything that isn't a well-formed `Card`, and `validateCardPatch` applies the
 * same per-field rigor to a partial update — BEFORE it's broadcast over the
 * WebSocket. Checks reach into nested optional fields (details/meta/hunks/…)
 * because a malformed shape there reaches the renderer and, with no error
 * boundary historically above it, would white-screen the whole Talk app.
 */
import type { Card } from "./protocol.js";

type Result = { ok: true; card: Card } | { ok: false; error: string };

const JOB_STATUSES = new Set(["queued", "running", "done", "error"]);

/**
 * Audit G-02/I-3: card URLs come from the orchestrator LLM and are rendered by
 * the web client — an `<img src>` fires a zero-click GET, so an injected model
 * can turn a card into an exfiltration beacon or a `javascript:`/`file:` sink.
 * Reject any scheme other than http/https/data and relative paths. (The stronger
 * mitigation — proxying/blocking remote-image auto-load or host-allowlisting — is
 * a web-renderer change tracked separately; this closes the scheme-based sinks
 * and gives the renderer a validated value.)
 */
function isSafeCardUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === "") return false;
  // Relative path or fragment/query — same-origin, safe.
  if (/^(?:\/(?!\/)|\.{1,2}\/|#|\?)/.test(trimmed)) return true;
  // data: images are inline (no network fetch to an attacker host).
  if (/^data:image\//i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    // Not an absolute URL and not a recognized relative form → reject.
    return false;
  }
}

// All 13 renderer card types are accepted; taste rules (DO/WATCH-first, 1–2 cards) live in the persona.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** Optional string: absent OR a string. */
function isStringIfPresent(v: unknown): boolean {
  return v === undefined || isString(v);
}

/** An array of `{ k: string, v: string }` pairs. */
function isKVPairs(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => isObject(x) && isString(x.k) && isString(x.v));
}

// ── Per-field checks (shared by validateCard + validateCardPatch). Each
//    returns an error string, or null when the field is valid/absent. ──────────

function checkChoiceOptions(options: unknown): string | null {
  if (!Array.isArray(options) || options.length === 0) {
    return "choice card requires a non-empty options array";
  }
  for (const opt of options) {
    if (!isObject(opt) || !isString(opt.id) || opt.id.length === 0 || !isString(opt.label)) {
      return "choice options require non-empty string id and string label";
    }
    if (!isStringIfPresent(opt.detail) || !isStringIfPresent(opt.badge)) {
      return "choice option detail/badge must be strings";
    }
    if (opt.meta !== undefined && !isKVPairs(opt.meta)) {
      return "choice option meta must be an array of {k,v} strings";
    }
  }
  return null;
}

function checkComparisonRows(rows: unknown): string | null {
  if (!Array.isArray(rows)) return "comparison card requires a rows array";
  for (const row of rows) {
    if (!isObject(row) || !isString(row.label) || !Array.isArray(row.cells) || !row.cells.every(isString)) {
      return "comparison rows require string label and string cells array";
    }
  }
  return null;
}

function checkKeyValueRows(rows: unknown): string | null {
  if (!Array.isArray(rows)) return "keyvalue card requires a rows array";
  for (const row of rows) {
    if (!isObject(row) || !isString(row.k) || !isString(row.v)) {
      return "keyvalue rows require string k and v";
    }
  }
  return null;
}

function checkDiffHunks(hunks: unknown): string | null {
  if (!Array.isArray(hunks) || hunks.length === 0) {
    return "diff card requires a non-empty hunks array";
  }
  for (const hunk of hunks) {
    if (!isObject(hunk)) return "diff hunks must be objects";
    if (!isStringIfPresent(hunk.label) || !isStringIfPresent(hunk.before) || !isStringIfPresent(hunk.after)) {
      return "diff hunk label/before/after must be strings when present";
    }
  }
  return null;
}

function checkListItems(items: unknown): string | null {
  if (!Array.isArray(items)) return "list card requires items array";
  for (const item of items) {
    if (!isObject(item) || !isString(item.text)) {
      return "list card items must be objects with string text";
    }
  }
  return null;
}

function checkImages(images: unknown): string | null {
  if (!Array.isArray(images)) return "image-grid card requires images array";
  for (const img of images) {
    if (!isObject(img) || !isString(img.src)) {
      return "image-grid images must be objects with string src";
    }
    if (!isSafeCardUrl(img.src)) {
      return "image-grid image src must be an http(s), data:image, or relative URL";
    }
  }
  return null;
}

function checkAgents(agents: unknown): string | null {
  if (!Array.isArray(agents)) return "agent-activity card requires agents array";
  for (const agent of agents) {
    if (!isObject(agent)) return "agent-activity agents must be objects";
    if (!isString(agent.id) || !isString(agent.name) || !isString(agent.role)) {
      return "agent-activity agents require string id, name, role";
    }
    if (!isString(agent.status) || !JOB_STATUSES.has(agent.status)) {
      return "agent-activity agents require status in queued|running|done|error";
    }
  }
  return null;
}

export function validateCard(input: unknown): Result {
  if (!isObject(input)) return { ok: false, error: "card must be a non-null object" };

  const { id, type } = input;
  if (!isString(id) || id.length === 0) {
    return { ok: false, error: "card.id must be a non-empty string" };
  }

  // Optional common fields, if present, must be strings.
  if (input.title !== undefined && !isString(input.title)) {
    return { ok: false, error: "card.title must be a string" };
  }
  if (input.badge !== undefined && !isString(input.badge)) {
    return { ok: false, error: "card.badge must be a string" };
  }

  switch (type) {
    case "text":
      if (!isString(input.body)) return { ok: false, error: "text card requires string body" };
      break;

    case "status":
      if (!isString(input.label)) return { ok: false, error: "status card requires string label" };
      if (typeof input.progress !== "number") return { ok: false, error: "status card requires number progress" };
      if (!isString(input.state) || !JOB_STATUSES.has(input.state)) {
        return { ok: false, error: "status card requires state in queued|running|done|error" };
      }
      break;

    case "agent-activity": {
      const err = checkAgents(input.agents);
      if (err) return { ok: false, error: err };
      break;
    }

    case "choice": {
      const err = checkChoiceOptions(input.options);
      if (err) return { ok: false, error: err };
      break;
    }

    case "approval":
      if (!isString(input.summary)) return { ok: false, error: "approval card requires string summary" };
      if (input.details !== undefined && !isKVPairs(input.details)) {
        return { ok: false, error: "approval details must be an array of {k,v} strings" };
      }
      break;

    case "stat":
      if (!isString(input.value)) return { ok: false, error: "stat card requires string value" };
      if (!isString(input.label)) return { ok: false, error: "stat card requires string label" };
      if (
        input.delta !== undefined &&
        (!isObject(input.delta) ||
          !isString(input.delta.value) ||
          !["up", "down", "flat"].includes(input.delta.dir as string))
      ) {
        return { ok: false, error: "stat delta must be { dir: up|down|flat, value: string }" };
      }
      break;

    case "list": {
      const err = checkListItems(input.items);
      if (err) return { ok: false, error: err };
      break;
    }

    case "image":
      if (!isString(input.src)) return { ok: false, error: "image card requires string src" };
      if (!isSafeCardUrl(input.src)) return { ok: false, error: "image card src must be an http(s), data:image, or relative URL" };
      break;

    case "image-grid": {
      const err = checkImages(input.images);
      if (err) return { ok: false, error: err };
      break;
    }

    case "link":
      if (!isString(input.url)) return { ok: false, error: "link card requires string url" };
      if (!isSafeCardUrl(input.url)) return { ok: false, error: "link card url must be an http(s) or relative URL" };
      if (!isString(input.label)) return { ok: false, error: "link card requires string label" };
      break;

    case "comparison": {
      if (!Array.isArray(input.columns) || !input.columns.every(isString)) {
        return { ok: false, error: "comparison card requires string columns array" };
      }
      const err = checkComparisonRows(input.rows);
      if (err) return { ok: false, error: err };
      break;
    }

    case "keyvalue": {
      const err = checkKeyValueRows(input.rows);
      if (err) return { ok: false, error: err };
      break;
    }

    case "diff": {
      const err = checkDiffHunks(input.hunks);
      if (err) return { ok: false, error: err };
      break;
    }

    default:
      return { ok: false, error: `unknown card type: ${String(type)}` };
  }

  return { ok: true, card: input as unknown as Card };
}

/**
 * Validate a partial card update (`POST /api/talk/card/update`). The patch
 * carries no `type`, so we validate every RECOGNIZED structured field that is
 * present — same per-field rigor as validateCard — so a patch cannot smuggle a
 * malformed `details`/`options`/`hunks`/`rows` shape past the gate after the
 * initial card passed.
 */
export function validateCardPatch(patch: unknown): { ok: true } | { ok: false; error: string } {
  if (!isObject(patch)) return { ok: false, error: "patch must be a non-null object" };

  const STRING_FIELDS = [
    "title", "badge", "body", "tldr", "summary", "value", "label", "url", "src",
    "alt", "caption", "prompt", "source", "confirmLabel", "rejectLabel",
  ];
  for (const f of STRING_FIELDS) {
    if (patch[f] !== undefined && !isString(patch[f])) {
      return { ok: false, error: `patch.${f} must be a string` };
    }
  }
  // A patch has no card type, so validate both possible direct URL fields.
  // Without this, a link/image that passed full-card validation could later be
  // changed to `javascript:` or another unsafe scheme before the web renderer
  // assigns it to an href/src sink.
  for (const f of ["url", "src"] as const) {
    if (typeof patch[f] === "string" && !isSafeCardUrl(patch[f])) {
      return { ok: false, error: `patch.${f} must be an http(s), data:image, or relative URL` };
    }
  }
  if (patch.progress !== undefined && typeof patch.progress !== "number") {
    return { ok: false, error: "patch.progress must be a number" };
  }
  for (const f of ["state", "status"]) {
    const v = patch[f];
    if (v !== undefined && (!isString(v) || !JOB_STATUSES.has(v))) {
      return { ok: false, error: `patch.${f} must be in queued|running|done|error` };
    }
  }
  if (patch.columns !== undefined && !(Array.isArray(patch.columns) && patch.columns.every(isString))) {
    return { ok: false, error: "patch.columns must be a string array" };
  }
  if (patch.details !== undefined && !isKVPairs(patch.details)) {
    return { ok: false, error: "patch.details must be an array of {k,v} strings" };
  }

  // Nested structured arrays — reuse the same checks as full validation.
  if (patch.options !== undefined) {
    const e = checkChoiceOptions(patch.options);
    if (e) return { ok: false, error: e };
  }
  if (patch.hunks !== undefined) {
    const e = checkDiffHunks(patch.hunks);
    if (e) return { ok: false, error: e };
  }
  if (patch.items !== undefined) {
    const e = checkListItems(patch.items);
    if (e) return { ok: false, error: e };
  }
  if (patch.images !== undefined) {
    const e = checkImages(patch.images);
    if (e) return { ok: false, error: e };
  }
  if (patch.agents !== undefined) {
    const e = checkAgents(patch.agents);
    if (e) return { ok: false, error: e };
  }
  // `rows` may be comparison rows (label+cells) OR keyvalue rows (k+v); accept
  // either valid shape, reject otherwise.
  if (patch.rows !== undefined) {
    if (checkComparisonRows(patch.rows) && checkKeyValueRows(patch.rows)) {
      return { ok: false, error: "patch.rows must be valid comparison or keyvalue rows" };
    }
  }

  return { ok: true };
}
