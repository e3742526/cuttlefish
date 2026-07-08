import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { HookRegistry, HookPayload } from "./hook-registry.js";
import { evaluateCommandPolicy } from "../shared/command-policy.js";
import type { SecurityReviewTrigger } from "../shared/types.js";
import { CUTTLEFISH_HOME, GATEWAY_INFO_FILE } from "../shared/paths.js";

// CF2-101: the engine runs with --dangerously-skip-permissions and only Bash is
// gated above (PreToolUse hard-blocks below) — Write/Edit reach the filesystem
// unchecked, so a prompt-injected agent can self-modify the control plane
// (org roster, config.yaml, cron jobs, skills) with no approval and no audit
// record, and Read can disclose the admin bearer token straight out of
// gateway.json. Deny both at the hook, independent of the sanctioned
// approval-pipeline writers (hr-steward.ts etc.), which never go through the
// agent's own tool calls.
function isInsideControlPlanePath(targetPath: string, root: string): boolean {
  const resolved = path.resolve(targetPath);
  const resolvedRoot = path.resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function controlPlaneWriteRoots(): string[] {
  return [
    path.join(CUTTLEFISH_HOME, "org"),
    path.join(CUTTLEFISH_HOME, "config.yaml"),
    path.join(CUTTLEFISH_HOME, "cron"),
    path.join(CUTTLEFISH_HOME, "skills"),
    GATEWAY_INFO_FILE,
    path.join(CUTTLEFISH_HOME, "secrets"),
  ];
}

function controlPlaneSecretReadRoots(): string[] {
  return [GATEWAY_INFO_FILE, path.join(CUTTLEFISH_HOME, "secrets")];
}

function extractFilePath(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const value = (toolInput as { file_path?: unknown }).file_path;
  return typeof value === "string" && value ? value : null;
}

/** True if a Write/Edit tool call targets a protected control-plane path. */
export function isControlPlaneWriteBlocked(toolName: string | undefined, toolInput: unknown): boolean {
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "NotebookEdit") return false;
  const filePath = extractFilePath(toolInput);
  if (!filePath) return false;
  return controlPlaneWriteRoots().some((root) => isInsideControlPlanePath(filePath, root));
}

/** True if a Read tool call targets a credential-bearing control-plane path. */
export function isControlPlaneSecretReadBlocked(toolName: string | undefined, toolInput: unknown): boolean {
  if (toolName !== "Read") return false;
  const filePath = extractFilePath(toolInput);
  if (!filePath) return false;
  return controlPlaneSecretReadRoots().some((root) => isInsideControlPlanePath(filePath, root));
}

export interface HookSecurityReviewResult {
  action: "allow" | "checkpoint";
  reason?: string;
}

export interface HookEndpointCtx {
  reg: HookRegistry;
  secret: string;
  remoteAddress: string | undefined;
  now?: () => number;
  onSecurityReview?: (input: {
    sessionId: string;
    command: string;
    triggers: SecurityReviewTrigger[];
    reason: string;
  }) => HookSecurityReviewResult | void;
  /**
   * maxToolCalls/maxEstimatedCostUsd were accepted on an employee's execution
   * profile but silently unenforced — no engine exposed a mid-turn interrupt
   * hook. PreToolUse is the one point every tool call already passes through,
   * so it's the natural (if approximate — see the session/turn-boundary note
   * below) enforcement point for maxToolCalls. Returns undefined when the
   * session's employee has no configured cap (the default), in which case no
   * counting or limiting happens at all.
   */
  getMaxToolCalls?: (cuttlefishSessionId: string) => number | undefined;
}

const HOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const seenHookNonces = new Map<string, number>();

function pruneSeenNonces(now: number): void {
  for (const [nonce, expiresAt] of seenHookNonces) {
    if (expiresAt <= now) seenHookNonces.delete(nonce);
  }
}

// Keyed by cuttlefishSessionId. There is no explicit "new turn" hook event
// (only SessionStart/Stop/StopFailure/PreToolUse/PostToolUse), so this counts
// tool calls across the engine session's whole lifetime between a
// SessionStart and its Stop/StopFailure — an approximation of "per run", not
// a precise "per user turn" count.
const toolCallCounts = new Map<string, number>();

