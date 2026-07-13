import type { Employee, OrgHierarchy, OrgNode, Session } from "../shared/types.js";
import { getAllParents } from "../gateway/org-hierarchy.js";

const MAX_ROSTER_LINES = 8;
const PERSONA_EXCERPT_CHARS = 120;
const MAX_ENFORCED_DELEGATIONS = 3;
const MIN_SPECIALTY_MATCHES = 2;
const EXPLICIT_REPORT_MATCH_SCORE = 100;

const STOPWORDS = new Set([
  "about", "above", "after", "agent", "also", "and", "any", "are", "ask", "can",
  "check", "code", "do", "does", "doing", "for", "from", "get", "has", "have",
  "help", "into", "lead", "make", "manager", "need", "needs", "new", "now", "officer",
  "our", "please", "report", "review", "run", "senior", "task", "team", "that",
  "the", "their", "them", "then", "this", "to", "use", "what", "when", "with",
  "work", "worker", "you", "your",
]);

const DOMAIN_ALIASES: Record<string, string[]> = {
  security: ["auth", "authentication", "authorization", "bearer", "credential", "exploit", "secret", "secrets", "token", "vulnerability"],
  compliance: ["approval", "audit", "checkpoint", "governance", "policy", "risk"],
  hr: ["employee", "employees", "hire", "hiring", "human", "onboarding", "org", "personnel", "resources", "steward"],
  personnel: ["employee", "employees", "hire", "hiring", "hr", "human", "onboarding", "resources"],
  qa: ["bug", "break", "breaker", "explorer", "playtest", "quality", "regression", "test", "tests"],
  playtest: ["bug", "break", "breaker", "explorer", "qa", "quality", "regression", "test", "tests"],
  docs: ["documentation", "manual", "readme", "spec"],
};

