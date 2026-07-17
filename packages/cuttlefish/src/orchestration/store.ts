import Database from "better-sqlite3";
import { ORCH_DB } from "../shared/paths.js";
import type { LiveRunContinuationRecord, LiveRunContinuationState } from "./live-run.js";
import {
  addArtifactRecordInDb,
  addPatchApplyAttemptInDb,
  cancelHoldInDb,
  deleteTaskPauseFromDb,
  expireHoldsInDb,
  getHoldFromDb,
  getTaskPauseFromDb,
  listArtifactRecordsFromDb,
  listHoldsFromDb,
  listPatchApplyAttemptsFromDb,
  listTaskPausesFromDb,
  setTaskPauseInDb,
  upsertHoldInDb,
  type ArtifactKind,
  type ArtifactRecord,
  type HoldRecord,
  type PatchApplyAttemptRecord,
  type TaskPauseRecord,
} from "./store-controls.js";
import {
  claimQueuedLiveContinuationInDb,
  deleteLiveContinuationFromDb,
  getLiveContinuationFromDb,
  getQueuePauseStateFromDb,
  listLiveContinuationsFromDb,
  listLiveContinuationsWithGenerationFromDb,
  markLiveContinuationStateInDb,
  setQueuePauseStateInDb,
  stampContinuationRunIdInDb,
  type LiveRunContinuationRecordWithGeneration,
  type QueuePauseState,
  upsertLiveContinuationInDb,
} from "./store-continuations.js";
import { openStoreDatabase, type StoreOpenOptions } from "./store-schema.js";
import { applySnapshotDeltaToDb, loadSnapshotFromDb, replaceSnapshotInDb } from "./store-snapshot.js";
import type { SchedulerSnapshot, TelemetryEvent } from "./types.js";

export type { QueuePauseState, StoreOpenOptions };
export type {
  ArtifactKind,
  ArtifactRecord,
  HoldRecord,
  LiveRunContinuationRecordWithGeneration,
  PatchApplyAttemptRecord,
  TaskPauseRecord,
};

/**
 * Serialize a read-modify-write mutation across gateway processes.
 * SQLite's ordinary deferred transaction permits two processes to read the
 * same state before either writes; acquiring the write lock first (`BEGIN
 * IMMEDIATE`) makes the second process load the committed state after the
 * first finishes, instead of losing the write-lock race between its read
 * and write phases.
 */
export function transactionImmediate<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

export class OrchestrationStore {
  private constructor(
    private readonly db: Database.Database,
    private readonly bootGenerationValue: number,
    private readonly recoveryEvent?: TelemetryEvent,
  ) {}

