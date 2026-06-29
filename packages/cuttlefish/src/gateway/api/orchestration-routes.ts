import fs from "node:fs";
import { selectDualLaneWinner } from "../../orchestration/dual-lane.js";
import { applyDualLaneWinner, listArtifactContents } from "../../orchestration/artifacts.js";
import { listDualLaneManifests } from "../../orchestration/dual-lane-state.js";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { listSessions, updateSession } from "../../sessions/registry.js";
import type { Session } from "../../shared/types.js";
import { authorizeManagerScope, employeeNamesForOrgWorkerIds } from "../manager-auth.js";
import { parseLeaseTransportMeta } from "../../orchestration/lease-meta.js";
import { loadDefaultOrchestrationConfig, loadOrchestrationConfig } from "../../orchestration/config.js";
import { liveRunModeSchema, runOrchestrationTask } from "../../orchestration/run-mode.js";
import type { OrchestrationRuntime } from "../../orchestration/runtime.js";
import { formatZodError } from "../../orchestration/schemas.js";
import { PersistentMatrixScheduler } from "../../orchestration/persistent-scheduler.js";
import { OrchestrationStore, type ArtifactKind } from "../../orchestration/store.js";
import { requeueRecoveredContinuation } from "../../orchestration/recovery-requeue.js";
import { listRecoveryNotices } from "../../orchestration/store-recovery.js";
import { CUTTLEFISH_HOME, ORCH_DB, ORCH_RECOVERY_DIR } from "../../shared/paths.js";
import { authenticateGatewayRequest } from "../auth.js";
import { readOrchestrationTelemetry, summarizeOrchestrationTelemetry } from "../../orchestration/telemetry.js";
import { listManagedWorktrees, resolveWorktreeOptions } from "../../orchestration/worktree.js";
import { scanOrg } from "../org.js";
import { readJsonBody } from "../http-helpers.js";
import type { ApiContext } from "./context.js";
import { matchRoute } from "./match-route.js";
import { json } from "./responses.js";
import { killSessionEngines } from "./session-dispatch.js";

const DASHBOARD_TELEMETRY_MAX_BYTES = 1_000_000;
const DASHBOARD_TELEMETRY_MAX_RECORDS = 5_000;

const ROUTES = new Set([
  "/api/orchestration/status",
  "/api/orchestration/workers",
  "/api/orchestration/leases",
  "/api/orchestration/queue",
  "/api/orchestration/allocations",
  "/api/orchestration/continuations",
  "/api/orchestration/telemetry/summary",
  "/api/orchestration/worktrees",
  "/api/orchestration/dual-lane",
  "/api/orchestration/queue/pause",
  "/api/orchestration/queue/resume",
  "/api/orchestration/queue/pause-task",
  "/api/orchestration/queue/resume-task",
  "/api/orchestration/holds",
  "/api/orchestration/leases/stop",
  "/api/orchestration/continuations/retry",
  "/api/orchestration/dual-lane/select",
  "/api/orchestration/dual-lane/apply",
  "/api/orchestration/recovery/requeue",
  "/api/orchestration/run",
]);

