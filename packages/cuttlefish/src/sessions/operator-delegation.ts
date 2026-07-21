import { createHash } from "node:crypto";
import type { Session } from "../shared/types.js";

export const OPERATOR_DELEGATION_SCOPES = ["approve", "decide", "plan", "act"] as const;
export type OperatorDelegationScope = (typeof OPERATOR_DELEGATION_SCOPES)[number];

export interface OperatorDelegationGrant {
  state: "active";
  scopes: OperatorDelegationScope[];
  promptHash: string;
  grantedAt: string;
  grantedBy: string;
}

const PROGRAM_MANAGER_NAME = "program-manager";
const ALLOWED_MODELS = new Set([
  "codex::gpt-5.5",
  "codex::gpt-5.6-sol",
  "claude::claude-opus-4-8",
  "claude::opus",
  "claude::claude-fable-5",
]);

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isHumanDelegationModelAllowed(engine: string, model: string | null | undefined): boolean {
  return ALLOWED_MODELS.has(`${normalize(engine)}::${normalize(model)}`);
}

export function isHumanDelegateRole(employeeName: string | null | undefined, source = "web"): boolean {
  return employeeName === PROGRAM_MANAGER_NAME || (!employeeName && source !== "talk");
}

/**
 * Deliberately strict turn-level syntax. The directive must begin the direct
 * operator message, preventing quoted instructions, child callbacks, fetched
 * content, or an agent-created task body from silently minting authority.
 */
export function parseOperatorDelegationScopes(prompt: string): OperatorDelegationScope[] | null {
  const slash = /^\s*\/delegate-authority\s+([^\n]+)/i.exec(prompt);
  const natural = /^\s*(?:i\s+)?(?:explicitly\s+)?(?:authorize|delegate|grant|give)\s+you(?:\s+authority)?\s+to\s+(.{1,180}?)\s+on\s+my\s+behalf(?:\b|[.:,])/i.exec(prompt);
  const clause = slash?.[1] ?? natural?.[1];
  if (!clause) return null;
  const normalized = clause.toLowerCase();
  const scopes = OPERATOR_DELEGATION_SCOPES.filter((scope) =>
    normalized === "all" || new RegExp(`\\b${scope}(?:e|i)?(?:d|s|ing)?\\b`, "i").test(normalized),
  );
  return scopes.length > 0 ? [...scopes] : null;
}

export function operatorDelegationPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function buildOperatorDelegationGrant(input: {
  prompt: string;
  scopes: OperatorDelegationScope[];
  grantedBy?: string | null;
  now?: string;
}): OperatorDelegationGrant {
  return {
    state: "active",
    scopes: [...input.scopes],
    promptHash: operatorDelegationPromptHash(input.prompt),
    grantedAt: input.now ?? new Date().toISOString(),
    grantedBy: input.grantedBy?.trim() || "operator",
  };
}

export function readOperatorDelegationScopesForTurn(
  session: Pick<Session, "transportMeta">,
  prompt: string,
): OperatorDelegationScope[] {
  const raw = (session.transportMeta as Record<string, unknown> | null)?.operatorDelegation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const grant = raw as Record<string, unknown>;
  if (grant.state !== "active" || grant.promptHash !== operatorDelegationPromptHash(prompt)) return [];
  if (!Array.isArray(grant.scopes)) return [];
  const scopes = grant.scopes as unknown[];
  return OPERATOR_DELEGATION_SCOPES.filter((scope) => scopes.includes(scope));
}

export function readActiveOperatorDelegationScopes(session: Pick<Session, "transportMeta">): OperatorDelegationScope[] {
  const raw = (session.transportMeta as Record<string, unknown> | null)?.operatorDelegation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const grant = raw as Record<string, unknown>;
  if (grant.state !== "active" || !Array.isArray(grant.scopes)) return [];
  const scopes = grant.scopes as unknown[];
  return OPERATOR_DELEGATION_SCOPES.filter((scope) => scopes.includes(scope));
}

export function activeOperatorDelegationMatches(
  session: Pick<Session, "transportMeta">,
  operatorDelegationId: string | undefined,
): boolean {
  if (!operatorDelegationId) return false;
  const raw = (session.transportMeta as Record<string, unknown> | null)?.operatorDelegation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const grant = raw as Record<string, unknown>;
  return grant.state === "active" && grant.promptHash === operatorDelegationId;
}

export function expireOperatorDelegationForPrompt(
  session: Pick<Session, "transportMeta">,
  prompt: string,
  now = new Date().toISOString(),
): Record<string, unknown> | null {
  const raw = (session.transportMeta as Record<string, unknown> | null)?.operatorDelegation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const grant = raw as Record<string, unknown>;
  if (grant.state !== "active" || grant.promptHash !== operatorDelegationPromptHash(prompt)) return null;
  return { ...grant, state: "expired", expiredAt: now };
}
