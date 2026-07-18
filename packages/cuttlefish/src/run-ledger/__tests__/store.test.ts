import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "../../shared/types.js";
import { RunLedgerStore } from "../store.js";
import {
  CANONICAL_RUN_STATES,
  RUN_EVENT_TYPES,
  runRecordSchema,
  runEventRecordSchema,
} from "../types.js";

let store: RunLedgerStore;

beforeEach(() => {
  store = RunLedgerStore.open(":memory:");
});

afterEach(() => {
  store.close();
});

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "web:1",
    connector: null,
    sessionKey: "web:1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    promptExcerpt: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    lastActivity: "2026-06-30T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

describe("RunLedgerStore schema + creation", () => {
  it("stamps the current schema version on open", () => {
    expect(store.getSchemaVersion()).toBe("1");
  });

  it("creates a run in the canonical 'created' state and emits a run_created event", () => {
    const run = store.createRun({
      runId: "run-1",
      sessionId: "sess-1",
      source: "web",
      sourceRef: "web:1",
      engine: "claude",
      title: "Title",
      promptExcerpt: "do the thing",
      createdAt: "2026-06-30T00:00:00.000Z",
    });

    expect(run.currentState).toBe("created");
    expect(run.startedAt).toBeNull();
    expect(run.completedAt).toBeNull();

    const persisted = store.getRun("run-1");
    expect(persisted).toBeDefined();
    expect(() => runRecordSchema.parse(persisted)).not.toThrow();

    const events = store.listEvents("run-1");
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("run_created");
    expect(events[0].toState).toBe("created");
  });
});