export async function handleOrchestrationRoutes(
  method: string,
  pathname: string,
  res: ServerResponse,
  context: ApiContext,
  req?: HttpRequest,
): Promise<boolean> {
  const holdExtendParams = matchRoute("/api/orchestration/holds/:id/extend", pathname);
  const holdCancelParams = matchRoute("/api/orchestration/holds/:id/cancel", pathname);
  const artifactParams = matchRoute("/api/orchestration/artifacts/:taskId/:kind", pathname);
  if (!ROUTES.has(pathname) && !holdExtendParams && !holdCancelParams && !artifactParams) return false;
  if (pathname === "/api/orchestration/queue/pause") {
    const runtime = requireLiveRuntime(method, res, context);
    if (!runtime) return true;
    const parsed = req ? await readJsonBody(req, res, { allowEmpty: true }) : { ok: true as const, body: null };
    if (!parsed.ok) return true;
    const body = parsed.body as { reason?: unknown } | null;
    json(res, { controlState: runtime.pauseQueue(typeof body?.reason === "string" ? body.reason : undefined) }, 200);
    return true;
  }
  if (pathname === "/api/orchestration/queue/resume") {
    const runtime = requireLiveRuntime(method, res, context);
    if (!runtime) return true;
    const result = await runtime.resumeQueue();
    json(res, { controlState: result.controlState, retried: result.retryResults.filter((entry) => entry.ok).length }, 202);
    return true;
  }
  if (pathname === "/api/orchestration/queue/pause-task") {
    const runtime = requireLiveRuntime(method, res, context);
    if (!runtime) return true;
    const parsed = req ? await readJsonBody(req, res) : { ok: false as const };
    if (!parsed.ok) return true;
    const body = parsed.body as { taskId?: unknown; coordinatorId?: unknown; reason?: unknown; managerName?: unknown } | null;
    if (typeof body?.taskId !== "string" || typeof body?.coordinatorId !== "string") {
      json(res, { error: "taskId and coordinatorId are required" }, 400);
      return true;
    }
    json(res, {
      pause: runtime.pauseTask(body.taskId, body.coordinatorId, {
        reason: typeof body.reason === "string" ? body.reason : undefined,
        managerName: typeof body.managerName === "string" ? body.managerName : undefined,
      }),
    }, 200);
    return true;
  }
  if (pathname === "/api/orchestration/queue/resume-task") {
    const runtime = requireLiveRuntime(method, res, context);
    if (!runtime) return true;
    const parsed = req ? await readJsonBody(req, res) : { ok: false as const };
    if (!parsed.ok) return true;
    const body = parsed.body as { taskId?: unknown; coordinatorId?: unknown } | null;
    if (typeof body?.taskId !== "string" || typeof body?.coordinatorId !== "string") {
      json(res, { error: "taskId and coordinatorId are required" }, 400);
      return true;
    }
    const result = await runtime.resumeTask(body.taskId, body.coordinatorId);
    json(res, { resumed: result.paused, retried: result.retryResults.filter((entry) => entry.ok).length }, 202);
    return true;
  }
  if (pathname === "/api/orchestration/holds" && method === "POST") {
    const runtime = requireLiveRuntime(method, res, context);
    if (!runtime) return true;
    const parsed = req ? await readJsonBody(req, res) : { ok: false as const };
    if (!parsed.ok) return true;
    const body = parsed.body as {
      managerName?: unknown;
      roles?: unknown;
      workerIds?: unknown;
      taskId?: unknown;
      coordinatorId?: unknown;
      reason?: unknown;
      ttlMs?: unknown;
    } | null;
    const managerName = typeof body?.managerName === "string" ? body.managerName.trim() : "";
    if (!managerName) {
      json(res, { error: "managerName is required" }, 400);
      return true;
    }
    const workerIds = parseStringArray(body?.workerIds);
    const roles = parseStringArray(body?.roles);
    const auth = authorizeHoldManager(managerName, workerIds, context);
    if (!auth.ok) {
      json(res, { error: auth.error }, 403);
      return true;
    }
    if (workerIds.length === 0 && roles.length === 0) {
      json(res, { error: "at least one role or workerId is required" }, 400);
      return true;
    }
    const ttlMs = typeof body?.ttlMs === "number" && Number.isFinite(body.ttlMs) ? body.ttlMs : 60 * 60 * 1000;
    const hold = runtime.createHold({
      managerName,
      roles,
      workerIds,
      taskId: typeof body?.taskId === "string" ? body.taskId : undefined,
      coordinatorId: typeof body?.coordinatorId === "string" ? body.coordinatorId : undefined,
      reason: typeof body?.reason === "string" ? body.reason : undefined,
      ttlMs,
    });
    json(res, { hold }, 201);
    return true;
  }
  if ((holdExtendParams || holdCancelParams) && method === "POST") {
    const runtime = requireLiveRuntime(method, res, context);
    if (!runtime) return true;
    const parsed = req ? await readJsonBody(req, res, { allowEmpty: true }) : { ok: true as const, body: null };
    if (!parsed.ok) return true;
    const body = parsed.body as { managerName?: unknown; ttlMs?: unknown } | null;
    const managerName = typeof body?.managerName === "string" ? body.managerName.trim() : "";
    if (!managerName) {
      json(res, { error: "managerName is required" }, 400);
      return true;
    }
    const current = runtime.listHolds({ includeInactive: true }).find((hold) => hold.holdId === (holdExtendParams?.id ?? holdCancelParams?.id));
    if (!current) {
      json(res, { error: "hold not found" }, 404);
      return true;
    }
    const auth = authorizeHoldManager(managerName, current.workerIds, context);
    if (!auth.ok || current.managerName !== managerName) {
      json(res, { error: auth.ok ? "hold can only be changed by its manager" : auth.error }, 403);
      return true;
    }
    if (holdExtendParams) {
      const ttlMs = typeof body?.ttlMs === "number" && Number.isFinite(body.ttlMs) ? body.ttlMs : 60 * 60 * 1000;
      const hold = runtime.extendHold(holdExtendParams.id, ttlMs);
      json(res, { hold }, hold?.state === "active" ? 200 : 409);
      return true;
    }
    const hold = runtime.cancelHold(holdCancelParams!.id);
    json(res, { hold }, hold ? 200 : 404);
    return true;
  }
  if (pathname === "/api/orchestration/leases/stop") {
    const runtime = requireLiveRuntime(method, res, context);
    if (!runtime) return true;
    if (!req) {
      json(res, { error: "lease stop requires an HTTP request body" }, 400);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as { leaseId?: unknown; reason?: unknown } | null;
    if (typeof body?.leaseId !== "string" || !body.leaseId.trim()) {
      json(res, { error: "leaseId is required" }, 400);
      return true;
    }
    jsonLeaseStop(res, context, runtime, body.leaseId, typeof body.reason === "string" ? body.reason : undefined);
    return true;
  }
  if (pathname === "/api/orchestration/dual-lane/select") {
    if (method !== "POST") {
      json(res, { error: "Method not allowed" }, 405);
      return true;
    }
    if (context.getConfig().orchestration?.enabled !== true) {
      json(res, { error: "orchestration is disabled" }, 409);
      return true;
    }
    if (!req) {
      json(res, { error: "dual-lane selection requires an HTTP request body" }, 400);
      return true;
    }
    if (!requireOrchestrationMutationAuth(req, res, context)) return true;
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as { taskId?: unknown; coordinatorId?: unknown; winnerLane?: unknown } | null;
    if (typeof body?.taskId !== "string" || typeof body?.coordinatorId !== "string" || typeof body?.winnerLane !== "string") {
      json(res, { error: "taskId, coordinatorId, and winnerLane are required" }, 400);
      return true;
    }
    const result = selectDualLaneWinner({
      taskId: body.taskId,
      coordinatorId: body.coordinatorId,
      winnerLane: body.winnerLane,
    });
    if (!result.ok) {
      json(res, { error: result.message }, result.reason === "not_found" ? 404 : 409);
      return true;
    }
    json(res, result, 200);
    return true;
  }
  if (pathname === "/api/orchestration/dual-lane/apply") {
    if (method !== "POST") {
      json(res, { error: "Method not allowed" }, 405);
      return true;
    }
    if (context.getConfig().orchestration?.enabled !== true) {
      json(res, { error: "orchestration is disabled" }, 409);
      return true;
    }
    if (!req) {
      json(res, { error: "dual-lane apply requires an HTTP request body" }, 400);
      return true;
    }
    if (!requireOrchestrationMutationAuth(req, res, context)) return true;
    const parsed = req ? await readJsonBody(req, res) : { ok: false as const };
    if (!parsed.ok) return true;
    const body = parsed.body as { taskId?: unknown; coordinatorId?: unknown; winnerLane?: unknown } | null;
    if (typeof body?.taskId !== "string" || typeof body?.coordinatorId !== "string" || typeof body?.winnerLane !== "string") {
      json(res, { error: "taskId, coordinatorId, and winnerLane are required" }, 400);
      return true;
    }
    const store = context.orchestration?.runtime?.getStore() ?? openFallbackStore(context);
    try {
      const result = applyDualLaneWinner({
        taskId: body.taskId,
        coordinatorId: body.coordinatorId,
        winnerLane: body.winnerLane,
        store,
      });
      if (!result.ok) {
        json(res, { error: result.message, reason: result.reason }, result.reason === "not_found" ? 404 : 409);
        return true;
      }
      json(res, result, 202);
      return true;
    } finally {
      if (!context.orchestration?.runtime) store.close();
    }
  }
  if (pathname === "/api/orchestration/continuations/retry") {
    if (method !== "POST") {
      json(res, { error: "Method not allowed" }, 405);
      return true;
    }
    if (context.getConfig().orchestration?.enabled !== true) {
      json(res, { error: "orchestration is disabled" }, 409);
      return true;
    }
    const runtime = context.orchestration?.runtime;
    if (!runtime) {
      json(res, { error: "orchestration runtime is not enabled" }, 409);
      return true;
    }
    if (!req) {
      json(res, { error: "continuation retry requires an HTTP request body" }, 400);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as { taskId?: unknown; coordinatorId?: unknown } | null;
    if (typeof body?.taskId !== "string" || typeof body?.coordinatorId !== "string") {
      json(res, { error: "taskId and coordinatorId are required" }, 400);
      return true;
    }
    const result = await runtime.retryFailedLiveContinuation(body.taskId, body.coordinatorId);
    if (!result.ok) {
      json(res, { error: result.message }, result.reason === "not_found" ? 404 : 409);
      return true;
    }
    json(res, result, result.state === "dispatching" ? 202 : 409);
    return true;
  }
  if (pathname === "/api/orchestration/recovery/requeue") {
    const runtime = requireLiveRuntime(method, res, context);
    if (!runtime) return true;
    const parsed = req ? await readJsonBody(req, res) : { ok: false as const };
    if (!parsed.ok) return true;
    const body = parsed.body as { manifestPath?: unknown; taskId?: unknown; coordinatorId?: unknown; managerName?: unknown } | null;
    if (typeof body?.manifestPath !== "string" || typeof body?.taskId !== "string" || typeof body?.coordinatorId !== "string" || typeof body?.managerName !== "string") {
      json(res, { error: "manifestPath, taskId, coordinatorId, and managerName are required" }, 400);
      return true;
    }
    const auth = authorizeManagerScope(scanOrg(), body.managerName, [], context.getConfig().portal?.portalName);
    if (!auth.ok) {
      json(res, { error: auth.error }, 403);
      return true;
    }
    const result = requeueRecoveredContinuation({
      manifestPath: body.manifestPath,
      taskId: body.taskId,
      coordinatorId: body.coordinatorId,
      managerName: body.managerName,
      store: runtime.getStore(),
      recoveryDir: context.orchestration?.recoveryDir ?? ORCH_RECOVERY_DIR,
    });
    if (!result.ok) {
      json(res, { error: result.message, reason: result.reason }, result.reason === "manifest_not_found" || result.reason === "continuation_not_found" ? 404 : 409);
      return true;
    }
    json(res, result, 202);
    return true;
  }
  if (pathname === "/api/orchestration/run") {
    if (method !== "POST") {
      json(res, { error: "Method not allowed" }, 405);
      return true;
    }
    if (context.getConfig().orchestration?.enabled !== true) {
      json(res, { error: "orchestration is disabled" }, 409);
      return true;
    }
    if (!req) {
      json(res, { error: "orchestration run requires an HTTP request body" }, 400);
      return true;
    }
    if (!requireOrchestrationMutationAuth(req, res, context)) return true;
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as { mode?: unknown; task?: unknown } | null;
    try {
      const result = await runOrchestrationTask({
        context,
        mode: typeof body?.mode === "string" ? liveRunModeSchema.parse(body.mode) : undefined,
        task: body?.task,
      });
      json(res, result, result.ok ? 200 : (result.state === "failed" ? 500 : 409));
    } catch (err) {
      json(res, { error: "orchestration run failed", detail: formatZodError(err) }, 400);
    }
    return true;
  }
  if (method !== "GET") {
    json(res, { error: "Method not allowed" }, 405);
    return true;
  }

  try {
    const runtime = context.orchestration?.runtime;
    if (pathname === "/api/orchestration/status") {
      json(res, buildStatusPayload(context, runtime));
      return true;
    }
    if (pathname === "/api/orchestration/telemetry/summary") {
      const read = readOrchestrationTelemetry(context.orchestration?.telemetryLogPath, {
        maxBytes: DASHBOARD_TELEMETRY_MAX_BYTES,
        maxRecords: DASHBOARD_TELEMETRY_MAX_RECORDS,
      });
      json(res, {
        maxBytes: DASHBOARD_TELEMETRY_MAX_BYTES,
        maxRecords: DASHBOARD_TELEMETRY_MAX_RECORDS,
        summary: summarizeOrchestrationTelemetry(read),
      });
      return true;
    }
    if (pathname === "/api/orchestration/worktrees") {
      const root = context.orchestration?.worktreeRoot
        ?? runtime?.getWorktreeOptions().root
        ?? resolveWorktreeOptions(context.getConfig()).root;
      json(res, {
        root,
        worktrees: listManagedWorktrees(root).map((worktree) => ({
          taskId: worktree.taskId,
          lane: worktree.lane,
          path: worktree.path,
          baseCwd: worktree.baseCwd,
          gitRoot: worktree.gitRoot,
          branch: worktree.branch,
          createdAt: worktree.createdAt,
        })),
      });
      return true;
    }
    if (pathname === "/api/orchestration/dual-lane") {
      json(res, {
        manifests: listDualLaneManifests(context.orchestration?.dualLaneStateDir).map(summarizeDualLaneManifest),
      });
      return true;
    }
    if (artifactParams) {
      const kind = parseArtifactKind(artifactParams.kind);
      if (!kind) {
        json(res, { error: "artifact kind must be diff, prompt, output, or patch_apply" }, 400);
        return true;
      }
      const store = runtime?.getStore() ?? openFallbackStore(context);
      try {
        const coordinatorId = queryParam(req?.url, "coordinatorId");
        if (!coordinatorId) {
          json(res, { error: "coordinatorId query parameter is required" }, 400);
          return true;
        }
        json(res, { taskId: artifactParams.taskId, coordinatorId, kind, artifacts: listArtifactContents(store, artifactParams.taskId, kind, coordinatorId) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, { error: message, reason: "artifact_read_failed" }, 500);
      } finally {
        if (!runtime) store.close();
      }
      return true;
    }
    if (runtime) {
      if (pathname === "/api/orchestration/workers") json(res, { workers: runtime.listWorkers() });
      else if (pathname === "/api/orchestration/leases") json(res, { leases: runtime.listLeases() });
      else if (pathname === "/api/orchestration/queue") json(res, { queue: runtime.listQueue(), pauses: runtime.listTaskPauses() });
      else if (pathname === "/api/orchestration/continuations") json(res, { continuations: runtime.listLiveContinuations() });
      else if (pathname === "/api/orchestration/holds") json(res, { holds: runtime.listHolds({ includeInactive: true }) });
      else json(res, { allocations: runtime.listAllocations() });
      return true;
    }

    const config = context.orchestration?.config
      ?? (context.orchestration?.configDir
        ? loadOrchestrationConfig(context.orchestration.configDir)
        : loadDefaultOrchestrationConfig());

    if (pathname === "/api/orchestration/workers") {
      json(res, { workers: config.workers });
      return true;
    }

    const dbPath = context.orchestration?.dbPath ?? ORCH_DB;
    if (dbPath !== ":memory:" && !fs.existsSync(dbPath)) {
      if (pathname === "/api/orchestration/leases") json(res, { leases: [] });
      else if (pathname === "/api/orchestration/queue") json(res, { queue: [], pauses: [] });
      else if (pathname === "/api/orchestration/continuations") json(res, { continuations: [] });
      else if (pathname === "/api/orchestration/holds") json(res, { holds: [] });
      else json(res, { allocations: [] });
      return true;
    }

    if (pathname === "/api/orchestration/continuations") {
      const store = OrchestrationStore.open(dbPath);
      try {
        json(res, { continuations: store.listLiveContinuations() });
      } finally {
        store.close();
      }
      return true;
    }
    if (pathname === "/api/orchestration/holds") {
      const store = OrchestrationStore.open(dbPath);
      try {
        store.expireHolds();
        json(res, { holds: store.listHolds({ includeInactive: true }) });
      } finally {
        store.close();
      }
      return true;
    }

    const scheduler = PersistentMatrixScheduler.open(config, {
      dbPath,
      expireOnHydrate: false,
      now: context.orchestration?.now,
    });
    try {
      if (pathname === "/api/orchestration/leases") json(res, { leases: scheduler.listLeases() });
      else if (pathname === "/api/orchestration/queue") json(res, { queue: scheduler.listQueue(), pauses: [] });
      else json(res, { allocations: scheduler.listAllocations() });
    } finally {
      scheduler.close();
    }
    return true;
  } catch (err) {
    json(res, { error: "orchestration observe failed", detail: err instanceof Error ? err.message : String(err) }, 500);
    return true;
  }
}

function requireOrchestrationMutationAuth(req: HttpRequest, res: ServerResponse, context: ApiContext): boolean {
  if (!isSameOriginOrLocal(req)) {
    json(res, { error: "Origin not allowed" }, 403);
    return false;
  }
  if (!context.gatewayAuthToken) {
    json(res, { error: "Gateway auth token is not configured" }, 503);
    return false;
  }
  const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, context.cuttlefishHome ?? CUTTLEFISH_HOME);
  if (!auth.ok) {
    json(res, { error: auth.reason || "Unauthorized" }, 401);
    return false;
  }
  return true;
}

function isSameOriginOrLocal(req: HttpRequest): boolean {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!origin) return true;
  const rawHost = req.headers.host;
  const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  try {
    const parsed = new URL(origin);
    const originHost = parsed.hostname.toLowerCase();
    const requestHost = host ? new URL(`http://${host}`).hostname.toLowerCase() : "";
    return originHost === requestHost
      || originHost === "localhost"
      || originHost.endsWith(".localhost")
      || originHost === "127.0.0.1"
      || originHost === "::1";
  } catch {
    return false;
  }
}

function queryParam(url: string | undefined, key: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    const value = parsed.searchParams.get(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function buildStatusPayload(context: ApiContext, runtime: OrchestrationRuntime | undefined) {
  const enabled = context.getConfig().orchestration?.enabled === true;
  const controlState = runtime?.getControlState() ?? { queuePaused: false, pausedAt: null, pauseReason: null };
  const recoveryNotices = listRecoveryNotices(context.orchestration?.recoveryDir ?? ORCH_RECOVERY_DIR);
  const counts = runtime
    ? {
      workers: runtime.listWorkers().length,
      runningLeases: runtime.listLeases().filter((lease) => lease.state === "running").length,
      queueItems: runtime.listQueue().length,
      allocations: runtime.listAllocations().length,
      continuations: runtime.listLiveContinuations().length,
      activeWork: runtime.hasActiveWork(),
    }
    : {
      workers: context.orchestration?.config?.workers.length ?? 0,
      runningLeases: 0,
      queueItems: 0,
      allocations: 0,
      continuations: 0,
      activeWork: false,
    };
  return {
    enabled,
    runtimeBound: Boolean(runtime),
    degraded: enabled && !runtime,
    queuePaused: controlState.queuePaused,
    pausedAt: controlState.pausedAt,
    pauseReason: controlState.pauseReason,
    disabledReason: enabled ? null : "orchestration is disabled",
    degradedReason: enabled && !runtime ? "orchestration runtime is not bound; observe routes may use durable fallback state" : null,
    recoveryNotices,
    expiredLeaseHandling: runtime?.listExpiredLeaseHandling() ?? [],
    counts,
  };
}

function requireLiveRuntime(method: string, res: ServerResponse, context: ApiContext): OrchestrationRuntime | undefined {
  if (method !== "POST") {
    json(res, { error: "Method not allowed" }, 405);
    return undefined;
  }
  if (context.getConfig().orchestration?.enabled !== true) {
    json(res, { error: "orchestration is disabled" }, 409);
    return undefined;
  }
  const runtime = context.orchestration?.runtime;
  if (!runtime) {
    json(res, { error: "orchestration runtime is not enabled" }, 409);
    return undefined;
  }
  return runtime;
}

function jsonLeaseStop(
  res: ServerResponse,
  context: ApiContext,
  runtime: OrchestrationRuntime,
  leaseId: string,
  reason: string | undefined,
): void {
  const lease = runtime.listLeases().find((candidate) => candidate.leaseId === leaseId);
  if (!lease || lease.state !== "running") {
    json(res, { error: "running lease not found", leaseId }, lease ? 409 : 404);
    return;
  }
  const session = findSessionByLeaseId(leaseId);
  if (!session) {
    json(res, { error: "no session is mapped to this orchestration lease", leaseId }, 409);
    return;
  }
  const message = sanitizeStopReason(reason) ?? "Interrupted by orchestration lease stop";
  if (session.status !== "running") {
    try {
      const released = runtime.releaseLease(lease.leaseId, lease.coordinatorId);
      json(res, { status: "released_terminal_session", lease: released, sessionId: session.id }, 200);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err), leaseId }, 409);
    }
    return;
  }
  const stopped = killSessionEngines(context, session, message);
  if (stopped.interruptible === 0 || stopped.killed === 0) {
    json(res, { error: "mapped session engine is not interruptible", leaseId, sessionId: session.id }, 409);
    return;
  }
  context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
  updateSession(session.id, { status: "interrupted", lastActivity: new Date().toISOString(), lastError: message });
  context.emit("session:interrupted", { sessionId: session.id, reason: message });
  context.emit("session:updated", { sessionId: session.id });
  json(res, { status: "stop_requested", leaseId, sessionId: session.id, released: false, interruptible: true }, 202);
}

