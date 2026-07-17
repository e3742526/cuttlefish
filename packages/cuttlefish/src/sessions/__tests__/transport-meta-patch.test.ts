import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-transport-meta-");
const reg = await import("../registry.js");
const { logger } = await import("../../shared/logger.js");

describe("patchSessionTransportMeta", () => {
  it("merges against the latest stored transportMeta", () => {
    reg.initDb();
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "meta",
      transportMeta: { a: "1" },
    });

    reg.patchSessionTransportMeta(session.id, { b: "2" });
    const updated = reg.patchSessionTransportMeta(session.id, (current) => ({ ...current, c: "3" }));

    expect(updated?.transportMeta).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns undefined for a missing session", () => {
    reg.initDb();
    expect(reg.patchSessionTransportMeta("missing", { b: "2" })).toBeUndefined();
  });

  it("logs a warning identifying the session when transport_meta is corrupt, instead of silently resetting it", () => {
    const db = reg.initDb();
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "corrupt-meta",
      transportMeta: { a: "1" },
    });
    // Simulate on-disk corruption directly (bypassing the normal JSON.stringify
    // write path) so the next patch has to parse malformed JSON.
    db.prepare("UPDATE sessions SET transport_meta = ? WHERE id = ?").run("{not-valid-json", session.id);

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const updated = reg.patchSessionTransportMeta(session.id, { b: "2" });

      // Fallback-to-{} behavior is preserved...
      expect(updated?.transportMeta).toEqual({ b: "2" });
      // ...but the data loss is no longer silent: the warning names the session.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(session.id));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("transport_meta"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