/**
 * True if `addr` is a loopback address. Normalizes before comparing: lowercase,
 * strips the IPv4-mapped `::ffff:` prefix, and accepts `::1` plus the whole
 * 127.0.0.0/8 range (not just 127.0.0.1).
 */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  if (a === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

export function handleHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { cuttlefishSessionId?: string; hook?: HookPayload; nonce?: string; timestamp?: number },
): { status: number; body: string } {
  // Loopback check first — defense-in-depth alongside any upstream check.
  if (!isLoopback(ctx.remoteAddress)) {
    return { status: 403, body: "forbidden" };
  }
  // Defense-in-depth: an empty server secret would allow any client (including one
  // sending no header) to pass timingSafeEqual against an empty buffer. The daemon
  // guards against this upstream in api.ts, but make the endpoint safe standalone.
  if (!ctx.secret || ctx.secret.length === 0) {
    return { status: 401, body: "unauthorized" };
  }
  const a = Buffer.from(providedSecret ?? "", "utf-8");
  const b = Buffer.from(ctx.secret, "utf-8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 403, body: "forbidden" };
  }
  if (!body.cuttlefishSessionId || !body.hook?.hook_event_name) {
    return { status: 400, body: "bad request" };
  }
  const now = ctx.now?.() ?? Date.now();
  if (body.timestamp !== undefined) {
    if (typeof body.timestamp !== "number" || !Number.isFinite(body.timestamp) || Math.abs(now - body.timestamp) > HOOK_REPLAY_WINDOW_MS) {
      return { status: 400, body: "stale hook" };
    }
  }
  if (body.nonce !== undefined) {
    if (typeof body.nonce !== "string" || !body.nonce.trim()) {
      return { status: 400, body: "missing nonce" };
    }
    pruneSeenNonces(now);
    const nonceKey = `${body.cuttlefishSessionId}:${body.nonce}`;
    if (seenHookNonces.has(nonceKey)) {
      return { status: 409, body: "hook replay" };
    }
    seenHookNonces.set(nonceKey, now + HOOK_REPLAY_WINDOW_MS);
  }
  if (body.hook.hook_event_name === "SessionStart") {
    toolCallCounts.delete(body.cuttlefishSessionId);
  }
  if (body.hook.hook_event_name === "Stop" || body.hook.hook_event_name === "StopFailure") {
    toolCallCounts.delete(body.cuttlefishSessionId);
  }
  if (body.hook.hook_event_name === "PreToolUse") {
    if (isControlPlaneWriteBlocked(body.hook.tool_name, body.hook.tool_input)) {
      return { status: 451, body: "Refusing to write the Cuttlefish control plane directly — use the approval pipeline (org changes, config, cron, skills)" };
    }
    if (isControlPlaneSecretReadBlocked(body.hook.tool_name, body.hook.tool_input)) {
      return { status: 451, body: "Refusing to read Cuttlefish gateway credentials" };
    }
    const maxToolCalls = ctx.getMaxToolCalls?.(body.cuttlefishSessionId);
    if (maxToolCalls !== undefined) {
      const count = (toolCallCounts.get(body.cuttlefishSessionId) ?? 0) + 1;
      toolCallCounts.set(body.cuttlefishSessionId, count);
      if (count > maxToolCalls) {
        return { status: 451, body: `Tool-call limit (${maxToolCalls}) exceeded for this session's execution profile` };
      }
    }
  }
  if (body.hook.hook_event_name === "PreToolUse" && body.hook.tool_name === "Bash") {
    const input = body.hook.tool_input;
    const command = input && typeof input === "object" && "command" in input
      ? String((input as { command?: unknown }).command ?? "")
      : "";
    const decision = evaluateCommandPolicy(command);
    if (decision.action === "block") {
      return { status: 451, body: decision.reason || "Command blocked by Cuttlefish security policy" };
    }
    if (decision.action === "review") {
      const reviewResult = ctx.onSecurityReview?.({
        sessionId: body.cuttlefishSessionId,
        command,
        triggers: decision.triggers ?? [],
        reason: decision.reason || "Security review required before executing this Bash command",
      });
      if (reviewResult?.action === "allow") {
        ctx.reg.deliver(body.cuttlefishSessionId, body.hook);
        return { status: 200, body: "ok" };
      }
      return {
        status: 451,
        body: reviewResult?.reason || decision.reason || "Security review required before executing this Bash command",
      };
    }
  }
  ctx.reg.deliver(body.cuttlefishSessionId, body.hook);
  return { status: 200, body: "ok" };
}
