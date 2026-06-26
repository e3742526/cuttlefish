import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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

    const failed = reg.markExternalOutboxFailed(first.id, "network down", "2026-06-26T00:10:00.000Z");
    expect(failed).toEqual(expect.objectContaining({
      attemptCount: 1,
      lastError: "network down",
      nextAttemptAt: "2026-06-26T00:10:00.000Z",
    }));

    const delivered = reg.markExternalOutboxDelivered(first.id, "remote-1");
    expect(delivered).toEqual(expect.objectContaining({
      status: "delivered",
      remoteId: "remote-1",
    }));
  });
});
