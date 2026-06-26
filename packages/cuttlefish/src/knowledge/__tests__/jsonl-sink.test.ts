import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlKnowledgeSink } from "../sinks/jsonl.js";

describe("JsonlKnowledgeSink", () => {
  it("creates parent directories and appends envelopes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-knowledge-jsonl-"));
    const file = path.join(dir, "nested", "outbox.jsonl");
    const sink = new JsonlKnowledgeSink(file);

    await sink.emit([{
      envelopeId: "env-1",
      producer: "cuttlefish",
      schemaVersion: "1",
      topic: "cuttlefish.session.summary.v1",
      occurredAt: "2026-06-26T00:00:00.000Z",
      idempotencyKey: "idem-1",
      partitionKey: null,
      workspace: null,
      actor: null,
      sourceRef: "web:test",
      payload: { ok: true },
    }]);

    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ topic: "cuttlefish.session.summary.v1" });
  });
});
