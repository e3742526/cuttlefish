import type {
  CollaborationSendResponse,
  DeliveryReceipt,
  OperatorDelegationScope,
} from "@cuttlefish/contracts";
import type { Employee, Session } from "../shared/types.js";
import {
  createSession,
  insertCommunicationEvent,
  patchSessionTransportMeta,
  type CommunicationEventInput,
} from "../sessions/registry.js";
import { HR_EMPLOYEE_NAME, HR_SESSION_KEY } from "../gateway/org-policy.js";
import { continueSession } from "../gateway/continue-session.js";
import type { GatewayPrincipal } from "../gateway/auth.js";
import type { ApiContext } from "../gateway/api/context.js";
import { logger } from "../shared/logger.js";
import { COO_RECIPIENT_ID } from "./recipient-resolution.js";

interface DispatchTarget {
  recipientId: string;
  session?: Session;
  employee?: Employee;
}

type InternalDelivery = DeliveryReceipt & { messageId?: string };

export interface CollaborationDispatchInput {
  lane: "team" | "management";
  message: string;
  targets: DispatchTarget[];
  projectRootSessionId?: string;
  context: ApiContext;
  principal?: GatewayPrincipal;
  userId?: string | null;
  operatorDelegationScopes?: OperatorDelegationScope[];
  recordEvent?: (event: CommunicationEventInput) => unknown;
  dispatchTurn?: typeof continueSession;
}

export type CollaborationDispatchResult =
  | { ok: true; statusCode: 202 | 207; response: CollaborationSendResponse }
  | { ok: false; statusCode: 400 | 403 | 409; error: string; code?: string };

function resolveTargetProfile(target: DispatchTarget, context: ApiContext): {
  engine: string;
  model?: string;
  effortLevel?: string;
  employee: string | null;
} | null {
  if (target.session) {
    return {
      engine: target.session.engine,
      model: target.session.model ?? undefined,
      effortLevel: target.session.effortLevel ?? undefined,
      employee: target.session.employee,
    };
  }
  if (target.recipientId === COO_RECIPIENT_ID) {
    const config = context.getConfig();
    const engine = config.engines.default;
    const model = (config.engines as unknown as Record<string, { model?: string }>)[engine]?.model;
    return { engine, model, employee: null };
  }
  if (!target.employee) return null;
  return {
    engine: target.employee.engine,
    model: target.employee.model,
    effortLevel: target.employee.effortLevel,
    employee: target.employee.name,
  };
}

function createManagementSession(
  target: DispatchTarget,
  profile: NonNullable<ReturnType<typeof resolveTargetProfile>>,
  input: CollaborationDispatchInput,
): Session {
  const isHr = profile.employee === HR_EMPLOYEE_NAME;
  const sessionKey = isHr ? HR_SESSION_KEY : `web:management:${target.recipientId}:${Date.now()}`;
  const session = createSession({
    engine: profile.engine,
    model: profile.model,
    effortLevel: profile.effortLevel,
    source: "web",
    sourceRef: sessionKey,
    connector: "web",
    sessionKey,
    replyContext: { source: "web" },
    userId: input.userId,
    employee: profile.employee,
    prompt: input.message,
    promptExcerpt: input.message,
    portalName: input.context.getConfig().portal?.portalName,
    ...(input.projectRootSessionId ? { transportMeta: { managementProjectRootSessionId: input.projectRootSessionId } } : {}),
  });
  input.context.emit("session:created", { sessionId: session.id });
  return session;
}

export async function dispatchCollaborationMessage(
  input: CollaborationDispatchInput,
): Promise<CollaborationDispatchResult> {
  if (!input.message.trim()) return { ok: false, statusCode: 400, error: "message is required" };
  if (input.targets.length === 0) return { ok: false, statusCode: 400, error: "At least one recipient is required" };
  const profiles = input.targets.map((target) => ({ target, profile: resolveTargetProfile(target, input.context) }));
  const unresolved = profiles.filter((entry) => !entry.profile).map((entry) => entry.target.recipientId);
  if (unresolved.length > 0) {
    return { ok: false, statusCode: 400, error: `Recipients do not resolve to active employees: ${unresolved.join(", ")}` };
  }
  const unavailable = profiles.filter((entry) => !input.context.sessionManager.getEngine(entry.profile!.engine));
  if (unavailable.length === profiles.length) {
    return {
      ok: false,
      statusCode: 409,
      error: `No selected recipient has an available engine: ${unavailable.map((entry) => entry.target.recipientId).join(", ")}`,
      code: "recipients_unavailable",
    };
  }

  const settled: InternalDelivery[] = await Promise.all(profiles.map(async ({ target, profile }): Promise<InternalDelivery> => {
    if (!input.context.sessionManager.getEngine(profile!.engine)) {
      return { recipientId: target.recipientId, state: "unavailable", error: `Engine "${profile!.engine}" is unavailable` };
    }
    const session = target.session ?? createManagementSession(target, profile!, input);
    if (input.lane === "management" && input.projectRootSessionId && target.session) {
      patchSessionTransportMeta(session.id, { managementProjectRootSessionId: input.projectRootSessionId });
    }
    try {
      const result = await (input.dispatchTurn ?? continueSession)({
        sessionId: session.id,
        body: { message: input.message },
        context: input.context,
        principal: input.principal,
        userId: input.userId,
        operatorDelegationScopes: input.operatorDelegationScopes,
      });
      if (result.statusCode >= 400) {
        return {
          recipientId: target.recipientId,
          sessionId: session.id,
          state: "failed",
          error: String(result.body.error ?? "Dispatch failed"),
        };
      }
      return {
        recipientId: target.recipientId,
        sessionId: session.id,
        state: "queued",
        messageId: result.insertedMessageId,
      };
    } catch (error) {
      return {
        recipientId: target.recipientId,
        sessionId: session.id,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const receipts: DeliveryReceipt[] = settled.map(({ messageId: _messageId, ...receipt }) => receipt);
  const queued = receipts.filter((receipt) => receipt.state === "queued");
  if (queued.length === 0) {
    return { ok: false, statusCode: 409, error: receipts.map((receipt) => receipt.error).filter(Boolean).join("; ") || "No recipient was queued" };
  }

  let projectionWarning: string | undefined;
  try {
    (input.recordEvent ?? insertCommunicationEvent)({
      lane: input.lane,
      projectRootSessionId: input.projectRootSessionId,
      kind: "message",
      author: { kind: "operator", id: input.userId ?? undefined, displayName: "You" },
      recipients: input.targets.map((target) => target.recipientId),
      content: input.message,
      deliveryReceipts: receipts,
      referencedMessageIds: settled.flatMap((entry) => entry.messageId ? [entry.messageId] : []),
      metadata: input.operatorDelegationScopes?.length
        ? { operatorDelegationScopes: input.operatorDelegationScopes, oneTurn: true }
        : undefined,
    });
  } catch (error) {
    projectionWarning = "Message dispatch succeeded, but the collaboration feed projection could not be recorded";
    logger.error(`${projectionWarning}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const partial = queued.length !== receipts.length;
  return {
    ok: true,
    statusCode: partial ? 207 : 202,
    response: {
      status: partial ? "partial" : "queued",
      receipts,
      ...(projectionWarning ? { projectionWarning } : {}),
      ...(input.operatorDelegationScopes?.length ? {
        authorityGrant: {
          recipientId: input.targets[0].recipientId,
          scopes: input.operatorDelegationScopes,
          oneTurn: true,
          modelEligible: true,
        },
      } : {}),
    },
  };
}
