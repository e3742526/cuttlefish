import type { IPty } from "node-pty";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { stripDisallowedCliFlags } from "../shared/cli-flag-policy.js";

export interface InteractiveArgsOpts {
  prompt: string;
  settingsPath: string;
  resumeSessionId?: string;
  model?: string;
  effortLevel?: string;
  mcpConfigPath?: string;
  cliFlags?: string[];
  attachments?: string[];
  /** Gateway system prompt (persona/org context) + main-agent sentinel, passed via
   *  the CLI `--append-system-prompt` flag. The settings-file `appendSystemPrompt`
   *  KEY is ignored by claude CLI ≥2.1.x, so this flag is the only path that
   *  actually lands it in the request `system` (and thus lets the SSE proxy tee). */
  appendSystemPrompt?: string;
}

export function buildInteractiveArgs(o: InteractiveArgsOpts): string[] {
  const args: string[] = [];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);

  let prompt = o.prompt;
  if (o.attachments?.length) {
    prompt += "\n\nAttached files:\n" + o.attachments.map((a) => `- ${a}`).join("\n");
  }
  args.push(prompt); // positional — MUST precede variadic --mcp-config

  args.push("--chrome");
  if (o.effortLevel && o.effortLevel !== "default") args.push("--effort", o.effortLevel);
  if (o.model) args.push("--model", o.model);
  args.push("--dangerously-skip-permissions");
  args.push("--disallowedTools", "AskUserQuestion", "ExitPlanMode");
  args.push("--settings", o.settingsPath);
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  // Audit A-F2/F-10: defense-in-depth on the actual spawn path — a pre-existing
  // org config cannot smuggle a permission-bypass / config-injection flag past
  // the validation-layer denylist. These flags sit AFTER the security flags above,
  // so an unfiltered one would override them.
  if (o.cliFlags?.length) args.push(...stripDisallowedCliFlags(o.cliFlags));
  if (o.mcpConfigPath) args.push("--mcp-config", o.mcpConfigPath);
  return args;
}

/** Claude Code built-in slash commands that run locally and never produce a new
 *  assistant API turn. Two behaviours, both handled by the native-command path:
 *   - Context mutators (/compact, /clear, /model) end without firing a Stop hook;
 *     the native-command quiet-window timer settles them with an empty result.
 *   - Info/overlay commands (/usage, /limits, /cost, …) DO fire a Stop hook on
 *     dismiss, but its `last_assistant_message` still carries the PREVIOUS turn's
 *     text. Without native classification that stale text was persisted as a new
 *     assistant message — the duplicate-chat-echo bug. native-aware maybeComplete
 *     settles these empty instead.
 *  Only commands that genuinely yield no persistable assistant output belong here:
 *  misclassifying a real-turn command (/init, /review, skill commands) would drop
 *  its answer. */
const NATIVE_CLAUDE_COMMANDS = new Set([
  "/compact", "/clear", "/model",
  "/usage", "/limits", "/cost", "/status", "/config", "/help", "/doctor",
  "/release-notes", "/vim", "/terminal-setup", "/mcp", "/agents", "/permissions",
  "/hooks", "/memory", "/export", "/login", "/logout", "/bug", "/resume",
]);

export function isNativeClaudeCommand(prompt: string): boolean {
  const first = prompt.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return first !== undefined && NATIVE_CLAUDE_COMMANDS.has(first);
}

/** Bracketed-paste `text` into a PTY then submit with CR after a 150ms beat.
 *  Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! —
 *  they still trigger the slash-command / mention / bash-mode handlers and the
 *  turn is never submitted. neutralizeForPaste() prepends a space for mentions,
 *  bash-mode, and cuttlefish-skill slash commands, while letting engine-native commands
 *  (/compact, /clear, /model, …) pass through raw so the TUI actually runs them.
 *  Shared by injectPrompt() (warm-PTY first turn) and writeStdin() (raw WS input). */
export function pasteAndSubmit(proc: Pick<IPty, "write">, text: string): void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~`);
  setTimeout(() => proc.write("\r"), 150);
}