describe("RunLedgerStore lifecycle transitions", () => {
  it("can transition through every canonical run state", () => {
    for (const state of CANONICAL_RUN_STATES) {
      const runId = `run-${state}`;
      store.createRun({ runId, source: "web", sourceRef: "web:1", engine: "claude" });
      if (state === "created") {
        // already in 'created'; nothing to transition to.
        expect(store.getRun(runId)!.currentState).toBe("created");
        continue;
      }
      const after = store.transitionRun({
        runId,
        nextState: state,
        at: "2026-06-30T00:01:00.000Z",
      });
      expect(after.currentState).toBe(state);
    }
  });

  it("stamps startedAt on first 'running' transition and completedAt on 'completed'", () => {
    store.createRun({ runId: "run-1", source: "web", sourceRef: "web:1", engine: "claude" });

    const running = store.transitionRun({ runId: "run-1", nextState: "running", at: "2026-06-30T00:01:00.000Z" });
    expect(running.startedAt).toBe("2026-06-30T00:01:00.000Z");
    expect(running.completedAt).toBeNull();

    // startedAt must not move on a later transition.
    store.transitionRun({ runId: "run-1", nextState: "blocked", at: "2026-06-30T00:02:00.000Z" });
    const completed = store.transitionRun({ runId: "run-1", nextState: "completed", at: "2026-06-30T00:03:00.000Z" });
    expect(completed.startedAt).toBe("2026-06-30T00:01:00.000Z");
    expect(completed.completedAt).toBe("2026-06-30T00:03:00.000Z");
  });

  it("is a no-op when the next state equals the current state", () => {
    store.createRun({ runId: "run-1", source: "web", sourceRef: "web:1", engine: "claude" });
    store.transitionRun({ runId: "run-1", nextState: "running", at: "2026-06-30T00:01:00.000Z" });
    const before = store.listEvents("run-1").length;
    store.transitionRun({ runId: "run-1", nextState: "running", at: "2026-06-30T00:02:00.000Z" });
    expect(store.listEvents("run-1")).toHaveLength(before);
  });

  it("refuses to transition out of a terminal state (STT-RL-001)", () => {
    store.createRun({ runId: "run-1", source: "web", sourceRef: "web:1", engine: "claude" });
    store.transitionRun({ runId: "run-1", nextState: "running", at: "2026-06-30T00:01:00.000Z" });
    store.transitionRun({ runId: "run-1", nextState: "completed", at: "2026-06-30T00:02:00.000Z" });
    // A completed run must never be reactivated.
    expect(() => store.transitionRun({ runId: "run-1", nextState: "running", at: "2026-06-30T00:03:00.000Z" }))
      .toThrow(/terminal/i);
    // The terminal record is unchanged.
    expect(store.getRun("run-1")?.currentState).toBe("completed");

    store.createRun({ runId: "run-2", source: "web", sourceRef: "web:2", engine: "claude" });
    store.transitionRun({ runId: "run-2", nextState: "dead_lettered", at: "2026-06-30T00:02:00.000Z" });
    expect(() => store.transitionRun({ runId: "run-2", nextState: "blocked" })).toThrow(/terminal/i);
  });

  it("still allows recovery re-entry from non-terminal reporting states", () => {
    store.createRun({ runId: "run-1", source: "web", sourceRef: "web:1", engine: "claude" });
    store.transitionRun({ runId: "run-1", nextState: "running", at: "2026-06-30T00:01:00.000Z" });
    store.transitionRun({ runId: "run-1", nextState: "interrupted", at: "2026-06-30T00:02:00.000Z" });
    // interrupted is terminal for reporting but re-enterable by recovery.
    expect(() => store.transitionRun({ runId: "run-1", nextState: "running", at: "2026-06-30T00:03:00.000Z" }))
      .not.toThrow();
    expect(store.getRun("run-1")?.currentState).toBe("running");
  });

  it("records a run error on a failing transition", () => {
    store.createRun({ runId: "run-1", source: "web", sourceRef: "web:1", engine: "claude" });
    store.transitionRun({
      runId: "run-1",
      nextState: "failed",
      at: "2026-06-30T00:01:00.000Z",
      errorMessage: "boom",
      errorKind: "engine_error",
    });
    const errors = store.listRunErrors("run-1");
    expect(errors).toHaveLength(1);
    expect(errors[0].errorKind).toBe("engine_error");
    expect(errors[0].errorMessage).toBe("boom");
    expect(store.getRun("run-1")!.lastError).toBe("boom");
  });

  it("throws when transitioning an unknown run", () => {
    expect(() => store.transitionRun({ runId: "missing", nextState: "running" })).toThrow(/not found/);
  });
});

describe("RunLedgerStore event append/read round-trip", () => {
  it("returns events in created_at order and each validates against the schema", () => {
    store.createRun({ runId: "run-1", source: "web", sourceRef: "web:1", engine: "claude", createdAt: "2026-06-30T00:00:00.000Z" });
    store.transitionRun({ runId: "run-1", nextState: "running", at: "2026-06-30T00:01:00.000Z", payload: { a: 1 } });
    store.transitionRun({ runId: "run-1", nextState: "completed", at: "2026-06-30T00:02:00.000Z" });

    const events = store.listEvents("run-1");
    expect(events.map((e) => e.eventType)).toEqual(["run_created", "state_transition", "state_transition"]);
    for (const event of events) {
      expect(() => runEventRecordSchema.parse(event)).not.toThrow();
      expect(RUN_EVENT_TYPES).toContain(event.eventType);
    }
    // payload round-trips as a parsed JSON object.
    const running = events.find((e) => e.toState === "running");
    expect(running?.payload).toEqual({ a: 1 });
  });
});

