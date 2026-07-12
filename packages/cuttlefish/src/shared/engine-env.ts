const SECRET_DENYLIST: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCLOUD_SERVICE_KEY",
  "CUTTLEFISH_GATEWAY_TOKEN",
  "CUTTLEFISH_INTERNAL_TOKEN",
]);

const SECRET_PREFIX_DENYLIST = ["TWILIO_"] as const;

export interface EngineEnvOptions {
  stripPrefixes?: string[];
  allowUnsafeTokens?: boolean;
}

export function buildEngineEnv(
  additions: Record<string, string> = {},
  opts: EngineEnvOptions = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!opts.allowUnsafeTokens && (SECRET_DENYLIST.has(key) || SECRET_PREFIX_DENYLIST.some((prefix) => key.startsWith(prefix)))) continue;
    if (opts.stripPrefixes?.some((prefix) => key.startsWith(prefix))) continue;
    result[key] = value;
  }
  return { ...result, ...additions };
}

export const ENGINE_ENV_SECRET_DENYLIST = SECRET_DENYLIST;
