import type { Employee, OrgHierarchy, OrgNode } from "../shared/types.js";
import { getAllParents } from "../gateway/org-hierarchy.js";

const MAX_ROSTER_LINES = 8;
const PERSONA_EXCERPT_CHARS = 120;
const MAX_ENFORCED_DELEGATIONS = 3;
const MIN_MATCH_SCORE = 3;

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
const EXPLICIT_INLINE_RE = /\b(?:do(?:\s+it)?\s+yourself|don't\s+delegate|do\s+not\s+delegate|no\s+delegation|stay\s+inline|handle\s+inline)\b/i;

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
    .filter((match): match is ManagerDelegationMatch => !!match && match.score >= MIN_MATCH_SCORE)
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

function compactPersona(persona: string): string {
  return persona.replace(/\s+/g, " ").trim().slice(0, PERSONA_EXCERPT_CHARS);
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
  const identityText = [
    employee.name,
    employee.displayName,
    employee.department,
  ].join(" ");
  const identityTokens = expandAliases(tokenize(identityText));
  const personaTokens = expandAliases(tokenize(employee.persona));
  const managerTokens = expandAliases(tokenize(`${manager.name} ${manager.displayName} ${manager.department} ${manager.persona}`));

  let score = 0;
  const matched = new Set<string>();
  for (const token of promptTokens) {
    if (identityTokens.has(token)) {
      score += 3;
      matched.add(token);
      continue;
    }
    if (personaTokens.has(token) && !managerTokens.has(token)) {
      score += 1;
      matched.add(token);
    }
  }

  const explicitName = employee.name && prompt.toLowerCase().includes(employee.name.toLowerCase());
  if (explicitName) score += 6;
  if (score < MIN_MATCH_SCORE) return null;

  return {
    employee,
    score,
    matchedKeywords: [...matched].sort(),
    prompt: buildDelegatedPrompt(manager, employee, prompt, [...matched].sort()),
  };
}

function buildDelegatedPrompt(manager: Employee, employee: Employee, originalPrompt: string, matchedKeywords: string[]): string {
  const keywordLine = matchedKeywords.length > 0
    ? `Matched specialty keywords: ${matchedKeywords.join(", ")}.`
    : "Matched by direct report specialty.";
  return [
    `Your manager ${manager.displayName} (\`${manager.name}\`) delegated the specialist slice of this task to you.`,
    keywordLine,
    "",
    "Focus only on the part of the task that fits your specialty. Do not take over unrelated domains. Return concise findings, risks, and recommended next steps for your manager to synthesize.",
    "",
    "Original task:",
    originalPrompt,
  ].join("\n");
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
