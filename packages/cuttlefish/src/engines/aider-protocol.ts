import fs from "node:fs";
import path from "node:path";
import type { StreamDelta } from "../shared/types.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";

/**
 * Helpers for the Aider PTY view engine. Aider writes a per-conversation markdown
 * transcript (`--chat-history-file`); we assign each Cuttlefish session its own file so
 * there is no transcript-discovery race (unlike codex/antigravity). Tailing that file
 * gives us turn boundaries and the assistant text.
 *
 * Aider history format (per exchange):
 *   # aider chat started at ...        ← header (ignored)
 *   #### <user prompt, one #### line per prompt line>
 *   <assistant prose, plain markdown, multiple lines>
 *   > Tokens: 1.2k sent, 345 received. Cost: ...   ← aider status blockquotes
 *   > Applied edit to foo.py
 */

const AIDER_HISTORY_DIR = "aider-history";

/** Deterministic per-session chat-history file path under CUTTLEFISH_HOME. */
export function aiderHistoryPathFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(CUTTLEFISH_HOME, AIDER_HISTORY_DIR, `${safe}.md`);
}

/** Ensure the directory for a session's chat-history file exists. */
export function ensureAiderHistoryDir(sessionId: string): string {
  const file = aiderHistoryPathFor(sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* best-effort — aider will also create it */
  }
  return file;
}

export interface AiderParsedLine {
  /** StreamDeltas to forward to the chat pane. */
  deltas: StreamDelta[];
  /** This line starts a user turn (aider prefixes prompt lines with "#### "). */
  userTurn?: boolean;
  /** Assistant prose contributed by this line (accumulate for the final answer). */
  assistantText?: string;
  /** Aider's end-of-turn usage blockquote ("> Tokens: …"). Strong done signal. */
  tokensLine?: boolean;
}

/**
 * Classify a single appended history line. Pure + side-effect free for testability.
 * - "#### …"   → user prompt echo (turn start); not surfaced as assistant output.
 * - "# …"      → section header; ignored.
 * - "> …"      → aider status blockquote; surfaced as a `status` delta. "> Tokens:"
 *               additionally flags end-of-turn.
 * - otherwise  → assistant prose; surfaced as a `text` delta.
 */
export function parseAiderHistoryLine(line: string): AiderParsedLine {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed.trim()) return { deltas: [] };

  if (trimmed.startsWith("#### ")) return { deltas: [], userTurn: true };
  if (trimmed === "####") return { deltas: [], userTurn: true };
  if (trimmed.startsWith("# ")) return { deltas: [] };

  if (trimmed.startsWith("> ")) {
    const status = trimmed.slice(2).trim();
    const tokensLine = /^Tokens:/i.test(status);
    return {
      deltas: status ? [{ type: "status", content: status }] : [],
      ...(tokensLine ? { tokensLine: true } : {}),
    };
  }

  return { deltas: [{ type: "text", content: `${trimmed}\n` }], assistantText: `${trimmed}\n` };
}

/**
 * Extract just the assistant prose from a slice of aider's chat-history markdown
 * (drops the `#### ` user echo, `# ` headers, and `> ` status blockquotes). Used by
 * the headless engine to turn a turn's history append into a clean result, instead of
 * capturing aider's noisy stdout chrome.
 */
export function extractAssistantText(appended: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of appended.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const isFence = line.trimStart().startsWith("```");
    if (inFence) {
      // Inside a code block, keep every line verbatim (indentation, `#` comments, and
      // `>` redirects must survive) until the closing fence.
      out.push(`${line}\n`);
      if (isFence) inFence = false;
      continue;
    }
    if (isFence) {
      out.push(`${line}\n`);
      inFence = true;
      continue;
    }
    const parsed = parseAiderHistoryLine(line);
    if (parsed.assistantText) out.push(parsed.assistantText);
  }
  return out.join("").trim();
}