describe("RunLedgerStore lineage + retry/replay links", () => {
  it("makes parent/child links queryable from the parent", () => {
    store.createRun({ runId: "parent", source: "web", sourceRef: "web:1", engine: "claude" });
    store.createRun({ runId: "child", source: "web", sourceRef: "web:2", engine: "claude", parentRunId: "parent" });

    const children = store.listChildRunLinks("parent");
    expect(children).toHaveLength(1);
    expect(children[0].childRunId).toBe("child");
    expect(children[0].relationType).toBe("spawned");
  });

  it("dedupes a repeated parent/child link", () => {
    store.createRun({ runId: "parent", source: "web", sourceRef: "web:1", engine: "claude" });
    store.createRun({ runId: "child", source: "web", sourceRef: "web:2", engine: "claude" });
    store.linkParentChildRun({ parentRunId: "parent", childRunId: "child" });
    store.linkParentChildRun({ parentRunId: "parent", childRunId: "child" });
    expect(store.listChildRunLinks("parent")).toHaveLength(1);
  });

  it("records retry and replay links with a run_linked event", () => {
    store.createRun({ runId: "orig", source: "web", sourceRef: "web:1", engine: "claude" });
    store.createRun({
      runId: "retry",
      source: "web",
      sourceRef: "web:1",
      engine: "claude",
      retryOfRunId: "orig",
    });
    store.createRun({
      runId: "replay",
      source: "web",
      sourceRef: "web:1",
      engine: "claude",
      replayOfRunId: "orig",
    });

    const retryLinks = store.listRetryReplayLinks("retry");
    expect(retryLinks).toHaveLength(1);
    expect(retryLinks[0]).toMatchObject({ relatedRunId: "orig", relationType: "retry" });

    const replayLinks = store.listRetryReplayLinks("replay");
    expect(replayLinks[0]).toMatchObject({ relatedRunId: "orig", relationType: "replay" });

    expect(store.listEvents("retry").some((e) => e.eventType === "run_linked")).toBe(true);
  });
});

describe("RunLedgerStore artifact + policy references", () => {
  it("stores an artifact reference and an artifact_linked event", () => {
    store.createRun({ runId: "run-1", source: "web", sourceRef: "web:1", engine: "claude" });
    store.addArtifactReference({
      runId: "run-1",
      artifactId: "art-1",
      relation: "produced",
      locator: "file:///out.txt",
      createdAt: "2026-06-30T00:01:00.000Z",
    });
    const refs = store.listArtifactReferences("run-1");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ artifactId: "art-1", relation: "produced" });
    expect(store.listEvents("run-1").some((e) => e.eventType === "artifact_linked")).toBe(true);
  });

  it("stores a policy snapshot reference and a policy_snapshot_linked event", () => {
    store.createRun({ runId: "run-1", source: "web", sourceRef: "web:1", engine: "claude" });
    store.addPolicySnapshotReference({
      runId: "run-1",
      policyScope: "project",
      snapshotId: "snap-1",
      createdAt: "2026-06-30T00:01:00.000Z",
    });
    const refs = store.listPolicySnapshotReferences("run-1");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ policyScope: "project", snapshotId: "snap-1" });
    expect(store.listEvents("run-1").some((e) => e.eventType === "policy_snapshot_linked")).toBe(true);
  });
});

