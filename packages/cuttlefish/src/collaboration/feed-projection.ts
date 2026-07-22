import type {
  CollaborationFeedItem,
  CollaborationFeedPage,
  CollaborationLane,
  ProjectSummary,
} from "@cuttlefish/contracts";
import type { Employee, Session } from "../shared/types.js";
import { getMessages, listCommunicationEvents } from "../sessions/registry.js";
import type { ProjectGraphEntry } from "./project-graph.js";

interface CursorValue {
  timestamp: number;
  id: string;
}

export function encodeFeedCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeFeedCursor(cursor: string | null | undefined): CursorValue | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorValue>;
    return Number.isFinite(parsed.timestamp) && typeof parsed.id === "string"
      ? { timestamp: Number(parsed.timestamp), id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function employeeLabel(employeeId: string | null | undefined, employees: Map<string, Employee>): string {
  if (!employeeId) return "Cuttlefish";
  return employees.get(employeeId)?.displayName ?? employeeId;
}

function legacyKind(role: string, content: string): CollaborationFeedItem["kind"] {
  if (role === "notification") {
    if (/delegat|assigned|spawned/i.test(content)) return "delegation";
    if (/callback|reported|completed|finished/i.test(content)) return "callback";
    if (/error|failed|interrupted/i.test(content)) return "error";
    return "status";
  }
  return "message";
}

function legacyMessageItem(input: {
  lane: CollaborationLane;
  rootSessionId?: string;
  session: Session;
  message: ReturnType<typeof getMessages>[number];
  sessionsById: Map<string, Session>;
  employees: Map<string, Employee>;
  projectTitle?: string;
}): CollaborationFeedItem {
  const { session, message, sessionsById, employees } = input;
  if (message.role === "assistant") {
    return {
      id: `message:${message.id}`,
      lane: input.lane,
      ...(input.rootSessionId ? { projectRootSessionId: input.rootSessionId } : {}),
      sessionId: session.id,
      kind: legacyKind(message.role, message.content),
      author: session.employee
        ? { kind: "agent", id: session.employee, displayName: employeeLabel(session.employee, employees) }
        : { kind: "system", displayName: "Cuttlefish" },
      recipients: ["operator"],
      content: message.content,
      timestamp: message.timestamp,
      attribution: "recorded",
      ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
    };
  }
  if (message.role === "user" && !session.parentSessionId && session.source === "web") {
    return {
      id: `message:${message.id}`,
      lane: input.lane,
      ...(input.rootSessionId ? { projectRootSessionId: input.rootSessionId } : {}),
      sessionId: session.id,
      kind: "message",
      author: { kind: "operator", id: session.userId ?? undefined, displayName: "You" },
      recipients: session.employee ? [session.employee] : ["cuttlefish"],
      content: message.content,
      timestamp: message.timestamp,
      attribution: "recorded",
      ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
    };
  }
  if (message.role === "user" && session.parentSessionId) {
    const parent = sessionsById.get(session.parentSessionId);
    return {
      id: `message:${message.id}`,
      lane: input.lane,
      ...(input.rootSessionId ? { projectRootSessionId: input.rootSessionId } : {}),
      sessionId: session.id,
      kind: "delegation",
      author: parent?.employee
        ? { kind: "agent", id: parent.employee, displayName: employeeLabel(parent.employee, employees) }
        : { kind: "system", displayName: "System" },
      recipients: session.employee ? [session.employee] : [],
      content: message.content,
      timestamp: message.timestamp,
      attribution: "inferred",
      ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
    };
  }
  return {
    id: `message:${message.id}`,
    lane: input.lane,
    ...(input.rootSessionId ? { projectRootSessionId: input.rootSessionId } : {}),
    sessionId: session.id,
    kind: legacyKind(message.role, message.content),
    author: { kind: "system", displayName: "System" },
    recipients: [],
    content: message.content,
    timestamp: message.timestamp,
    attribution: "inferred",
    ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
  };
}

function paginate(items: CollaborationFeedItem[], cursor: string | null | undefined, limit: number): CollaborationFeedPage {
  const decoded = decodeFeedCursor(cursor);
  const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  const eligible = decoded
    ? sorted.filter((item) => item.timestamp < decoded.timestamp || (item.timestamp === decoded.timestamp && item.id < decoded.id))
    : sorted;
  const page = eligible.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.reverse(),
    nextCursor: eligible.length > page.length && last
      ? encodeFeedCursor({ timestamp: last.timestamp, id: last.id })
      : null,
  };
}

