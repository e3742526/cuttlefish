import { describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// Fresh CUTTLEFISH_HOME (and fresh module registry, via vi.resetModules()) per
// test, so each test gets its own isolated sessions.db — recoverStaleQueueItems
// operates DB-wide, and isolation keeps that assertable per test.
withTempCuttlefishHome("cuttlefish-registry-queue-");

async function setup() {
  const reg = await import("../registry.js");
  reg.initDb();
  return reg;
}

function makeSession(reg: Awaited<ReturnType<typeof setup>>, sourceRef: string) {
  return reg.createSession({ engine: "claude", source: "web", sourceRef });
}

describe("registry/queue.ts — FSR-CF-007 atomic dispatch claim", () => {
  it("markQueueItemRunning is a compare-and-swap: only one caller can claim a given item", async () => {
    const reg = await setup();
    const session = makeSession(reg, "web:claim-1");
    const itemId = reg.enqueueQueueItem(session.id, session.sessionKey, "do the thing");

    const firstClaim = reg.markQueueItemRunning(itemId);
    expect(firstClaim).toBe(true);
    expect(reg.getQueueItem(itemId)?.status).toBe("running");

    // A second, "racing" claim attempt on the same item — simulating a second
    // dispatcher observing the item before the first claim's dispatch/
    // completion is recorded — must lose the race and report no claim, so
    // the caller knows not to dispatch a second engine turn for it.
    const secondClaim = reg.markQueueItemRunning(itemId);
    expect(secondClaim).toBe(false);
    expect(reg.getQueueItem(itemId)?.status).toBe("running");
  });

  it("claim, then crash before dispatch is durably recorded: recovery reclaims the item but never lets two live claims coexist", async () => {
    const reg = await setup();
    const session = makeSession(reg, "web:claim-crash");
    const itemId = reg.enqueueQueueItem(session.id, session.sessionKey, "do the thing");

    // Claim durably commits before any engine call would be made.
    expect(reg.markQueueItemRunning(itemId)).toBe(true);
    expect(reg.getQueueItem(itemId)?.status).toBe("running");

    // Crash: the process dies here — markQueueItemCompleted() is never called,
    // and no "dispatched" checkpoint exists beyond the claim itself.

    // Restart: boot-time recovery finds the orphaned 'running' row and hands
    // it back to 'pending' so it isn't stranded forever.
    const recovered = reg.recoverStaleQueueItems();
    expect(recovered).toBe(1);
    expect(reg.getQueueItem(itemId)?.status).toBe("pending");
    expect(reg.getQueueItem(itemId)?.startedAt).toBeNull();

    // Post-recovery, the item is claimable again exactly once — the new
    // process becomes the sole owner of the (re)dispatch, matching the
    // invariant proven above: at most one live claim ever exists at a time.
    expect(reg.markQueueItemRunning(itemId)).toBe(true);
    expect(reg.markQueueItemRunning(itemId)).toBe(false);
  });

  it("recoverStaleQueueItems only resets orphaned 'running' rows — it never re-arms settled items", async () => {
    const reg = await setup();
    const session = makeSession(reg, "web:recover-scope");
    const runningId = reg.enqueueQueueItem(session.id, session.sessionKey, "in flight");
    const completedId = reg.enqueueQueueItem(session.id, session.sessionKey, "already done");
    const cancelledId = reg.enqueueQueueItem(session.id, session.sessionKey, "cancelled");
    const pendingId = reg.enqueueQueueItem(session.id, session.sessionKey, "never started");

    reg.markQueueItemRunning(runningId);

    reg.markQueueItemRunning(completedId);
    reg.markQueueItemCompleted(completedId);

    reg.cancelQueueItem(cancelledId);

    expect(reg.recoverStaleQueueItems()).toBe(1);

    expect(reg.getQueueItem(runningId)?.status).toBe("pending");
    expect(reg.getQueueItem(completedId)?.status).toBe("completed");
    expect(reg.getQueueItem(cancelledId)?.status).toBe("cancelled");
    expect(reg.getQueueItem(pendingId)?.status).toBe("pending");
  });

  it("markQueueItemRunning refuses to claim a non-pending item (cannot resurrect cancelled/completed rows)", async () => {
    const reg = await setup();
    const session = makeSession(reg, "web:claim-guard");
    const itemId = reg.enqueueQueueItem(session.id, session.sessionKey, "do the thing");
    expect(reg.cancelQueueItem(itemId)).toBe(true);

    expect(reg.markQueueItemRunning(itemId)).toBe(false);
    expect(reg.getQueueItem(itemId)?.status).toBe("cancelled");
  });
});

describe("registry/queue.ts — DAT-SESS-007 atomic position assignment", () => {
  it("enqueueQueueItem assigns unique positions across a batch of enqueues for the same session key", async () => {
    const reg = await setup();
    const session = makeSession(reg, "web:positions");

    // better-sqlite3 is synchronous, so genuine thread-level concurrency isn't
    // reproducible here; what we can prove is that the read+insert is one
    // atomic unit (no other statement can interleave inside the transaction),
    // which is exactly what removes the race. Fire a batch of enqueues and
    // assert every resulting position is unique with no duplicates.
    const ids = Array.from({ length: 25 }, (_, i) =>
      reg.enqueueQueueItem(session.id, session.sessionKey, `task-${i}`),
    );

    const items = reg.getQueueItems(session.sessionKey);
    expect(items).toHaveLength(25);
    const positions = items.map((item) => item.position);
    const uniquePositions = new Set(positions);
    expect(uniquePositions.size).toBe(positions.length);
    expect(new Set(items.map((item) => item.id))).toEqual(new Set(ids));
  });

  it("rolls back the position read if the insert fails mid-transaction (proves it's one atomic unit)", async () => {
    const reg = await setup();
    const session = makeSession(reg, "web:positions-rollback");
    reg.enqueueQueueItem(session.id, session.sessionKey, "existing-1");

    const db = reg.initDb();
    const originalPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("INSERT INTO queue_items")) {
        throw new Error("injected insert failure");
      }
      return originalPrepare(sql);
    });

    expect(() => reg.enqueueQueueItem(session.id, session.sessionKey, "should-not-land")).toThrow(
      /injected insert failure/,
    );
    spy.mockRestore();

    // The failed attempt must leave no trace, and the next real enqueue must
    // still compute its position from the untouched prior state (1 -> 2),
    // not from any partially-applied read.
    const items = reg.getQueueItems(session.sessionKey);
    expect(items).toHaveLength(1);
    const nextId = reg.enqueueQueueItem(session.id, session.sessionKey, "existing-2");
    const next = reg.getQueueItem(nextId);
    expect(next?.position).toBe(2);
  });
});
