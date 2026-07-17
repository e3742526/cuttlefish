import fs from "node:fs";

interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  assistantTurns: number;
  /** Most recent assistant line's input context (input + cache tokens). */
  lastContextTokens: number | undefined;
}

// $/million tokens. Conservative defaults.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 15, out: 75 };

function sumTranscriptUsage(content: string): TranscriptUsage {
  const u: TranscriptUsage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, assistantTurns: 0, lastContextTokens: undefined };
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const usage = msg?.message?.usage;
    if (!usage) continue;
    // Context meter: the most recent usage line's input context (input +
    // cache-read + cache-creation) — recorded BEFORE the dedupe skip below,
    // matching the old lastTurnContextTokens (which did not dedupe).
    const ctx = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
    if (ctx > 0) u.lastContextTokens = ctx;
    // Phase 0 finding: --effort high emits two assistant lines per response
    // (thinking + text) with the same message.id and identical usage. Dedupe
    // by message.id so tokens aren't double-counted. Lines without an id are
    // always counted (can't dedupe what we can't key).
    const id = msg?.message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.assistantTurns += 1;
    u.inputTokens += Number(usage.input_tokens ?? 0);
    u.outputTokens += Number(usage.output_tokens ?? 0);
    u.cacheTokens += Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  }
  return u;
}

/** Last assistant text block from a Claude transcript — the turn's final
 *  message. Used to recover result text when the Stop hook (which normally
 *  carries last_assistant_message) was lost (gateway restart deleting
 *  gateway.json mid-turn, PTY crash, or SSE drop), so the parent-session
 *  callback shows real output instead of "(no output)". Exported for tests. */
function transcriptLineTimestampMs(msg: any): number | undefined {
  const raw = msg?.timestamp ?? msg?.created_at ?? msg?.createdAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function lastAssistantTextFromTranscript(transcriptPath: string, afterMs?: number): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let last: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    if (afterMs !== undefined) {
      const ts = transcriptLineTimestampMs(msg);
      if (ts === undefined || ts < afterMs) continue;
    }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
    if (text.trim()) last = text;
  }
  return last;
}

export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<\s*(thinking|reasoning|thought)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/```(?:thinking|reasoning|thought)\b[\s\S]*?```/gi, "")
    .trim();
}

/** Cost + context-meter stats for a settled turn from ONE read of the
 *  transcript. These .jsonl files grow monotonically for the life of a session
 *  (routinely multi-MB); the previous separate cost and context helpers each
 *  re-read and re-split the whole file, doubling the per-turn allocation burst.
 *
 *  NOTE: the transcript accumulates usage for the life of the whole PTY
 *  session, so `cost`/`turns` here are CUMULATIVE totals since the transcript
 *  started, not this turn's share. Callers that report a per-turn value must
 *  use `computeInteractiveTurnStatsSinceAnchor` below instead of reporting
 *  these numbers directly. */
export function computeInteractiveTurnStats(
  transcriptPath: string,
  model?: string,
): { cost: { cost: number; turns: number } | null; contextTokens: number | undefined } | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  const u = sumTranscriptUsage(content);
  let cost: { cost: number; turns: number } | null = null;
  if (u.assistantTurns > 0) {
    const price = (model && MODEL_PRICES[model]) || DEFAULT_PRICE;
    cost = {
      cost: (u.inputTokens / 1_000_000) * price.in + (u.outputTokens / 1_000_000) * price.out,
      turns: u.assistantTurns,
    };
  }
  return { cost, contextTokens: u.lastContextTokens };
}

/** Cumulative cost/turn totals observed at the end of a previous turn — the
 *  anchor point `computeInteractiveTurnStatsSinceAnchor` subtracts from the
 *  transcript's current running totals to recover just this turn's share. */
export interface InteractiveCumulativeStats {
  cost: number;
  turns: number;
}

/** Cost + context-meter stats for a settled turn, reported as the DELTA since
 *  `previousCumulative` rather than the transcript's running total.
 *
 *  `computeInteractiveTurnStats` returns cumulative totals for the whole PTY
 *  session (the transcript .jsonl grows across every turn of that session),
 *  so turn N's raw numbers already include turns 1..N-1. Mirrors the
 *  since-anchor pattern in gateway/external-turns.ts (track what was already
 *  observed, report/persist only what's new, advance the anchor): the caller
 *  keeps the last-seen cumulative snapshot per session and passes it in as
 *  `previousCumulative`; this returns both the per-turn delta to report AND
 *  the new cumulative snapshot to store as the next anchor. */
export function computeInteractiveTurnStatsSinceAnchor(
  transcriptPath: string,
  model: string | undefined,
  previousCumulative: InteractiveCumulativeStats | undefined,
): { cost: { cost: number; turns: number } | null; contextTokens: number | undefined; cumulative: InteractiveCumulativeStats | undefined } | null {
  const stats = computeInteractiveTurnStats(transcriptPath, model);
  if (!stats) return null;
  if (!stats.cost) return { cost: null, contextTokens: stats.contextTokens, cumulative: undefined };
  const prev = previousCumulative ?? { cost: 0, turns: 0 };
  // Clamp at 0: guards a reset transcript (e.g. a new session reusing a stale
  // anchor) from reporting a negative cost/turn count.
  const cost = {
    cost: Math.max(0, stats.cost.cost - prev.cost),
    turns: Math.max(0, stats.cost.turns - prev.turns),
  };
  return { cost, contextTokens: stats.contextTokens, cumulative: { cost: stats.cost.cost, turns: stats.cost.turns } };
}
