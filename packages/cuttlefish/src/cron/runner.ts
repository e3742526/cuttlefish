import crypto from "node:crypto";
import type { CronJob, Connector, CronRunEntry, CuttlefishConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";
import { scanOrg, findEmployee } from "../gateway/org.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { getSession } from "../sessions/registry.js";
import { portalEmployeeSlug } from "../shared/portal-slug.js";

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: CuttlefishConfig,
  connectors: Map<string, Connector>,
  opts: { runId?: string; trigger?: CronRunEntry["trigger"] } = {},
): Promise<CronRunEntry> {
  const startTime = Date.now();
  const runId = opts.runId ?? crypto.randomUUID();
  const trigger = opts.trigger ?? "scheduled";
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const cooSlug = portalEmployeeSlug(config.portal?.portalName);
  if (delivery && job.employee && job.employee !== cooSlug) {
    logger.debug(
      `Cron job "${job.name}" targets employee "${job.employee}" directly (skipping COO delegation).`,
    );
  }

  const connector = new CronConnector(connectors, delivery);
  const startedAt = new Date().toISOString();
  const sessionKey = `cron:${job.id}:${Date.now()}`;
  appendRunLog(job.id, {
    runId,
    timestamp: startedAt,
    startedAt,
    sessionKey,
    status: "running",
    trigger,
    error: null,
    resultPreview: null,
  });

  try {
    // Org scanning lives inside the try: org/ hot-reloads, and a malformed YAML
    // mid-edit must surface as a logged job failure, not an unhandled rejection.
    let employee;
    if (job.employee) {
      const orgRegistry = scanOrg();
      employee = findEmployee(job.employee, orgRegistry);
    }

    const routeResult = await sessionManager.route(
      {
        connector: connector.name,
        source: "cron",
        sessionKey,
        replyContext: {
          channel: delivery?.channel || job.id,
          messageTs: null,
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
        },
        messageId: undefined,
        channel: delivery?.channel || job.id,
        thread: undefined,
        user: "system",
        userId: "system",
        text: job.prompt,
        attachments: [],
        raw: { jobId: job.id, trigger: "cron" },
        transportMeta: {
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
          deliveryChannel: delivery?.channel ?? null,
        },
      },
      connector,
      {
        employee,
        engine: job.engine || employee?.engine || config.engines.default,
        model: job.model || employee?.model || config.engines[(job.engine || config.engines.default) as "claude" | "codex" | "antigravity" | "grok" | "pi" | "kiro" | "hermes" | "ollama" | "kilo"]?.model,
        title: job.name,
      },
    );

    const durationMs = Date.now() - startTime;
    const finishedAt = new Date().toISOString();
    // Derive true status from the session's terminal state — route() resolving
    // does not mean the turn succeeded; engine errors are recorded on the session.
    const finalSessionId = routeResult?.sessionId ?? null;
    const finalSession = finalSessionId ? getSession(finalSessionId) : undefined;
    const sessionFailed = finalSession?.status === "error" || Boolean(finalSession?.lastError);
    const finalEntry: CronRunEntry = {
      runId,
      timestamp: finishedAt,
      startedAt,
      finishedAt,
      sessionKey,
      sessionId: finalSessionId,
      status: sessionFailed ? "error" : "success",
      trigger,
      durationMs,
      error: sessionFailed ? (finalSession?.lastError ?? "session ended in error") : null,
      resultPreview: null,
    };
    appendRunLog(job.id, finalEntry);
    if (sessionFailed) {
      logger.error(`Cron job "${job.name}" failed (session error) in ${durationMs}ms: ${finalEntry.error}`);
    } else {
      logger.info(`Cron job "${job.name}" completed in ${durationMs}ms`);
    }

    const alertConnector = config.cron?.alertConnector;
    const alertChannel = config.cron?.alertChannel;
    // Send failure alert if session ended in error
    if (sessionFailed && alertConnector && alertChannel) {
      const alertTarget = connectors.get(alertConnector);
      if (alertTarget) {
        await alertTarget.sendMessage(
          { channel: alertChannel },
          `Cron job "${job.name}" failed (session error):\n${String(finalEntry.error).slice(0, 500)}`,
        ).catch((alertErr) => {
          logger.error(`Failed to send cron failure alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
        });
      }
    }
    // Latency alert: warn if job exceeded threshold
    const thresholdMs = config.cron?.alertThresholdMs;
    if (thresholdMs && durationMs > thresholdMs) {
      if (alertConnector && alertChannel) {
        const alertTarget = connectors.get(alertConnector);
        if (alertTarget) {
          const mins = (durationMs / 60_000).toFixed(1);
          const threshMins = (thresholdMs / 60_000).toFixed(1);
          await alertTarget.sendMessage(
            { channel: alertChannel },
            `Cron latency alert: "${job.name}" (${job.id}) exceeded threshold — took ${mins}min (threshold: ${threshMins}min). Session: ${finalSessionId ?? "unknown"}`,
          ).catch((alertErr) => {
            logger.error(`Failed to send latency alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
          });
        }
      }
    }
    return finalEntry;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date().toISOString();
    const finalEntry: CronRunEntry = {
      runId,
      timestamp: finishedAt,
      startedAt,
      finishedAt,
      sessionKey,
      status: "error",
      trigger,
      durationMs: Date.now() - startTime,
      error: message,
      resultPreview: null,
    };
    appendRunLog(job.id, finalEntry);
    logger.error(`Cron job "${job.name}" failed: ${message}`);

    // Send alert if configured
    const alertConnector = config.cron?.alertConnector;
    const alertChannel = config.cron?.alertChannel;
    if (alertConnector && alertChannel) {
      const alertTarget = connectors.get(alertConnector);
      if (alertTarget) {
        await alertTarget.sendMessage(
          { channel: alertChannel },
          `⚠️ Cron job "${job.name}" failed:\n${message.slice(0, 500)}`,
        ).catch((alertErr) => {
          logger.error(`Failed to send cron alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
        });
      }
    }
    return finalEntry;
  }
}