function findSessionByLeaseId(leaseId: string): Session | undefined {
  return listSessions().find((session) => parseLeaseTransportMeta(session.transportMeta)?.leaseId === leaseId);
}

function sanitizeStopReason(reason: string | undefined): string | null {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed ? trimmed.slice(0, 500) : null;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter(Boolean))];
}

function parseArtifactKind(value: string): ArtifactKind | null {
  return value === "diff" || value === "prompt" || value === "output" || value === "patch_apply" ? value : null;
}

function authorizeHoldManager(managerName: string, workerIds: string[], context: ApiContext): { ok: true } | { ok: false; error: string } {
  const registry = scanOrg();
  const mapped = employeeNamesForOrgWorkerIds(registry, workerIds);
  const auth = authorizeManagerScope(registry, managerName, mapped.employeeNames, context.getConfig().portal?.portalName);
  if (!auth.ok) return auth;
  if (mapped.unknownWorkerIds.length > 0 && auth.manager.rank !== "executive") {
    return {
      ok: false,
      error: `non-org workers require executive authorization: ${mapped.unknownWorkerIds.join(", ")}`,
    };
  }
  return { ok: true };
}

function openFallbackStore(context: ApiContext): OrchestrationStore {
  return OrchestrationStore.open(context.orchestration?.dbPath ?? ORCH_DB, { recoverCorrupt: false });
}

