import type {
  Approval,
  ArchiveKind,
  ArchivedSessionSnapshot,
  JsonObject,
  ProjectArchive,
  ProjectArchiveDetail,
} from '../shared/types.js';
import {
  createArchiveAndDeleteSessionsRecord,
  createArchiveRecord,
  deleteArchiveRecord,
  getArchiveRecord,
  listArchiveRecords,
  snapshotSessionsForArchive,
  type ArchiveRegistryDeps,
} from './registry-archives.js';
import {
  clearApprovalRecordsForTestInRegistry,
  createApprovalRecordInRegistry,
  getApprovalRecordFromRegistry,
  importApprovalsJsonIfNeededFromRegistry,
  listApprovalRecordsFromRegistry,
  resolveApprovalRecordInRegistry,
  type ApprovalRegistryDeps,
} from './registry-approvals.js';
import { getMeta, initDb, parseJsonObject, setMeta } from './registry/core.js';
import { getMessages, type SessionMessage } from './registry/messages.js';
import { getSession } from './registry/sessions.js';

export { initDb } from './registry/core.js';
export { migrateApprovalsSchema, migrateExternalOutboxSchema, migrateFilesSchema, migrateMessagesSchema, migrateSessionsSchema } from './registry/migrations.js';
export {
  backfillFtsSync,
  disableFtsForProcess,
  migrateFtsSchema,
  searchMessages,
  type MessageSearchResult,
} from './registry/search.js';
export {
  EXTERNAL_OUTBOX_MAX_ATTEMPTS,
  EXTERNAL_OUTBOX_CLAIM_LEASE_MS,
  claimPendingExternalOutboxItems,
  enqueueExternalOutboxItem,
  getExternalOutboxItem,
  listExternalOutboxItems,
  listPendingExternalOutboxItems,
  markExternalOutboxDelivered,
  markExternalOutboxFailed,
  releaseExternalOutboxClaims,
  reclaimStaleExternalOutboxClaims,
  type ExternalOutboxItem,
  type ExternalOutboxStatus,
} from "./registry/external-outbox.js";
export {
  beginSessionRun,
  CRON_GROUP,
  DIRECT_GROUP,
  VALID_SESSION_STATUSES,
  accumulateSessionCost,
  coercePortalEmployee,
  createSession,
  deleteSession,
  deleteSessions,
  duplicateSession,
  getEmployeeSpendSince,
  getInterruptedSessions,
  getSession,
  getSessionBySessionKey,
  getSessionBySourceRef,
  getSessionGroupCounts,
  isValidSessionStatus,
  listChildSessions,
  listRecentCwds,
  listRecentPerGroup,
  listSessions,
  listSessionsBySource,
  listSessionsForGroup,
  patchSessionTransportMeta,
  promptExcerptOf,
  recoverStaleSessions,
  searchSessions,
  updateSession,
  type CreateSessionOpts,
  type ListSessionsFilter,
  type UpdateSessionFields,
} from './registry/sessions.js';
export {
  claimConnectorWebhookReplay,
  releaseConnectorWebhookReplay,
  type ClaimConnectorWebhookReplayInput,
} from './registry/webhook-replay.js';
export {
  applyBlockEnvelope,
  clearAllPartialMessages,
  deletePartialMessages,
  finalizePartialMessages,
  getMessages,
  insertMessage,
  insertPartialMessage,
  updateMessageContent,
  updatePartialMessage,
  type MessageMedia,
  type SessionMessage,
} from './registry/messages.js';
export {
  cancelAllPendingQueueItems,
  cancelQueueItem,
  cancelQueueItemForSession,
  enqueueQueueItem,
  getQueueItem,
  getQueueItems,
  hasPendingQueueItemBefore,
  listAllPendingQueueItems,
  listPendingQueueItems,
  listPausedQueueKeys,
  markQueueItemCompleted,
  markQueueItemRunning,
  pauseQueueKey,
  recoverStaleQueueItems,
  resumeQueueKey,
  type QueueItem,
} from './registry/queue.js';
export {
  deleteFile,
  getFile,
  getFilesByIds,
  insertFile,
  listFiles,
  findArtifactsByPaths,
  listArtifacts,
  updateArtifactMetadata,
  setFilePath,
  type ArtifactKind,
  type ArtifactListFilter,
  type FileMeta,
} from './registry/files.js';

const archiveRegistryDeps: ArchiveRegistryDeps = {
  getDb: initDb,
  getSession,
  getMessages,
};

export function snapshotSessions(ids: string[]): ArchivedSessionSnapshot[] {
  return snapshotSessionsForArchive(ids, archiveRegistryDeps);
}

export function createArchive(opts: {
  label?: string | null;
  note?: string | null;
  kind: ArchiveKind;
  sourceRef?: string | null;
  sessions: ArchivedSessionSnapshot[];
}): ProjectArchive {
  return createArchiveRecord(opts, archiveRegistryDeps);
}

export function createArchiveAndDeleteSessions(opts: {
  label?: string | null;
  note?: string | null;
  kind: ArchiveKind;
  sourceRef?: string | null;
  sessionIds: string[];
}): ProjectArchive | undefined {
  return createArchiveAndDeleteSessionsRecord(opts, archiveRegistryDeps);
}

export function listArchives(): ProjectArchive[] {
  return listArchiveRecords(archiveRegistryDeps);
}

export function getArchive(id: string): ProjectArchiveDetail | undefined {
  return getArchiveRecord(id, archiveRegistryDeps);
}

export function deleteArchive(id: string): boolean {
  return deleteArchiveRecord(id, archiveRegistryDeps);
}

const approvalRegistryDeps: ApprovalRegistryDeps = {
  getDb: initDb,
  getMeta,
  setMeta,
  parseJsonObject,
};

export function importApprovalsJsonIfNeeded(filePath: string): void {
  importApprovalsJsonIfNeededFromRegistry(filePath, approvalRegistryDeps);
}

export function listApprovalRecords(filter?: { state?: Approval["state"] | "all"; sessionId?: string; type?: Approval["type"] | "all" }): Approval[] {
  return listApprovalRecordsFromRegistry(filter, approvalRegistryDeps);
}

export function getApprovalRecord(id: string): Approval | undefined {
  return getApprovalRecordFromRegistry(id, approvalRegistryDeps);
}

export function createApprovalRecord(input: {
  sessionId: string;
  type: Approval["type"];
  payload: JsonObject;
}): Approval {
  return createApprovalRecordInRegistry(input, approvalRegistryDeps);
}

export function resolveApprovalRecord(
  id: string,
  state: Approval["state"] extends "pending" ? never : Exclude<Approval["state"], "pending">,
  actor?: string | null,
  decisionNotes?: string | null,
  resultingAction?: string | null,
): Approval | undefined {
  return resolveApprovalRecordInRegistry(id, state, actor, decisionNotes, resultingAction, approvalRegistryDeps);
}

export function clearApprovalRecordsForTest(): void {
  clearApprovalRecordsForTestInRegistry(approvalRegistryDeps);
}
