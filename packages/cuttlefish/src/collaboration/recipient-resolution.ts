import type { ManagementRecipient, ManagementRecipientsResponse } from "@cuttlefish/contracts";
import type { Employee, OrgHierarchy, Session } from "../shared/types.js";
import { chainToRoot } from "../gateway/org-hierarchy.js";

export const COO_RECIPIENT_ID = "cuttlefish";
export const PROGRAM_MANAGER_RECIPIENT_ID = "program-manager";

export function isEmployeeActive(employee: Employee): boolean {
  return employee.lifecycle === undefined || employee.lifecycle === "active" || employee.lifecycle === "probation";
}

export function latestWritableSessionForEmployee(
  sessions: readonly Session[],
  employeeId: string,
): Session | undefined {
  return sessions
    .filter((session) => session.employee === employeeId)
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.id.localeCompare(b.id))[0];
}

export function resolveTeamRecipients(input: {
  requestedIds?: string[];
  recipientMode?: "all";
  confirmAllRecipients?: string[];
  projectSessions: readonly Session[];
  employees: Map<string, Employee>;
}): { recipientIds: string[]; error?: string } {
  const participants = [...new Set(input.projectSessions.flatMap((session) => session.employee ? [session.employee] : []))];
  const allowed = participants.filter((id) => {
    const employee = input.employees.get(id);
    return Boolean(employee && isEmployeeActive(employee) && employee.rank !== "manager" && employee.rank !== "executive");
  });
  const requested = input.recipientMode === "all"
    ? allowed
    : [...new Set((input.requestedIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0) return { recipientIds: [], error: "No active non-manager project recipients were selected" };
  if (input.recipientMode === "all") {
    const confirmed = [...new Set(input.confirmAllRecipients ?? [])].sort();
    const expected = [...allowed].sort();
    if (confirmed.length !== expected.length || confirmed.some((id, index) => id !== expected[index])) {
      return { recipientIds: [], error: "Team @all requires confirmation of the current active non-manager project roster" };
    }
  }
  const invalid = requested.filter((id) => !allowed.includes(id));
  if (invalid.length > 0) {
    return { recipientIds: [], error: `Recipients are not active non-manager participants in this project: ${invalid.join(", ")}` };
  }
  return { recipientIds: requested };
}

export function managementRoster(
  employees: Map<string, Employee>,
  cooDisplayName = "Cuttlefish",
): ManagementRecipient[] {
  const roster: ManagementRecipient[] = [{
    id: COO_RECIPIENT_ID,
    displayName: cooDisplayName,
    rank: "executive",
    active: true,
  }];
  for (const employee of employees.values()) {
    if (employee.rank !== "manager" && employee.rank !== "executive") continue;
    if (employee.name === COO_RECIPIENT_ID) continue;
    roster.push({
      id: employee.name,
      displayName: employee.displayName,
      rank: employee.rank,
      active: isEmployeeActive(employee),
      ...(employee.name === "hr-manager" ? { humanOnly: true } : {}),
    });
  }
  return roster.sort((a, b) => Number(b.active) - Number(a.active) || a.displayName.localeCompare(b.displayName));
}

function commonNearestManager(
  participantIds: string[],
  hierarchy: OrgHierarchy,
): string | undefined {
  const chains = participantIds
    .filter((id) => hierarchy.nodes[id])
    .map((id) => chainToRoot(id, hierarchy).filter((candidate) => hierarchy.nodes[candidate]?.employee.rank === "manager"));
  if (chains.length === 0) return undefined;
  return chains[0].find((candidate) => chains.every((chain) => chain.includes(candidate)));
}

export function resolveManagementRecipients(input: {
  requestedIds?: string[];
  recipientMode?: "all";
  confirmAllRecipients?: string[];
  projectParticipantIds?: string[];
  roster: ManagementRecipient[];
  hierarchy: OrgHierarchy;
}): ManagementRecipientsResponse & { recipientIds: string[]; error?: string } {
  const active = input.roster.filter((recipient) => recipient.active);
  const activeIds = active.map((recipient) => recipient.id);
  if (input.recipientMode === "all") {
    const confirmation = [...new Set(input.confirmAllRecipients ?? [])].sort();
    const expected = [...activeIds].sort();
    if (confirmation.length !== expected.length || confirmation.some((id, index) => id !== expected[index])) {
      return {
        recipients: active,
        recipientIds: [],
        defaultReason: "explicit",
        error: "Management @all requires confirmation of the current active recipient roster",
      };
    }
    return { recipients: active, recipientIds: activeIds, defaultReason: "explicit" };
  }
  const explicit = [...new Set((input.requestedIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (explicit.length > 0) {
    const invalid = explicit.filter((id) => !activeIds.includes(id));
    if (invalid.length > 0) {
      return {
        recipients: active,
        recipientIds: [],
        defaultReason: "explicit",
        error: `Management recipients are unavailable or invalid: ${invalid.join(", ")}`,
      };
    }
    return { recipients: active, recipientIds: explicit, defaultRecipientId: explicit[0], defaultReason: "explicit" };
  }
  const lead = commonNearestManager(input.projectParticipantIds ?? [], input.hierarchy);
  if (lead && activeIds.includes(lead)) {
    return { recipients: active, recipientIds: [lead], defaultRecipientId: lead, defaultReason: "project_lead" };
  }
  if (activeIds.includes(PROGRAM_MANAGER_RECIPIENT_ID)) {
    return {
      recipients: active,
      recipientIds: [PROGRAM_MANAGER_RECIPIENT_ID],
      defaultRecipientId: PROGRAM_MANAGER_RECIPIENT_ID,
      defaultReason: "program_manager",
    };
  }
  return {
    recipients: active,
    recipientIds: [COO_RECIPIENT_ID],
    defaultRecipientId: COO_RECIPIENT_ID,
    defaultReason: "coo",
  };
}

export function latestDirectManagementSession(sessions: readonly Session[], recipientId: string): Session | undefined {
  return sessions
    .filter((session) =>
      !session.parentSessionId
      && session.source === "web"
      && (recipientId === COO_RECIPIENT_ID ? !session.employee : session.employee === recipientId),
    )
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.id.localeCompare(b.id))[0];
}