  static open(dbPath = ORCH_DB, opts: StoreOpenOptions = {}): OrchestrationStore {
    const opened = openStoreDatabase(dbPath, opts);
    return new OrchestrationStore(opened.db, opened.bootGeneration, opened.recoveryEvent);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Monotonic counter that increments every time this DB is opened (every
   * daemon boot). See TMP-CUT-013: used alongside wall-clock cutoffs to
   * detect continuations orphaned by a prior process, independent of clock
   * skew/adjustment.
   */
  getBootGeneration(): number {
    return this.bootGenerationValue;
  }

  loadSnapshot(): SchedulerSnapshot {
    return loadSnapshotFromDb(this.db, this.recoveryEvent);
  }

  replaceSnapshot(snapshot: SchedulerSnapshot): void {
    replaceSnapshotInDb(this.db, snapshot);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Serialize a read-modify-write scheduler mutation across gateway processes.
   * SQLite's ordinary deferred transaction permits two schedulers to read the
   * same snapshot before either writes; acquiring the write lock first makes
   * the second process load the committed snapshot after the first finishes.
   */
  transactionImmediate<T>(fn: () => T): T {
    return transactionImmediate(this.db, fn);
  }

  applySnapshotDelta(before: SchedulerSnapshot, after: SchedulerSnapshot): void {
    applySnapshotDeltaToDb(this.db, before, after);
  }

  listLiveContinuations(states?: LiveRunContinuationState[]): LiveRunContinuationRecord[] {
    return listLiveContinuationsFromDb(this.db, states);
  }

  /**
   * Same as `listLiveContinuations`, but also returns the boot generation
   * each record was created under (TMP-CUT-013). Used by boot-time
   * stale-continuation recovery.
   */
  listLiveContinuationsWithGeneration(states?: LiveRunContinuationState[]): LiveRunContinuationRecordWithGeneration[] {
    return listLiveContinuationsWithGenerationFromDb(this.db, states);
  }

  getLiveContinuation(taskId: string, coordinatorId: string): LiveRunContinuationRecord | undefined {
    return getLiveContinuationFromDb(this.db, taskId, coordinatorId);
  }

  upsertLiveContinuation(record: LiveRunContinuationRecord): void {
    upsertLiveContinuationInDb(this.db, record, this.bootGenerationValue);
  }

  deleteLiveContinuation(taskId: string, coordinatorId: string): void {
    deleteLiveContinuationFromDb(this.db, taskId, coordinatorId);
  }

  stampContinuationRunId(taskId: string, coordinatorId: string, runId: string): void {
    stampContinuationRunIdInDb(this.db, taskId, coordinatorId, runId);
  }

  claimQueuedLiveContinuation(
    taskId: string,
    coordinatorId: string,
    opts: { updatedAt?: string; allocationId?: string } = {},
  ): LiveRunContinuationRecord | undefined {
    return claimQueuedLiveContinuationInDb(this.db, taskId, coordinatorId, opts);
  }

  markLiveContinuationState(
    taskId: string,
    coordinatorId: string,
    state: LiveRunContinuationState,
    opts: {
      updatedAt?: string;
      allocationId?: string | null;
      lastError?: string | null;
    } = {},
  ): LiveRunContinuationRecord | undefined {
    return markLiveContinuationStateInDb(this.db, taskId, coordinatorId, state, opts);
  }

  getQueuePauseState(): QueuePauseState {
    return getQueuePauseStateFromDb(this.db);
  }

  setQueuePauseState(state: QueuePauseState): void {
    setQueuePauseStateInDb(this.db, state);
  }

  setTaskPause(record: TaskPauseRecord): void {
    setTaskPauseInDb(this.db, record);
  }

  deleteTaskPause(taskId: string, coordinatorId: string): boolean {
    return deleteTaskPauseFromDb(this.db, taskId, coordinatorId);
  }

  getTaskPause(taskId: string, coordinatorId: string): TaskPauseRecord | undefined {
    return getTaskPauseFromDb(this.db, taskId, coordinatorId);
  }

  listTaskPauses(): TaskPauseRecord[] {
    return listTaskPausesFromDb(this.db);
  }

  upsertHold(record: HoldRecord): void {
    upsertHoldInDb(this.db, record);
  }

  getHold(holdId: string): HoldRecord | undefined {
    return getHoldFromDb(this.db, holdId);
  }

  listHolds(opts: { includeInactive?: boolean } = {}): HoldRecord[] {
    return listHoldsFromDb(this.db, opts);
  }

  expireHolds(nowIso = new Date().toISOString()): number {
    return expireHoldsInDb(this.db, nowIso);
  }

  cancelHold(holdId: string, updatedAt = new Date().toISOString()): HoldRecord | undefined {
    return cancelHoldInDb(this.db, holdId, updatedAt);
  }

  addArtifactRecord(record: ArtifactRecord): void {
    addArtifactRecordInDb(this.db, record);
  }

  listArtifactRecords(taskId: string, kind?: ArtifactKind, coordinatorId?: string): ArtifactRecord[] {
    return listArtifactRecordsFromDb(this.db, taskId, kind, coordinatorId);
  }

  addPatchApplyAttempt(record: PatchApplyAttemptRecord): void {
    addPatchApplyAttemptInDb(this.db, record);
  }

  listPatchApplyAttempts(taskId?: string): PatchApplyAttemptRecord[] {
    return listPatchApplyAttemptsFromDb(this.db, taskId);
  }
}