export function projectFeed(input: {
  project: ProjectGraphEntry<Session>;
  employees: Map<string, Employee>;
  cursor?: string | null;
  limit?: number;
  sessionId?: string | null;
}): CollaborationFeedPage {
  const sessionsById = new Map(input.project.sessions.map((session) => [session.id, session]));
  const selectedSessions = input.sessionId
    ? input.project.sessions.filter((session) => session.id === input.sessionId)
    : input.project.sessions;
  const projectTitle = input.project.sessions.find((session) => session.id === input.project.rootSessionId)?.title
    ?? input.project.rootSessionId;
  const events = listCommunicationEvents({
    lane: "team",
    projectRootSessionId: input.project.rootSessionId,
    ...(input.sessionId ? { sessionIds: [input.sessionId] } : {}),
  });
  const referenced = new Set(events.flatMap((event) => event.referencedMessageIds));
  const legacy = selectedSessions.flatMap((session) => getMessages(session.id)
    .filter((message) => !referenced.has(message.id))
    .map((message) => legacyMessageItem({
      lane: "team",
      rootSessionId: input.project.rootSessionId,
      session,
      message,
      sessionsById,
      employees: input.employees,
      projectTitle,
    })));
  return paginate([...legacy, ...events.map(({ referencedMessageIds: _ids, metadata: _metadata, ...event }) => ({ ...event, projectTitle }))], input.cursor, input.limit ?? 100);
}

export function managementFeed(input: {
  sessions: Session[];
  managerIds: Set<string>;
  employees: Map<string, Employee>;
  projectBySessionId: Map<string, ProjectGraphEntry<Session>>;
  cursor?: string | null;
  limit?: number;
  projectRootSessionId?: string | null;
}): CollaborationFeedPage {
  const contextRoot = (session: Session): string | undefined => {
    const value = (session.transportMeta as Record<string, unknown> | null)?.managementProjectRootSessionId;
    return typeof value === "string" ? value : input.projectBySessionId.get(session.id)?.rootSessionId;
  };
  const direct = input.sessions.filter((session) =>
    !session.parentSessionId
    && session.source === "web"
    && ((!session.employee && input.managerIds.has("cuttlefish")) || Boolean(session.employee && input.managerIds.has(session.employee))),
  );
  const selected = input.projectRootSessionId
    ? direct.filter((session) => contextRoot(session) === input.projectRootSessionId)
    : direct;
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
  const events = listCommunicationEvents({ lane: "management" });
  const filteredEvents = input.projectRootSessionId
    ? events.filter((event) => event.projectRootSessionId === input.projectRootSessionId)
    : events;
  const referenced = new Set(filteredEvents.flatMap((event) => event.referencedMessageIds));
  const legacy = selected.flatMap((session) => {
    const rootSessionId = contextRoot(session);
    const project = rootSessionId
      ? [...input.projectBySessionId.values()].find((candidate) => candidate.rootSessionId === rootSessionId)
      : undefined;
    const title = project?.sessions.find((candidate) => candidate.id === project.rootSessionId)?.title ?? undefined;
    return getMessages(session.id)
      .filter((message) => !referenced.has(message.id))
      .map((message) => legacyMessageItem({
        lane: "management",
        rootSessionId,
        session,
        message,
        sessionsById,
        employees: input.employees,
        projectTitle: title,
      }));
  });
  return paginate([...legacy, ...filteredEvents.map(({ referencedMessageIds: _ids, metadata: _metadata, ...event }) => event)], input.cursor, input.limit ?? 100);
}

export function summarizeProject<T extends {
  id: string;
  title?: string | null;
  employee?: string | null;
  lastActivity?: string;
  jobState?: string;
}>(project: ProjectGraphEntry<T>): ProjectSummary {
  const root = project.sessions.find((session) => session.id === project.rootSessionId) ?? project.sessions[0];
  const runningCount = project.sessions.filter((session) => session.jobState === "working").length;
  const needsAttentionCount = project.sessions.filter((session) => session.jobState === "needs_attention").length;
  return {
    rootSessionId: project.rootSessionId,
    title: root?.title?.trim() || root?.id || project.rootSessionId,
    lastActivity: project.sessions[0]?.lastActivity ?? "",
    jobState: needsAttentionCount > 0 ? "needs_attention" : runningCount > 0 ? "working" : root?.jobState ?? "idle",
    sessionCount: project.sessions.length,
    participantIds: [...new Set(project.sessions.flatMap((session) => session.employee ? [session.employee] : []))].sort(),
    integrity: project.integrity,
    runningCount,
    needsAttentionCount,
  };
}
