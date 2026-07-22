import type { JsonObject, Session } from "../shared/types.js";
import {
  buildResolvedRunAttachments,
  listRunAttachments,
  mergeRunAttachments,
  resolveIncomingRunAttachments,
  screenRunAttachmentsForSession,
  setRunAttachmentsOnTransportMeta,
} from "./run-attachments.js";
import { fileIdsToMedia, rehomeAttachmentsToSession } from "./files.js";
import { updateSession } from "../sessions/registry.js";
import type { ApiContext } from "./api/context.js";

function combinedResourceSpecs(body: Record<string, unknown>): unknown[] {
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const resources = Array.isArray(body.resources) ? body.resources : [];
  return [...attachments, ...resources];
}

export interface DescribedSessionResources {
  promptBlock: string | null;
  engineAttachments: string[];
  blocked: boolean;
}

export interface AttachedSessionResources extends DescribedSessionResources {
  session: Session;
}

export async function attachResourcesToSession(
  session: Session,
  body: Record<string, unknown>,
  context: ApiContext,
): Promise<AttachedSessionResources> {
  const existing = listRunAttachments(session);
  const incomingSpecs = combinedResourceSpecs(body);
  if (incomingSpecs.length === 0) {
    const resolved = buildResolvedRunAttachments(existing);
    return { session, ...resolved };
  }

  const legacyFileIds = Array.isArray(body.attachments)
    ? body.attachments.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  if (legacyFileIds.length > 0) rehomeAttachmentsToSession(legacyFileIds, session.id);

  const incoming = await resolveIncomingRunAttachments(incomingSpecs, context);
  const merged = mergeRunAttachments(existing, incoming);
  const screened = await screenRunAttachmentsForSession(
    session,
    merged,
    context,
    typeof body.prompt === "string"
      ? body.prompt
      : typeof body.message === "string"
        ? body.message
        : session.promptExcerpt ?? session.title ?? null,
  );
  const updated = updateSession(session.id, {
    transportMeta: setRunAttachmentsOnTransportMeta(session.transportMeta, screened) as JsonObject,
  }) ?? session;
  return { session: updated, ...buildResolvedRunAttachments(screened) };
}

export function describeSessionResources(session: Session): DescribedSessionResources {
  return buildResolvedRunAttachments(listRunAttachments(session));
}

export function attachmentMedia(body: Record<string, unknown>) {
  return fileIdsToMedia(Array.isArray(body.attachments) ? body.attachments : undefined);
}

