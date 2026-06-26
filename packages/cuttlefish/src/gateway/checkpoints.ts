import type {
  Approval,
  ApprovalDecision,
  CheckpointOption,
  CheckpointPayload,
  CheckpointResultingAction,
  JsonObject,
  Session,
} from "../shared/types.js";
import { createApproval, getApproval, listApprovals, resolveApproval } from "./approvals.js";
import { getSession, insertMessage, patchSessionTransportMeta, updateSession } from "../sessions/registry.js";
import type { ApiContext } from "./api/context.js";
import { dispatchWebSessionRun } from "./api/session-dispatch.js";
import { emitCheckpointDecisionBestEffort, knowledgeRelayOptions } from "../knowledge/outbox-service.js";
import { logger } from "../shared/logger.js";

const CHECKPOINT_META_KEY = "humanCheckpoint";

function safeTrim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return items.length > 0 ? items : undefined;
}

function optionList(value: unknown): CheckpointOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = new Set<CheckpointOption>(["approved", "rejected", "deferred", "revised"]);
  const items = value.filter((item): item is CheckpointOption => typeof item === "string" && valid.has(item as CheckpointOption));
  return items.length > 0 ? items : undefined;
}

function updateSessionCheckpointMeta(sessionId: string, patch: JsonObject): void {
  patchSessionTransportMeta(sessionId, {
    [CHECKPOINT_META_KEY]: patch,
  });
}

