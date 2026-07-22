import { ORG_DIR } from "../shared/paths.js";
import { archiveSessionBoardTickets } from "../gateway/board-service.js";
import type { ApiContext } from "../gateway/api/context.js";
import {
  deleteSessionTreeAtomically,
  getSession,
  listSessions,
} from "../sessions/registry.js";
import { clearTalkAttachments } from "../talk/attachments.js";
import { clearTalkMuted } from "../talk/mute-state.js";
import { logger } from "../shared/logger.js";
import { buildProjectGraph } from "./project-graph.js";

export type ProjectDeletionResult =
  | { ok: true; deletedIds: string[]; warning?: string }
  | { ok: false; statusCode: 400 | 404 | 409; error: string; code: string; actualCount?: number; activeSessionIds?: string[] };

export function deleteProjectTree(input: {
  rootSessionId: string;
  expectedTitle: string;
  expectedSessionCount: number;
  confirmation: string;
  context: ApiContext;
}): ProjectDeletionResult {
  const root = getSession(input.rootSessionId);
  if (!root) return { ok: false, statusCode: 404, error: "Project not found", code: "project_not_found" };
  const graph = buildProjectGraph(listSessions());
  const project = graph.projects.find((entry) => entry.rootSessionId === input.rootSessionId);
  if (!project) return { ok: false, statusCode: 404, error: "Project not found", code: "project_not_found" };
  const title = root.title?.trim() || root.id;
  if (input.confirmation !== title) {
    return { ok: false, statusCode: 400, error: `Type the exact project title to confirm deletion: ${title}`, code: "confirmation_mismatch" };
  }
  const result = deleteSessionTreeAtomically({
    rootSessionId: input.rootSessionId,
    expectedTitle: input.expectedTitle,
    expectedSessionCount: input.expectedSessionCount,
  });
  if (!result.ok) {
    if (result.code === "not_found") return { ok: false, statusCode: 404, error: "Project not found", code: "project_not_found" };
    if (result.code === "stale_title") return { ok: false, statusCode: 409, error: "Project title changed; reload before deleting", code: "stale_title" };
    if (result.code === "stale_count") {
      return { ok: false, statusCode: 409, error: "Project session count changed; reload before deleting", code: "stale_count", actualCount: result.actualCount };
    }
    return {
      ok: false,
      statusCode: 409,
      error: "Project cannot be deleted while a session is active or awaiting action",
      code: "project_active",
      activeSessionIds: result.activeSessionIds,
    };
  }
  for (const session of project.sessions) {
    input.context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
    clearTalkMuted(session.id);
    clearTalkAttachments(session.id);
    input.context.emit("session:deleted", { sessionId: session.id });
  }
  try {
    const archived = archiveSessionBoardTickets(ORG_DIR, result.deletedIds);
    for (const department of archived.departments) input.context.emit("board:updated", { department });
    return { ok: true, deletedIds: result.deletedIds };
  } catch (error) {
    const warning = "Project sessions were deleted, but Kanban ticket cleanup failed";
    logger.error(`${warning}: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: true, deletedIds: result.deletedIds, warning };
  }
}

