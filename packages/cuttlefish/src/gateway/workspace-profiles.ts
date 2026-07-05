import { validateCwd } from "../sessions/session-patch.js";
import type { CuttlefishConfig, WorkspaceProfileConfig } from "../shared/types.js";

export interface WorkspaceProfileSummary {
  id: string;
  label: string;
  cwd?: string;
  employee?: string;
  hasInstructions: boolean;
}

export interface ResolvedWorkspaceProfile extends WorkspaceProfileSummary {
  instructions?: string;
}

export type ResolveWorkspaceProfileResult =
  | { ok: true; profile: ResolvedWorkspaceProfile }
  | { ok: false; status: 400 | 404; error: string };

function cleanString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

function instructionsText(value: WorkspaceProfileConfig["instructions"]): string | undefined {
  if (typeof value === "string") return cleanString(value);
  if (!Array.isArray(value)) return undefined;
  const lines = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function listWorkspaceProfiles(config: CuttlefishConfig): ResolvedWorkspaceProfile[] {
  const raw = config.workspaces?.profiles;
  if (!raw) return [];

  const entries: Array<[string | undefined, WorkspaceProfileConfig]> = Array.isArray(raw)
    ? raw.map((entry) => [entry.id, entry])
    : Object.entries(raw).map(([id, entry]) => [id, entry]);

  const profiles: ResolvedWorkspaceProfile[] = [];
  const seen = new Set<string>();
  for (const [key, entry] of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = cleanString(entry.id) ?? cleanString(key);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const instructions = instructionsText(entry.instructions);
    const label = cleanString(entry.label) ?? id;
    const cwd = cleanString(entry.cwd);
    const employee = cleanString(entry.employee);
    profiles.push({
      id,
      label,
      ...(cwd ? { cwd } : {}),
      ...(employee ? { employee } : {}),
      hasInstructions: Boolean(instructions),
      ...(instructions ? { instructions } : {}),
    });
  }
  return profiles.sort((a, b) => a.label.localeCompare(b.label));
}

export function summarizeWorkspaceProfiles(config: CuttlefishConfig): WorkspaceProfileSummary[] {
  return listWorkspaceProfiles(config).map(({ instructions: _instructions, ...summary }) => summary);
}

export function resolveWorkspaceProfile(
  config: CuttlefishConfig,
  requested: unknown,
): ResolveWorkspaceProfileResult {
  const id = cleanString(requested);
  if (!id) return { ok: false, status: 400, error: "workspaceProfile must be a non-empty string" };
  const profile = listWorkspaceProfiles(config).find((entry) => entry.id === id);
  if (!profile) return { ok: false, status: 404, error: `workspace profile "${id}" was not found` };
  if (profile.cwd) {
    const cwd = validateCwd(profile.cwd, { roots: config.workspaces?.roots });
    if (!cwd.ok) {
      return { ok: false, status: 400, error: `workspace profile "${id}" has invalid cwd: ${cwd.error ?? "invalid cwd"}` };
    }
    profile.cwd = cwd.cwd;
  }
  return { ok: true, profile };
}

export function buildWorkspaceProfilePrompt(profile: ResolvedWorkspaceProfile, prompt: string): string {
  if (!profile.instructions) return prompt;
  return [
    "## Workspace profile",
    "",
    `Profile: ${profile.label} (${profile.id})`,
    profile.cwd ? `Repository: ${profile.cwd}` : null,
    "",
    "### Standing instructions",
    profile.instructions,
    "",
    "### Operator request",
    prompt,
  ].filter((line): line is string => line !== null).join("\n");
}