async function exportCheckpointDecision(
  checkpoint: Approval,
  session: Session | undefined,
  context: ApiContext,
): Promise<void> {
  if (!context.knowledgeSink) return;
  try {
    await emitCheckpointDecisionBestEffort({
      checkpoint,
      session,
      sink: context.knowledgeSink,
      ...knowledgeRelayOptions(context.getConfig()),
    });
  } catch (err) {
    logger.warn(`knowledge: failed to export checkpoint decision ${checkpoint.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function listCheckpoints(filter?: { state?: Approval["state"] | "all"; sessionId?: string }): Approval[] {
  return listApprovals({ ...filter, type: "checkpoint" });
}

export function getCheckpoint(id: string): Approval | undefined {
  const approval = getApproval(id);
  return approval?.type === "checkpoint" ? approval : undefined;
}

export function parseCheckpointPayload(body: Record<string, unknown>): CheckpointPayload {
  const decisionNeeded = safeTrim(body.decisionNeeded);
  const why = safeTrim(body.why);
  if (!decisionNeeded) throw new Error("decisionNeeded is required");
  if (!why) throw new Error("why is required");
  return {
    decisionNeeded,
    why,
    ...(stringList(body.affectedFiles) ? { affectedFiles: stringList(body.affectedFiles)! } : {}),
    ...(stringList(body.affectedArtifacts) ? { affectedArtifacts: stringList(body.affectedArtifacts)! } : {}),
    ...(stringList(body.affectedActions) ? { affectedActions: stringList(body.affectedActions)! } : {}),
    ...(optionList(body.options) ? { options: optionList(body.options)! } : { options: ["approved", "rejected", "deferred", "revised"] }),
    ...(safeTrim(body.resumePrompt) ? { resumePrompt: safeTrim(body.resumePrompt) } : {}),
    ...(safeTrim(body.revisePrompt) ? { revisePrompt: safeTrim(body.revisePrompt) } : {}),
  };
}

export function createCheckpoint(input: {
  sessionId: string;
  payload: CheckpointPayload;
  pauseSession?: boolean;
}, context: ApiContext): { checkpoint: Approval; session: Session | undefined } {
  const session = getSession(input.sessionId);
  if (!session) throw new Error(`session ${input.sessionId} not found`);
  const checkpoint = createApproval({
    sessionId: input.sessionId,
    type: "checkpoint",
    payload: input.payload,
  });
  let updated = session;
  if (input.pauseSession !== false) {
    updated = updateSession(session.id, {
      status: "waiting",
      lastActivity: new Date().toISOString(),
      lastError: `Waiting on human checkpoint: ${input.payload.decisionNeeded}`,
    }) ?? session;
    insertMessage(
      session.id,
      "notification",
      `⏸️ Human checkpoint: ${input.payload.decisionNeeded}. ${input.payload.why}`,
    );
    updateSessionCheckpointMeta(session.id, {
      checkpointId: checkpoint.id,
      state: "pending",
      updatedAt: new Date().toISOString(),
    });
    context.emit("session:updated", { sessionId: session.id });
  }
  context.emit("approval:created", { approvalId: checkpoint.id, sessionId: checkpoint.sessionId, type: "checkpoint" });
  context.emit("checkpoint:created", { checkpointId: checkpoint.id, sessionId: checkpoint.sessionId });
  return { checkpoint, session: updated };
}

function decisionPrompt(payload: JsonObject, decision: ApprovalDecision, overridePrompt: string | null): string | null {
  if (overridePrompt) return overridePrompt;
  if (decision === "revised") {
    return safeTrim(payload.revisePrompt) ?? safeTrim(payload.resumePrompt);
  }
  if (decision === "approved") {
    return safeTrim(payload.resumePrompt);
  }
  return null;
}

function defaultResultingAction(
  decision: ApprovalDecision,
  payload: JsonObject,
  overridePrompt: string | null,
): CheckpointResultingAction {
  const prompt = decisionPrompt(payload, decision, overridePrompt);
  if (decision === "rejected") return "stop_session";
  if (decision === "deferred") return "stay_paused";
  if (decision === "revised") return prompt ? "resume_session" : "stay_paused";
  return prompt ? "resume_session" : "record_only";
}

export async function applyCheckpointDecision(
  checkpointId: string,
  input: {
    decision: ApprovalDecision;
    actor?: string | null;
    notes?: string | null;
    resultingAction?: string | null;
    resumePrompt?: string | null;
  },
  context: ApiContext,
): Promise<{ checkpoint: Approval; session?: Session }> {
  const checkpoint = getCheckpoint(checkpointId);
  if (!checkpoint) throw new Error(`checkpoint ${checkpointId} not found`);
  if (checkpoint.state !== "pending") return { checkpoint, session: getSession(checkpoint.sessionId) };

  const prompt = decisionPrompt(checkpoint.payload, input.decision, input.resumePrompt ?? null);
  const resultingAction = (input.resultingAction ?? defaultResultingAction(input.decision, checkpoint.payload, input.resumePrompt ?? null)) as string;

  if (resultingAction === "resume_session") {
    const session = getSession(checkpoint.sessionId);
    if (!session) throw new Error(`session ${checkpoint.sessionId} not found`);
    const engine = context.sessionManager.getEngine(session.engine);
    if (!engine) throw new Error(`Engine "${session.engine}" not available`);
    if (!prompt) throw new Error("resumePrompt is required to resume a revised/approved checkpoint");
  }

  const resolved = resolveApproval(
    checkpoint.id,
    input.decision,
    input.actor ?? null,
    input.notes ?? null,
    resultingAction,
  );

  const session = getSession(resolved.sessionId);
  if (!session) {
    await exportCheckpointDecision(resolved, undefined, context);
    context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: resolved.state });
    context.emit("checkpoint:resolved", { checkpointId: resolved.id, sessionId: resolved.sessionId, state: resolved.state, resultingAction });
    return { checkpoint: resolved };
  }

  if (resultingAction === "resume_session") {
    const engine = context.sessionManager.getEngine(session.engine)!;
    const rolled = updateSession(session.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
      lastError: null,
    }) ?? session;
    updateSessionCheckpointMeta(session.id, {
      checkpointId: resolved.id,
      state: resolved.state,
      updatedAt: new Date().toISOString(),
      resultingAction,
    });
    insertMessage(
      session.id,
      "notification",
      input.decision === "revised"
        ? "📝 Human checkpoint revised the plan. Resuming with human instructions."
        : "✅ Human checkpoint approved. Resuming session.",
    );
    dispatchWebSessionRun(rolled, prompt!, engine, context.getConfig(), context);
    await exportCheckpointDecision(resolved, rolled, context);
    context.emit("session:updated", { sessionId: session.id });
    context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: resolved.state });
    context.emit("checkpoint:resolved", { checkpointId: resolved.id, sessionId: resolved.sessionId, state: resolved.state, resultingAction });
    return { checkpoint: resolved, session: getSession(session.id) ?? rolled };
  }

  if (resultingAction === "stay_paused") {
    const paused = updateSession(session.id, {
      status: "waiting",
      lastActivity: new Date().toISOString(),
      lastError: input.notes ?? `Checkpoint ${input.decision}`,
    }) ?? session;
    insertMessage(
      paused.id,
      "notification",
      input.decision === "deferred"
        ? "⏸️ Human checkpoint deferred. Session remains paused."
        : "📝 Human checkpoint revised the work. Session remains paused until resumed.",
    );
    updateSessionCheckpointMeta(paused.id, {
      checkpointId: resolved.id,
      state: resolved.state,
      updatedAt: new Date().toISOString(),
      resultingAction,
    });
    await exportCheckpointDecision(resolved, paused, context);
    context.emit("session:updated", { sessionId: paused.id });
    context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: resolved.state });
    context.emit("checkpoint:resolved", { checkpointId: resolved.id, sessionId: resolved.sessionId, state: resolved.state, resultingAction });
    return { checkpoint: resolved, session: paused };
  }

  if (resultingAction === "stop_session") {
    const stopped = updateSession(session.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: input.notes ?? "Checkpoint rejected by operator",
    }) ?? session;
    insertMessage(stopped.id, "notification", "🚫 Human checkpoint rejected the proposed action. Session stopped.");
    updateSessionCheckpointMeta(stopped.id, {
      checkpointId: resolved.id,
      state: resolved.state,
      updatedAt: new Date().toISOString(),
      resultingAction,
    });
    await exportCheckpointDecision(resolved, stopped, context);
    context.emit("session:updated", { sessionId: stopped.id });
    context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: resolved.state });
    context.emit("checkpoint:resolved", { checkpointId: resolved.id, sessionId: resolved.sessionId, state: resolved.state, resultingAction });
    return { checkpoint: resolved, session: stopped };
  }

  const recorded = updateSession(session.id, {
    status: session.status === "waiting" ? "idle" : session.status,
    lastActivity: new Date().toISOString(),
    lastError: null,
  }) ?? session;
  updateSessionCheckpointMeta(recorded.id, {
    checkpointId: resolved.id,
    state: resolved.state,
    updatedAt: new Date().toISOString(),
    resultingAction,
  });
  await exportCheckpointDecision(resolved, recorded, context);
  context.emit("session:updated", { sessionId: recorded.id });
  context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: resolved.state });
  context.emit("checkpoint:resolved", { checkpointId: resolved.id, sessionId: resolved.sessionId, state: resolved.state, resultingAction });
  return { checkpoint: resolved, session: recorded };
}