describe("RunLedgerStore.syncSessionUpdate status mapping", () => {
  function runWithSession(status: Session["status"]): { runId: string; session: Session } {
    const runId = "run-1";
    store.createRun({ runId, sessionId: "sess-1", source: "web", sourceRef: "web:1", engine: "claude" });
    const session = makeSession({ status, transportMeta: { activeRunId: runId } });
    return { runId, session };
  }

  it("maps session 'running' to canonical 'running'", () => {
    const { runId, session } = runWithSession("idle");
    const after = makeSession({ status: "running", transportMeta: { activeRunId: runId }, lastActivity: "2026-06-30T00:05:00.000Z" });
    const result = store.syncSessionUpdate({ before: session, after });
    expect(result?.currentState).toBe("running");
  });

  it("maps session 'waiting' to canonical 'blocked'", () => {
    const { runId, session } = runWithSession("running");
    const after = makeSession({ status: "waiting", transportMeta: { activeRunId: runId } });
    expect(store.syncSessionUpdate({ before: session, after })?.currentState).toBe("blocked");
  });

  it("maps session 'error' to canonical 'failed' and records the error", () => {
    const { runId, session } = runWithSession("running");
    const after = makeSession({ status: "error", lastError: "kaboom", transportMeta: { activeRunId: runId } });
    const result = store.syncSessionUpdate({ before: session, after });
    expect(result?.currentState).toBe("failed");
    expect(store.listRunErrors(runId).some((e) => e.errorMessage === "kaboom")).toBe(true);
  });

  it("maps a running→idle settle to canonical 'completed'", () => {
    const { runId, session } = runWithSession("running");
    store.transitionRun({ runId, nextState: "running", at: "2026-06-30T00:01:00.000Z" });
    const after = makeSession({ status: "idle", transportMeta: { activeRunId: runId }, lastActivity: "2026-06-30T00:05:00.000Z" });
    const result = store.syncSessionUpdate({ before: session, after });
    expect(result?.currentState).toBe("completed");
    expect(result?.completedAt).toBe("2026-06-30T00:05:00.000Z");
  });

  it("does not mark 'completed' on an idle→idle update with no prior active work", () => {
    const { runId, session } = runWithSession("idle");
    const after = makeSession({ status: "idle", transportMeta: { activeRunId: runId } });
    const result = store.syncSessionUpdate({ before: session, after });
    expect(result?.currentState).toBe("created");
  });

  it("returns undefined when the session carries no run id", () => {
    const before = makeSession({ status: "idle" });
    const after = makeSession({ status: "running" });
    expect(store.syncSessionUpdate({ before, after })).toBeUndefined();
  });
});

describe("RunLedgerStore.open — corruption quarantine (FSR-CF-001)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-ledger-corrupt-"));
    dbPath = path.join(dir, "run-ledger.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("quarantines a corrupt DB file and boots fresh instead of throwing", () => {
    // Write bytes that are not a valid SQLite database.
    fs.writeFileSync(dbPath, "this is not a sqlite database at all");

    // Opening must NOT throw — it should quarantine and rebuild.
    const store = RunLedgerStore.open(dbPath);
    try {
      // Fresh, usable ledger.
      store.createRun({ runId: "r1", source: "web", sourceRef: "web:1", engine: "claude" });
      expect(store.getRun("r1")?.currentState).toBe("created");
    } finally {
      store.close();
    }

    // The corrupt original was renamed aside for forensics.
    const quarantined = fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(quarantined.length).toBe(1);
  });

  it("opens a healthy on-disk DB normally", () => {
    const store = RunLedgerStore.open(dbPath);
    store.createRun({ runId: "r1", source: "web", sourceRef: "web:1", engine: "claude" });
    store.close();
    const reopened = RunLedgerStore.open(dbPath);
    try {
      expect(reopened.getRun("r1")?.currentState).toBe("created");
      expect(fs.readdirSync(dir).filter((f) => f.includes(".corrupt-")).length).toBe(0);
    } finally {
      reopened.close();
    }
  });
});

describe("RunLedgerStore.open — file permissions (SEC-CFDB-001)", () => {
  let permDir: string;
  let permDbPath: string;

  beforeEach(() => {
    permDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-run-ledger-perm-"));
    permDbPath = path.join(permDir, "run-ledger.db");
  });

  afterEach(() => {
    fs.rmSync(permDir, { recursive: true, force: true });
  });

  it("creates the run-ledger DB file with owner-only (0600) permissions", () => {
    const permStore = RunLedgerStore.open(permDbPath);
    try {
      const mode = fs.statSync(permDbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      permStore.close();
    }
  });

  it("tightens a pre-existing world-readable DB file back to 0600 on open", () => {
    const first = RunLedgerStore.open(permDbPath);
    first.close();
    fs.chmodSync(permDbPath, 0o644); // simulate a pre-hardening world-readable install

    const reopened = RunLedgerStore.open(permDbPath);
    try {
      const mode = fs.statSync(permDbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      reopened.close();
    }
  });
});
