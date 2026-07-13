import { buildEngineEnv } from "../shared/engine-env.js";

// Aider discovers its model provider through environment variables. Keep this
// exact allowlist separate from host/integration credentials: in particular,
// `TWILIO_*`, gateway tokens, and arbitrary cloud secrets must never reach a
// tool-capable Aider process merely because it needs one provider key.
const AIDER_PROVIDER_SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

export function buildAiderEngineEnv(additions: Record<string, string> = {}): Record<string, string> {
  return buildEngineEnv(additions, {
    allowSecretKeys: AIDER_PROVIDER_SECRET_KEYS,
    stripPrefixes: ["CLAUDECODE", "CLAUDE_CODE_", "CODEX", "CUTTLEFISH_"],
  });
}
