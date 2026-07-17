import type {
  Connector,
  CuttlefishConfig,
  Employee,
  IncomingMessage,
  Session,
  Target,
} from "../shared/types.js";
import { getOrCreateSessionBySessionKey, updateSession } from "./registry.js";
import { getClaudeExpectedResetAt } from "../shared/usageAwareness.js";
import { getRecordedReset, usageConfig } from "../shared/usage-status.js";
import { logger } from "../shared/logger.js";
import { SessionQueue } from "./queue.js";
import { maybeRevertEngineOverride, mergeTransportMeta } from "./manager-helpers.js";
import { rateLimitPausedNotice } from "./rate-limit-handler.js";

export type RouteOptions = {
  employee?: Employee;
  engine?: string;
  model?: string;
  title?: string;
};

type TurnRunner = (
  session: Session,
  msg: IncomingMessage,
  attachments: string[],
  connector: Connector,
  target: Target,
  employee?: Employee,
) => Promise<void>;

/**
 * Owns the transport-facing half of a managed turn: create or resume the
 * durable session, reconstruct its reply target, surface a rate-limit pause,
 * then enqueue the engine turn. Engine lifecycle remains injected so this
 * boundary is independently reusable and testable.
 */
export class SessionDispatcher {
  constructor(
    private readonly input: {
      config: CuttlefishConfig;
      queue: SessionQueue;
      runTurn: TurnRunner;
    },
  ) {}

  async route(
    msg: IncomingMessage,
    connector: Connector,
    opts: RouteOptions = {},
  ): Promise<{ sessionId: string }> {
    const { session: dispatchedSession, created } = getOrCreateSessionBySessionKey(msg.sessionKey, {
      engine: opts.engine ?? opts.employee?.engine ?? this.input.config.engines.default,
      source: msg.source,
      sourceRef: msg.sessionKey,
      connector: msg.connector,
      sessionKey: msg.sessionKey,
      replyContext: msg.replyContext,
      messageId: msg.messageId,
      transportMeta: msg.transportMeta,
      employee: opts.employee?.name ?? undefined,
      model: opts.model ?? opts.employee?.model ?? undefined,
      effortLevel: opts.employee?.effortLevel ?? undefined,
      title: opts.title,
      prompt: msg.text,
      portalName: this.input.config.portal?.portalName,
    });
    let session = dispatchedSession;
    if (created) {
      logger.info(
        `Created new session ${session.id} for ${msg.sessionKey}` +
        (opts.employee ? ` (employee: ${opts.employee.name})` : ""),
      );
    } else {
      const mergedMeta = mergeTransportMeta(session.transportMeta, msg.transportMeta);
      session = updateSession(session.id, {
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: mergedMeta,
        ...(opts.model ? { model: opts.model } : {}),
      }) ?? session;
    }

    session = maybeRevertEngineOverride(session);
    this.input.queue.clearCancelled(msg.sessionKey);

    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;
    const attachmentPaths = msg.attachments
      .map((attachment) => attachment.localPath)
      .filter((filePath): filePath is string => !!filePath);

    if (session.status === "waiting") {
      const recordedReset = getRecordedReset(session.engine, usageConfig(this.input.config).fallbackWindowMins);
      const expectedResetAt = typeof recordedReset === "number" ? new Date(recordedReset * 1000) : getClaudeExpectedResetAt();
      const resumeText = expectedResetAt
        ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : null;
      await connector.replyMessage(target, rateLimitPausedNotice(session.engine, resumeText)).catch(() => {});
    }

    if (session.status === "running" && this.input.queue.isRunning(msg.sessionKey) && connector.getCapabilities().reactions) {
      await connector.addReaction(target, "clock1").catch(() => {});
    }

    const sessionId = session.id;
    await this.input.queue.enqueue(msg.sessionKey, () =>
      this.input.runTurn(session!, msg, attachmentPaths, connector, target, opts.employee),
    );
    return { sessionId };
  }
}
