import fs from "node:fs";
import path from "node:path";
import { parseLeaseTransportMeta } from "../../orchestration/lease-meta.js";
import type { Lease } from "../../orchestration/types.js";
import { notifyAttachedTalkSessions } from "../../sessions/callbacks.js";
import {
  cancelQueueItem,
  deleteSession,
  getFilesByIds,
  getSession,
  insertMessage,
  listPendingQueueItems,
  listAllPendingQueueItems,
  listSessions,
  updateSession,
  type QueueItem,
} from "../../sessions/registry.js";
import { FILES_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import { isInterruptibleEngine, type ArchiveKind, type Employee, type Engine, type CuttlefishConfig, type Session } from "../../shared/types.js";
import { maybeEmitTalkGraph } from "../../talk/graph.js";
import { runWebSession } from "../run-web-session.js";
import type { ApiContext } from "./context.js";

export function killSessionEngines(context: ApiContext, session: Session, reason: string): { interruptible: number; killed: number } {
  const engines = new Set<Engine>();
  const primary = context.sessionManager.getEngine(session.engine);
  const pty = context.ptyViewEngines?.[session.engine];
  if (primary) engines.add(primary);
  if (pty) engines.add(pty);

  let interruptible = 0;
  let killed = 0;
  for (const engine of engines) {
    if (!isInterruptibleEngine(engine)) continue;
    interruptible++;
    engine.kill(session.id, reason);
    killed++;
  }
  return { interruptible, killed };
}

export interface ExpiredLeaseSessionInterruptResult {
  leaseId: string;
  sessionId: string | null;
  status: "interrupted" | "unmapped" | "not_running" | "not_interruptible";
  interruptible: boolean;
}

export function interruptExpiredOrchestrationLeaseSessions(
  context: ApiContext,
  leases: Lease[],
  reason = "Interrupted: orchestration lease expired",
): ExpiredLeaseSessionInterruptResult[] {
  const sessions = listSessions();
  return leases.map((lease) => {
    const session = sessions.find((candidate) => parseLeaseTransportMeta(candidate.transportMeta)?.leaseId === lease.leaseId);
    if (!session) {
      return { leaseId: lease.leaseId, sessionId: null, status: "unmapped", interruptible: false };
    }
    if (session.status !== "running") {
      return { leaseId: lease.leaseId, sessionId: session.id, status: "not_running", interruptible: false };
    }
    const stopped = killSessionEngines(context, session, reason);
    if (stopped.interruptible === 0 || stopped.killed === 0) {
      return { leaseId: lease.leaseId, sessionId: session.id, status: "not_interruptible", interruptible: false };
    }
    context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
    updateSession(session.id, { status: "interrupted", lastActivity: new Date().toISOString(), lastError: reason });
    context.emit("session:interrupted", { sessionId: session.id, reason });
    context.emit("session:updated", { sessionId: session.id });
    return { leaseId: lease.leaseId, sessionId: session.id, status: "interrupted", interruptible: true };
  });
}

const ARCHIVE_KINDS = new Set<ArchiveKind>(["room", "scheduled", "chat"]);

export function isArchiveKind(value: unknown): value is ArchiveKind {
  return typeof value === "string" && ARCHIVE_KINDS.has(value as ArchiveKind);
}

export function teardownAndDeleteSession(context: ApiContext, session: Session, reason: string): boolean {
  killSessionEngines(context, session, reason);
  context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
  maybeEmitTalkGraph(session.id, "removed", { getSession, emit: context.emit });
  const deleted = deleteSession(session.id);
  if (deleted) context.emit("session:deleted", { sessionId: session.id });
  return deleted;
}

// Mid_pair reviewer bypass fix: queue-replay and notification dispatch below
// previously called dispatchWebSessionRun directly, skipping the mid_pair
// orchestrator (only a session's first dispatch, at creation, went through
// it). `mid-pair-orchestrator.ts` statically imports dispatchWebSessionRun
// from this file, so a static back-import would be circular — use the
// codebase's established lazy-import pattern instead (same as this file's
// callers use for org.js).
async function resolveDispatchEmployeeForSession(
  session: Session,
  registry?: Map<string, Employee>,
): Promise<Employee | undefined> {
  if (!session.employee || session.parentSessionId) return undefined;
  const orgRegistry = registry ?? (await importScanOrg()).scanOrg();
  return orgRegistry.get(session.employee);
}

function importScanOrg() {
  return import("../org.js");
}

function importDispatchEmployeeSessionRun() {
  return import("../mid-pair-orchestrator.js");
}

export async function resumePendingWebQueueItems(context: ApiContext): Promise<void> {
  if (context.getConfig().sessions?.autoResumeOnBoot !== true) return;

  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  // Memoize once for the whole boot-time replay rather than per item —
  // scanOrg() reads every org YAML from disk.
  const [{ scanOrg }, { dispatchEmployeeSessionRun }] = await Promise.all([
    importScanOrg(),
    importDispatchEmployeeSessionRun(),
  ]);
  const registry = scanOrg();

  let resumed = 0;
  for (const item of pending) {
    const existingSession = getSession(item.sessionId);
    if (!existingSession) {
      cancelQueueItem(item.id);
      continue;
    }
    let session = existingSession;
    if (session.source !== "web") continue;
    session = maybeRevertEngineOverride(session);
    if (context.sessionManager.getQueue().isPaused(item.sessionKey)) continue;

    const config = context.getConfig();
    const engine = context.sessionManager.getEngine(session.engine);
    if (!engine) {
      cancelQueueItem(item.id);
      updateSession(session.id, { status: "error", lastActivity: new Date().toISOString(), lastError: `Engine "${session.engine}" not available` });
      continue;
    }

    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });
    const employee = await resolveDispatchEmployeeForSession(session, registry);
    dispatchEmployeeSessionRun(session, item.prompt, engine, config, context, employee, { queueItemId: item.id });
    resumed++;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
}