type DualLaneManifestSummaryInput = ReturnType<typeof listDualLaneManifests>[number];

function summarizeDualLaneManifest(manifest: DualLaneManifestSummaryInput) {
  return {
    taskId: manifest.taskId,
    coordinatorId: manifest.coordinatorId,
    state: manifest.state,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    baseCwd: manifest.baseCwd,
    selectedLane: manifest.selectedLane ?? null,
    archivedLane: manifest.archivedLane ?? null,
    lanes: manifest.lanes.map((lane) => ({
      id: lane.id,
      role: lane.role,
      family: lane.family,
      workerId: lane.workerId,
      leaseId: lane.leaseId,
      sessionId: lane.session.sessionId,
      sessionStatus: lane.session.status,
      sessionError: lane.session.error ?? null,
      worktreePath: lane.worktree.path,
      archive: lane.archive
        ? {
          diffPath: lane.archive.diffPath,
          metadataPath: lane.archive.metadataPath,
          archivedAt: lane.archive.archivedAt,
        }
        : null,
    })),
    comparisonReport: {
      taskId: manifest.comparisonReport.taskId,
      generatedAt: manifest.comparisonReport.generatedAt,
      laneSummaries: manifest.comparisonReport.laneSummaries.map((summary) => ({
        laneId: summary.laneId,
        changedFiles: summary.changedFiles,
        addedLines: summary.addedLines,
        removedLines: summary.removedLines,
        status: summary.status,
        error: summary.error,
      })),
      commonFiles: manifest.comparisonReport.commonFiles,
      uniqueFiles: manifest.comparisonReport.uniqueFiles,
      majorDifferences: manifest.comparisonReport.majorDifferences,
    },
  };
}
