/**
 * Deny per-employee `cliFlags` that widen the child engine's authority or inject
 * new executables/config (audit A-F2 / F-10, confirmed live in the playtest:
 * onboarding accepted `cliFlags: ["--dangerously-skip-permissions", ...]`).
 *
 * `cliFlags` come from repo/org YAML and are appended to the engine argv AFTER
 * the security flags, so a permission-bypass or `--mcp-config` here escalates the
 * agent's privileges with no explicit trust decision. This policy is applied both
 * at config-load/validation (so a dangerous flag is never persisted) and on the
 * actual spawn path (so a pre-existing config cannot smuggle one through).
 */

/** Exact flag names that must never appear in per-employee cliFlags. */
const DISALLOWED_CLI_FLAGS = new Set<string>([
  "--dangerously-skip-permissions",
  "--mcp-config",
  "--mcp-server",
  "--permission-mode",
  "--permission-prompt-tool",
  "--allowedtools",
  "--disallowedtools",
  "--add-dir",
  "--settings",
  "--yolo",
  "--sandbox-bypass",
]);

/** Any flag beginning with one of these (case-insensitive) is disallowed. */
const DISALLOWED_PREFIXES = ["--dangerously"];

/** Normalize `--flag=value` / `--Flag` to a comparable bare flag token. */
function bareFlag(flag: string): string {
  return flag.split("=")[0].trim().toLowerCase();
}

/** Returns the first disallowed flag in the list, or undefined if all are allowed. */
export function findDisallowedCliFlag(flags: readonly string[]): string | undefined {
  for (const flag of flags) {
    const bare = bareFlag(flag);
    if (DISALLOWED_CLI_FLAGS.has(bare)) return flag;
    if (DISALLOWED_PREFIXES.some((prefix) => bare.startsWith(prefix))) return flag;
  }
  return undefined;
}

/** Drop any disallowed flags (spawn-path defense-in-depth). Returns the kept flags. */
export function stripDisallowedCliFlags(flags: readonly string[]): string[] {
  return flags.filter((flag) => {
    const bare = bareFlag(flag);
    if (DISALLOWED_CLI_FLAGS.has(bare)) return false;
    if (DISALLOWED_PREFIXES.some((prefix) => bare.startsWith(prefix))) return false;
    return true;
  });
}