export async function redispatchPendingWebQueueItemsForSessionKey(
  context: ApiContext,
  sessionKey: string,
): Promise<number> {
  if (!sessionKey || context.sessionManager.getQueue().isPaused(sessionKey)) return 0;
  if (queueHasScheduled(context, sessionKey)) return 0;

  const pending = listPendingQueueItems(sessionKey);
  if (pending.length === 0) return 0;

  return (await dispatchPendingQueueItem(context, pending[0])) ? 1 : 0;
}

export function dispatchPendingWebQueueHeadForSessionKey(
  context: ApiContext,
  sessionKey: string,
): Promise<number> {
  return redispatchPendingWebQueueItemsForSessionKey(context, sessionKey);
}

function queueHasScheduled(context: ApiContext, sessionKey: string): boolean {
  const queue = context.sessionManager.getQueue();
  return typeof queue.hasScheduled === "function"
    ? queue.hasScheduled(sessionKey)
    : queue.isRunning(sessionKey);
}

async function dispatchPendingQueueItem(context: ApiContext, item: QueueItem): Promise<boolean> {
  const existingSession = getSession(item.sessionId);
  if (!existingSession) {
    cancelQueueItem(item.id);
    return false;
  }
  let session = existingSession;
  if (session.source !== "web") return false;
  session = maybeRevertEngineOverride(session);

  const config = context.getConfig();
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine) {
    cancelQueueItem(item.id);
    updateSession(session.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: `Engine "${session.engine}" not available`,
    });
    return false;
  }

  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });
  const [employee, { dispatchEmployeeSessionRun }] = await Promise.all([
    resolveDispatchEmployeeForSession(session),
    importDispatchEmployeeSessionRun(),
  ]);
  dispatchEmployeeSessionRun(session, item.prompt, engine, config, context, employee, { queueItemId: item.id });
  return true;
}

