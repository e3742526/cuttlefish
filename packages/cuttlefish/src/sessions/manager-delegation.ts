import type { Employee, OrgHierarchy, OrgNode } from "../shared/types.js";
import { getAllParents } from "../gateway/org-hierarchy.js";

const MAX_ROSTER_LINES = 8;
const PERSONA_EXCERPT_CHARS = 120;

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
