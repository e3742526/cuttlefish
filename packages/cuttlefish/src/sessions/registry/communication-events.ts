import { v4 as uuidv4 } from "uuid";
import type {
  CollaborationAttribution,
  CollaborationAuthorKind,
  CollaborationFeedItem,
  CollaborationFeedKind,
  CollaborationLane,
  DeliveryReceipt,
} from "@cuttlefish/contracts";
import { initDb } from "./core.js";

export interface CommunicationEventInput {
  id?: string;
  lane: CollaborationLane;
  projectRootSessionId?: string | null;
  sessionId?: string | null;
  kind: CollaborationFeedKind;
  author: {
    kind: CollaborationAuthorKind;
    id?: string;
    displayName: string;
  };
  recipients?: string[];
  content: string;
  timestamp?: number;
  attribution?: CollaborationAttribution;
  deliveryReceipts?: DeliveryReceipt[];
  referencedMessageIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface StoredCommunicationEvent extends CollaborationFeedItem {
  referencedMessageIds: string[];
  metadata: Record<string, unknown>;
}

interface EventRow {
  id: string;
  lane: CollaborationLane;
  project_root_session_id: string | null;
  session_id: string | null;
  kind: CollaborationFeedKind;
  author_kind: CollaborationAuthorKind;
  author_id: string | null;
  author_display_name: string;
  recipients_json: string;
  content: string;
  timestamp: number;
  attribution: CollaborationAttribution;
  delivery_receipts_json: string | null;
  referenced_message_ids_json: string | null;
  metadata_json: string | null;
}

function parseArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function rowToEvent(row: EventRow): StoredCommunicationEvent {
  return {
    id: row.id,
    lane: row.lane,
    ...(row.project_root_session_id ? { projectRootSessionId: row.project_root_session_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    kind: row.kind,
    author: {
      kind: row.author_kind,
      ...(row.author_id ? { id: row.author_id } : {}),
      displayName: row.author_display_name,
    },
    recipients: parseArray<string>(row.recipients_json),
    content: row.content,
    timestamp: row.timestamp,
    attribution: row.attribution,
    deliveryReceipts: parseArray<DeliveryReceipt>(row.delivery_receipts_json),
    referencedMessageIds: parseArray<string>(row.referenced_message_ids_json),
    metadata: parseObject(row.metadata_json),
  };
}

export function insertCommunicationEvent(input: CommunicationEventInput): StoredCommunicationEvent {
  const event = {
    id: input.id ?? uuidv4(),
    timestamp: input.timestamp ?? Date.now(),
    attribution: input.attribution ?? "recorded" as const,
  };
  initDb().prepare(`
    INSERT INTO communication_events (
      id, lane, project_root_session_id, session_id, kind,
      author_kind, author_id, author_display_name, recipients_json,
      content, timestamp, attribution, delivery_receipts_json,
      referenced_message_ids_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    input.lane,
    input.projectRootSessionId ?? null,
    input.sessionId ?? null,
    input.kind,
    input.author.kind,
    input.author.id ?? null,
    input.author.displayName,
    JSON.stringify(input.recipients ?? []),
    input.content,
    event.timestamp,
    event.attribution,
    input.deliveryReceipts?.length ? JSON.stringify(input.deliveryReceipts) : null,
    input.referencedMessageIds?.length ? JSON.stringify(input.referencedMessageIds) : null,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return {
    id: event.id,
    lane: input.lane,
    ...(input.projectRootSessionId ? { projectRootSessionId: input.projectRootSessionId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    kind: input.kind,
    author: input.author,
    recipients: input.recipients ?? [],
    content: input.content,
    timestamp: event.timestamp,
    attribution: event.attribution,
    deliveryReceipts: input.deliveryReceipts ?? [],
    referencedMessageIds: input.referencedMessageIds ?? [],
    metadata: input.metadata ?? {},
  };
}

export function listCommunicationEvents(input: {
  lane: CollaborationLane;
  projectRootSessionId?: string;
  sessionIds?: string[];
}): StoredCommunicationEvent[] {
  const conditions = ["lane = ?"];
  const values: unknown[] = [input.lane];
  if (input.projectRootSessionId) {
    conditions.push("project_root_session_id = ?");
    values.push(input.projectRootSessionId);
  }
  if (input.sessionIds) {
    if (input.sessionIds.length === 0) return [];
    conditions.push(`session_id IN (${input.sessionIds.map(() => "?").join(",")})`);
    values.push(...input.sessionIds);
  }
  const rows = initDb().prepare(`
    SELECT * FROM communication_events
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp ASC, id ASC
  `).all(...values) as EventRow[];
  return rows.map(rowToEvent);
}

export function deleteCommunicationEventsForSessions(sessionIds: string[]): number {
  if (sessionIds.length === 0) return 0;
  const placeholders = sessionIds.map(() => "?").join(",");
  return initDb().prepare(`
    DELETE FROM communication_events
    WHERE session_id IN (${placeholders}) OR project_root_session_id IN (${placeholders})
  `).run(...sessionIds, ...sessionIds).changes;
}

