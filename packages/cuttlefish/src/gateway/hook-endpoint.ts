import { timingSafeEqual } from "node:crypto";
import type { HookRegistry, HookPayload } from "./hook-registry.js";
import { evaluateCommandPolicy } from "../shared/command-policy.js";
import type { SecurityReviewTrigger } from "../shared/types.js";

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
}

const HOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const seenHookNonces = new Map<string, number>();

function pruneSeenNonces(now: number): void {
  for (const [nonce, expiresAt] of seenHookNonces) {
    if (expiresAt <= now) seenHookNonces.delete(nonce);
  }
}

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