export function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return session;
  if (until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

export function dispatchWebSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: CuttlefishConfig,
  context: ApiContext,
  opts?: { delayMs?: number; queueItemId?: string; attachments?: string[]; resourceContext?: string | null },
): Promise<void> {
  const run = async () => {
    const sessionKey = session.sessionKey || session.sourceRef;
    // Ledger-0007 Finding 2: bound concurrent turn dispatches gateway-wide.
    // "A run" is one execution of this closure — the same try/finally already
    // brackets every exit path (success, error, the queue's own skip-if-
    // cancelled branch), so acquiring/releasing here covers all of them.
    // Background callers (queue-replay, notifications, mid_pair's own review
    // passes) block via `acquire()` rather than failing fast — there's no
    // synchronous HTTP caller here to return a 429 to.
    const release = context.runSemaphore
      ? await context.runSemaphore.acquire(config.sessions?.maxConcurrentRuns)
      : undefined;
    try {
      await context.sessionManager.getQueue().enqueue(sessionKey, async () => {
        context.emit("session:started", { sessionId: session.id });
        if (opts?.queueItemId) context.emit("queue:updated", { sessionId: session.id, sessionKey });
        await runWebSession(session, prompt, engine, config, context, opts?.attachments, opts?.resourceContext);
      }, opts?.queueItemId);
    } finally {
      release?.();
      if (opts?.queueItemId) context.emit("queue:updated", { sessionId: session.id, sessionKey });
      if (opts?.queueItemId) dispatchPendingWebQueueHeadForSessionKey(context, sessionKey);
    }
  };

  const launch = () => {
    return run().catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Web session ${session.id} dispatch error: ${errMsg}`);
      const erroredOnDispatch = updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      context.emit("session:completed", {
        sessionId: session.id,
        result: null,
        error: errMsg,
      });
      if (erroredOnDispatch) notifyAttachedTalkSessions(erroredOnDispatch, { error: errMsg }, { sink: context.notificationSink });
      maybeEmitTalkGraph(session.id, "completed", { getSession, emit: context.emit });
    });
  };

  if (opts?.delayMs && opts.delayMs > 0) {
    return new Promise((resolve) => {
      setTimeout(() => resolve(launch()), opts.delayMs);
    });
  }
  return launch();
}

export async function dispatchSessionNotification(
  sessionId: string,
  message: string,
  displayMessage: string | undefined,
  context: ApiContext,
): Promise<void> {
  const existingSession = getSession(sessionId);
  if (!existingSession) return;
  const session = maybeRevertEngineOverride(existingSession);
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine) throw new Error(`Engine "${session.engine}" not available`);

  const banner = displayMessage && displayMessage.trim() ? displayMessage : message;
  insertMessage(session.id, "notification", banner);
  context.emit("session:notification", { sessionId: session.id, message: banner });
  context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);
  const [employee, { dispatchEmployeeSessionRun }] = await Promise.all([
    resolveDispatchEmployeeForSession(session),
    importDispatchEmployeeSessionRun(),
  ]);
  dispatchEmployeeSessionRun(session, message, engine, context.getConfig(), context, employee);
}

/** Resolve an array of file IDs to local filesystem paths for engine consumption. */
export function resolveAttachmentPaths(fileIds: unknown): string[] {
  if (!Array.isArray(fileIds)) return [];
  const ids = fileIds.filter((id): id is string => typeof id === "string" && !!id.trim());
  const byId = new Map(getFilesByIds(ids).map((meta) => [meta.id, meta]));
  const paths: string[] = [];
  for (const id of ids) {
    const meta = byId.get(id);
    if (!meta) {
      logger.warn(`Attachment file not found: ${id}`);
      continue;
    }
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (fs.existsSync(filePath)) {
      paths.push(filePath);
    } else if (meta.path && fs.existsSync(meta.path)) {
      paths.push(meta.path);
    } else {
      logger.warn(`Attachment file missing on disk: ${id} (${meta.filename})`);
    }
  }
  return paths;
}