const CALLBACK_PREFIX_RE = /^(?:📩|⚠️|🔄)?\s*(?:employee|thread)\s+["`]/i;
const EXPLICIT_INLINE_RE = /\b(?:do(?:\s+it)?\s+yourself|don't\s+delegate|do\s+not\s+delegate|do\s+not\s+(?:(?:use|call|create|write|read|modify|run|access)\b[^.!?\n]{0,120}\bdelegate)|no\s+delegation|stay\s+inline|handle\s+inline)\b/i;

type ManagerDelegationEnforcementMeta = {
  promptHash?: unknown;
  childSessionIds?: unknown;
  completedChildSessionIds?: unknown;
  synthesisDispatched?: unknown;
  synthesisDispatchedAt?: unknown;
};

export type ManagerDelegationSynthesisDecision =
  | { tracked: false; shouldDispatch: true; pendingChildSessionIds: [] }
  | { tracked: true; shouldDispatch: false; pendingChildSessionIds: string[]; reason: "waiting_for_children" | "already_dispatched" }
  | { tracked: true; shouldDispatch: true; pendingChildSessionIds: [] };

const activeSynthesisClaims = new Set<string>();

export interface ManagerDelegationTelemetry {
  event: "manager_delegation";
  sessionId: string;
  engine: string;
  employee: string;
  directReportCount: number;
  childSessionsBefore: number;
  childSessionsAfter: number;
  childSessionsSpawned: number;
  delegationAvailable: boolean;
}

export interface ManagerDelegationMatch {
  employee: Employee;
  score: number;
  matchedKeywords: string[];
  prompt: string;
}

export interface ManagerDelegationPlan {
  enforced: boolean;
  reason: string;
  matches: ManagerDelegationMatch[];
}

/**
 * Automatic delegation is intentionally limited to the first task turn.
 *
 * The local control plane can receive an arbitrary later message from a child
 * or another loopback caller without an authenticated message-origin field.
 * Once a manager has responded or received a notification, it can still
 * delegate explicitly, but the gateway must not reinterpret that content as a
 * new operator task and fan it out automatically.
 */
export function isInitialManagerDelegationTurn(messages: ReadonlyArray<{ role: string }>): boolean {
  return !messages.some((message) => message.role === "assistant" || message.role === "notification");
}

export function resolveSupervisedNodes(employeeName: string | undefined, hierarchy?: OrgHierarchy, node?: OrgNode): OrgNode[] {
  if (!employeeName) return [];
  const byName = new Map<string, OrgNode>();

  if (hierarchy) {
    for (const candidate of Object.values(hierarchy.nodes)) {
      if (candidate.parentName === employeeName || getAllParents(candidate.employee.reportsTo).includes(employeeName)) {
        byName.set(candidate.employee.name, candidate);
      }
    }
  }

  for (const reportName of node?.directReports ?? []) {
    const report = hierarchy?.nodes[reportName];
    if (report) byName.set(reportName, report);
  }

  return [...byName.values()].sort((a, b) => {
    const ai = hierarchy?.sorted.indexOf(a.employee.name) ?? -1;
    const bi = hierarchy?.sorted.indexOf(b.employee.name) ?? -1;
    if (ai >= 0 && bi >= 0) return ai - bi;
    return a.employee.name.localeCompare(b.employee.name);
  });
}

export function buildManagerDelegationDiscipline(gatewayUrl: string, employee: Employee, supervisedNodes: OrgNode[]): string | null {
  if (supervisedNodes.length === 0) return null;
  const lines = [
    `## Manager delegation discipline`,
    `You supervise ${supervisedNodes.length} report${supervisedNodes.length === 1 ? "" : "s"}. Before substantive work, decide whether to delegate or stay inline.`,
    `Delegate when the task is multi-domain, has clear specialist matches, benefits from independent verification, or can split into parallel work. Spawn child sessions before doing delegated work inline: \`POST ${gatewayUrl}/api/sessions\` with \`{prompt, employee, parentSessionId}\`.`,
    `Stay inline when the task is trivial, explicitly asks you to do it yourself, has no relevant report, needs one coherent judgment, or delegation would add latency/noise. Do not delegate just to appear managerial.`,
    `If you delegate, tell the user what went to whom, end the turn, then read replies and synthesize. If you do not delegate a plausibly splittable task, state one short reason.`,
    `Direct-report specialties:`,
  ];
  for (const report of supervisedNodes.slice(0, MAX_ROSTER_LINES)) {
    const e = report.employee;
    lines.push(`- \`${e.name}\` ${e.displayName} (${e.rank}, ${e.department}): ${compactPersona(e.persona)}`);
  }
  const remaining = supervisedNodes.length - MAX_ROSTER_LINES;
  if (remaining > 0) lines.push(`- ${remaining} more report${remaining === 1 ? "" : "s"} available via \`GET ${gatewayUrl}/api/org\`.`);
  return lines.join("\n");
}

export function buildManagerDelegationPlan(input: {
  manager: Employee;
  prompt: string;
  supervisedNodes: OrgNode[];
}): ManagerDelegationPlan {
  const prompt = input.prompt.trim();
  if (input.supervisedNodes.length === 0) {
    return { enforced: false, reason: "no direct reports", matches: [] };
  }
  if (!prompt) {
    return { enforced: false, reason: "empty prompt", matches: [] };
  }
  if (isCallbackOrSynthesisPrompt(prompt)) {
    return { enforced: false, reason: "child callback/synthesis turn", matches: [] };
  }
  if (EXPLICIT_INLINE_RE.test(prompt)) {
    return { enforced: false, reason: "operator explicitly requested inline handling", matches: [] };
  }

  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0) {
    return { enforced: false, reason: "no delegation keywords", matches: [] };
  }

  const matches = input.supervisedNodes
    .map((node) => scoreReportMatch(node.employee, prompt, promptTokens, input.manager))
    .filter((match): match is ManagerDelegationMatch => !!match)
    .sort((a, b) => b.score - a.score || a.employee.name.localeCompare(b.employee.name))
    .slice(0, MAX_ENFORCED_DELEGATIONS);

  if (matches.length === 0) {
    return { enforced: false, reason: "no strong direct-report specialty match", matches: [] };
  }
  return {
    enforced: true,
    reason: `matched ${matches.map((m) => m.employee.name).join(", ")}`,
    matches,
  };
}

export function buildManagerDelegationTelemetry(input: {
  sessionId: string;
  engine: string;
  employee?: Employee;
  directReportCount: number;
  childSessionsBefore: number;
  childSessionsAfter: number;
}): ManagerDelegationTelemetry | null {
  if (!input.employee || input.directReportCount <= 0) return null;
  return {
    event: "manager_delegation",
    sessionId: input.sessionId,
    engine: input.engine,
    employee: input.employee.name,
    directReportCount: input.directReportCount,
    childSessionsBefore: input.childSessionsBefore,
    childSessionsAfter: input.childSessionsAfter,
    childSessionsSpawned: Math.max(0, input.childSessionsAfter - input.childSessionsBefore),
    delegationAvailable: true,
  };
}

/**
 * An enforced manager split should synthesize once, after its known direct
 * children settle. Without this barrier every child callback re-runs the
 * manager and can repeat a completed action.
 */
export function resolveManagerDelegationSynthesis(
  session: Pick<Session, "transportMeta">,
  childSessions?: ReadonlyArray<Pick<Session, "id" | "status" | "transportMeta">>,
): ManagerDelegationSynthesisDecision {
  const meta = asRecord(session.transportMeta);
  const enforcement = asRecord(meta?.managerDelegationEnforcement) as ManagerDelegationEnforcementMeta | null;
  const childSessionIds = enforcement && Array.isArray(enforcement.childSessionIds)
    ? enforcement.childSessionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (childSessionIds.length === 0) {
    return { tracked: false, shouldDispatch: true, pendingChildSessionIds: [] };
  }
  if (enforcement?.synthesisDispatched === true) {
    return { tracked: true, shouldDispatch: false, pendingChildSessionIds: [], reason: "already_dispatched" };
  }
  const completedChildSessionIds = new Set(
    Array.isArray(enforcement?.completedChildSessionIds)
      ? enforcement.completedChildSessionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [],
  );
  const pendingChildSessionIds = childSessionIds.filter((id) => !completedChildSessionIds.has(id));
  const livePendingChildSessionIds = pendingManagerDelegationChildren(childSessionIds, childSessions);
  const pending = livePendingChildSessionIds ?? pendingChildSessionIds;
  if (pending.length > 0) {
    return { tracked: true, shouldDispatch: false, pendingChildSessionIds: pending, reason: "waiting_for_children" };
  }
  return { tracked: true, shouldDispatch: true, pendingChildSessionIds: [] };
}

/**
 * Claim a completed manager delegation before dispatch. The durable marker
 * remains the recovery record; this process-local guard closes the window where
 * callback requests overlap or stale metadata arrives after a prior claim.
 */
export function claimManagerDelegationSynthesis(
  sessionId: string,
  transportMeta: Session["transportMeta"],
  childSessions?: ReadonlyArray<Pick<Session, "id" | "status" | "transportMeta">>,
): ManagerDelegationSynthesisDecision {
  const decision = resolveManagerDelegationSynthesis({ transportMeta }, childSessions);
  if (!decision.tracked || !decision.shouldDispatch) return decision;
  const enforcement = asRecord(asRecord(transportMeta)?.managerDelegationEnforcement) as ManagerDelegationEnforcementMeta | null;
  const promptHash = typeof enforcement?.promptHash === "string" ? enforcement.promptHash : "current";
  const claimKey = `${sessionId}:${promptHash}`;
  if (activeSynthesisClaims.has(claimKey)) {
    return { tracked: true, shouldDispatch: false, pendingChildSessionIds: [], reason: "already_dispatched" };
  }
  activeSynthesisClaims.add(claimKey);
  return decision;
}

/** Record an enforced child callback before its notification wakes the parent. */
export function recordManagerDelegationChildCompletion(
  transportMeta: Session["transportMeta"],
  childSessionId: string,
): Session["transportMeta"] {
  const meta = asRecord(transportMeta) ?? {};
  const enforcement = asRecord(meta.managerDelegationEnforcement) as ManagerDelegationEnforcementMeta | null;
  const childSessionIds = enforcement && Array.isArray(enforcement.childSessionIds)
    ? enforcement.childSessionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (!enforcement || !childSessionIds.includes(childSessionId)) return transportMeta;
  const completedChildSessionIds = Array.isArray(enforcement.completedChildSessionIds)
    ? enforcement.completedChildSessionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (completedChildSessionIds.includes(childSessionId)) return transportMeta;
  return {
    ...meta,
    managerDelegationEnforcement: {
      ...enforcement,
      completedChildSessionIds: [...completedChildSessionIds, childSessionId],
    },
  } as Session["transportMeta"];
}

/** Mark the one parent synthesis dispatch for an enforced manager split. */
export function markManagerDelegationSynthesisDispatched(
  transportMeta: Session["transportMeta"],
  now = new Date().toISOString(),
): Session["transportMeta"] {
  const meta = asRecord(transportMeta) ?? {};
  const enforcement = asRecord(meta.managerDelegationEnforcement);
  if (!enforcement) return transportMeta;
  return {
    ...meta,
    managerDelegationEnforcement: {
      ...enforcement,
      synthesisDispatched: true,
      synthesisDispatchedAt: now,
    },
  } as Session["transportMeta"];
}

function pendingManagerDelegationChildren(
  childSessionIds: string[],
  childSessions: ReadonlyArray<Pick<Session, "id" | "status" | "transportMeta">> | undefined,
): string[] | null {
  if (!childSessions) return null;
  const byId = new Map(childSessions.map((child) => [child.id, child]));
  const hasLiveRunEvidence = childSessionIds.some((id) => {
    const child = byId.get(id);
    if (!child) return false;
    if (child.status !== "idle") return true;
    const meta = asRecord(child.transportMeta);
    return typeof meta?.activeRunId === "string" || typeof meta?.latestRunId === "string";
  });
  // Unit-created child sessions do not have a lifecycle record. Once a real
  // child has started, its lifecycle state is a stronger barrier than a stale
  // callback snapshot that may incorrectly list it as complete.
  if (!hasLiveRunEvidence) return null;
  return childSessionIds.filter((id) => {
    const child = byId.get(id);
    if (!child) return false;
    if (child.status === "error" || child.status === "interrupted") return false;
    if (child.status !== "idle") return true;
    const meta = asRecord(child.transportMeta);
    return typeof meta?.activeRunId !== "string" && typeof meta?.latestRunId !== "string";
  });
}

function compactPersona(persona: string): string {
  return persona.replace(/\s+/g, " ").trim().slice(0, PERSONA_EXCERPT_CHARS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isCallbackOrSynthesisPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return CALLBACK_PREFIX_RE.test(trimmed)
    || trimmed.includes("replied in child session")
    || trimmed.includes("To read the full reply:")
    || trimmed.includes("hit an error and could not finish");
}

function scoreReportMatch(
  employee: Employee,
  prompt: string,
  promptTokens: Set<string>,
  manager: Employee,
): ManagerDelegationMatch | null {
  const personaTokens = expandAliases(tokenize(employee.persona));
  const managerTokens = expandAliases(tokenize(`${manager.name} ${manager.displayName} ${manager.department} ${manager.persona}`));
  const matchedSpecialties = new Set<string>();
  for (const token of promptTokens) {
    if (personaTokens.has(token) && !managerTokens.has(token)) {
      matchedSpecialties.add(token);
    }
  }

  const explicitlyRequested = hasExplicitReportReference(employee, prompt);
  if (!explicitlyRequested && matchedSpecialties.size < MIN_SPECIALTY_MATCHES) return null;
  const matchedKeywords = [...matchedSpecialties].sort();

  return {
    employee,
    score: (explicitlyRequested ? EXPLICIT_REPORT_MATCH_SCORE : 0) + matchedKeywords.length,
    matchedKeywords,
    prompt: buildDelegatedPrompt(manager, employee, matchedKeywords, explicitlyRequested),
  };
}

function buildDelegatedPrompt(
  manager: Employee,
  employee: Employee,
  matchedKeywords: string[],
  explicitlyRequested: boolean,
): string {
  const keywordLine = matchedKeywords.length > 0
    ? `Assigned specialty signals: ${matchedKeywords.join(", ")}.`
    : explicitlyRequested
      ? "You were explicitly selected for your specialist role."
      : "Use only your specialist role to assess this assignment.";
  return [
    `Your manager ${manager.displayName} (\`${manager.name}\`) delegated a bounded specialist assignment to you.`,
    keywordLine,
    "",
    "You have not been given the manager's full request or its attached resources. Focus only on your specialty; do not infer unrelated workstreams or request sibling context. If the bounded assignment lacks required facts, name the specific missing facts in your concise findings, risks, and recommended next steps for the manager to synthesize.",
  ].join("\n");
}

function hasExplicitReportReference(employee: Employee, prompt: string): boolean {
  const normalizedPrompt = ` ${normalizeReference(prompt)} `;
  return [employee.name, employee.displayName]
    .map(normalizeReference)
    .filter((reference) => reference.length > 0)
    .some((reference) => normalizedPrompt.includes(` ${reference} `));
}

function normalizeReference(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return new Set();
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => (token.length >= 3 || token === "hr" || token === "qa") && !STOPWORDS.has(token));
  return new Set(tokens);
}

function expandAliases(tokens: Set<string>): Set<string> {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const alias of DOMAIN_ALIASES[token] ?? []) {
      if (!STOPWORDS.has(alias)) expanded.add(alias);
    }
  }
  return expanded;
}
