import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: _tmpHome } = withStaticTempCuttlefishHome("cuttlefish-external-outbox-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
});

beforeEach(() => {
  reg.initDb();
});

describe("external outbox registry", () => {
  it("upgrades a legacy outbox before creating its claim-expiry index", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE external_outbox (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        partition_key TEXT,
        idempotency_key TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        sink_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_attempt_at TEXT,
        delivered_at TEXT,
        remote_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
    `);

    reg.migrateExternalOutboxSchema(legacy);

    const columns = (legacy.prepare("PRAGMA table_info(external_outbox)").all() as Array<{ name: string }>).map((column) => column.name);
    const indexes = (legacy.prepare("PRAGMA index_list(external_outbox)").all() as Array<{ name: string }>).map((index) => index.name);
    expect(columns).toContain("claim_expires_at");
    expect(indexes).toContain("idx_external_outbox_claim_expiry");
    legacy.close();
  });

  it("creates, deduplicates, and updates durable outbox rows", () => {
    const first = reg.enqueueExternalOutboxItem({
      sinkName: "noop",
      envelope: {
        envelopeId: "env-1",
        producer: "cuttlefish",
        schemaVersion: "1",
        topic: "cuttlefish.checkpoint.decision.v1",
        occurredAt: "2026-06-26T00:00:00.000Z",
        idempotencyKey: "idem-1",
        partitionKey: "part-1",
        workspace: null,
        actor: null,
        sourceRef: "web:test",
        payload: { kind: "checkpoint" },
      },
    });
    const second = reg.enqueueExternalOutboxItem({
      sinkName: "noop",
      envelope: {
        envelopeId: "env-2",
        producer: "cuttlefish",
        schemaVersion: "1",
        topic: "cuttlefish.checkpoint.decision.v1",
        occurredAt: "2026-06-26T00:00:00.000Z",
        idempotencyKey: "idem-1",
        partitionKey: "part-1",
        workspace: null,
        actor: null,
        sourceRef: "web:test",
        payload: { kind: "checkpoint" },
      },
    });

    expect(second.id).toBe(first.id);
    expect(reg.listPendingExternalOutboxItems(10)).toHaveLength(1);
    expect(reg.claimPendingExternalOutboxItems(10).map((entry) => entry.id)).toContain(first.id);

    const failed = reg.markExternalOutboxFailed(first.id, "network down", "2026-06-26T00:10:00.000Z");
    expect(failed).toEqual(expect.objectContaining({
      status: "pending",
      attemptCount: 1,
      lastError: "network down",
      nextAttemptAt: "2026-06-26T00:10:00.000Z",
    }));

    const delivered = reg.markExternalOutboxDelivered(first.id, "remote-1");
    expect(delivered).toEqual(expect.objectContaining({
      status: "pending",
      remoteId: null,
    }));
  });

  it("leaves terminal rows unchanged when force-transition helpers run out of state", () => {
    const item = reg.enqueueExternalOutboxItem({
      sinkName: "noop",
      envelope: {
        envelopeId: "env-3",
        producer: "cuttlefish",
        schemaVersion: "1",
        topic: "cuttlefish.checkpoint.decision.v1",
        occurredAt: "2026-06-26T00:00:00.000Z",
        idempotencyKey: "idem-3",
        partitionKey: "part-3",
        workspace: null,
        actor: null,
        sourceRef: "web:test",
        payload: { kind: "checkpoint" },
      },
    });

    expect(reg.markExternalOutboxFailed(item.id, "network down", "2026-06-26T00:10:00.000Z")?.status).toBe("pending");
    expect(reg.markExternalOutboxDelivered(item.id, "remote-2")?.status).toBe("pending");
    expect(reg.claimPendingExternalOutboxItems(10).map((entry) => entry.id)).toContain(item.id);
    expect(reg.markExternalOutboxDelivered(item.id, "remote-2")?.status).toBe("delivered");
    expect(reg.markExternalOutboxFailed(item.id, "late failure", "2026-06-26T00:20:00.000Z")).toEqual(
      expect.objectContaining({ status: "delivered", lastError: null }),
    );
  });

  it("reclaims an expired sending lease so a post-crash relay can retry it", () => {
    const item = reg.enqueueExternalOutboxItem({
      sinkName: "noop",
      envelope: {
        envelopeId: "env-lease",
        producer: "cuttlefish",
        schemaVersion: "1",
        topic: "cuttlefish.session.summary.v1",
        occurredAt: "2026-06-26T00:00:00.000Z",
        idempotencyKey: "idem-lease",
        partitionKey: null,
        workspace: null,
        actor: null,
        sourceRef: "web:test",
        payload: { kind: "summary" },
      },
    });
    const claimedAt = new Date("2026-06-26T00:00:00.000Z");
    const claimed = reg.claimPendingExternalOutboxItems(100, claimedAt, 1_000).find((entry) => entry.id === item.id);

    expect(claimed).toMatchObject({ id: item.id, status: "sending", claimExpiresAt: "2026-06-26T00:00:01.000Z" });
    expect(reg.reclaimStaleExternalOutboxClaims(new Date("2026-06-26T00:00:00.999Z"))).toBe(0);
    expect(reg.reclaimStaleExternalOutboxClaims(new Date("2026-06-26T00:00:01.000Z"))).toBeGreaterThanOrEqual(1);
    expect(reg.getExternalOutboxItem(item.id)).toMatchObject({ status: "pending", claimExpiresAt: null });
    expect(reg.claimPendingExternalOutboxItems(100, new Date("2026-06-26T00:00:02.000Z")).some((entry) => entry.id === item.id)).toBe(true);
  });
});
