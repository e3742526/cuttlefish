import { describe, expect, it } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

withStaticTempCuttlefishHome("cuttlefish-get-or-create-session-");
const reg = await import("../registry.js");

describe("getOrCreateSessionBySessionKey", () => {
  it("creates exactly one session for a brand-new session_key", () => {
    reg.initDb();
    const key = "first-contact-key";

    const { session, created } = reg.getOrCreateSessionBySessionKey(key, {
      engine: "claude",
      source: "slack",
      sourceRef: key,
      sessionKey: key,
    });

    expect(created).toBe(true);
    expect(session.sessionKey).toBe(key);
  });

  it("does not create a second row when the session_key already exists (check-then-act is atomic)", () => {
    reg.initDb();
    const key = "race-session-key";

    // Two near-simultaneous "first contact" messages for the same new
    // session_key: previously getSessionBySessionKey + createSession were two
    // separate unsynchronized statements, so both calls could miss the getter
    // and both insert a row (split-brain conversation, one half unreachable).
    // getOrCreateSessionBySessionKey wraps the check-then-act in a single
    // db.transaction so the second call must observe the first call's insert.
    const first = reg.getOrCreateSessionBySessionKey(key, {
      engine: "claude",
      source: "slack",
      sourceRef: key,
      sessionKey: key,
    });
    const second = reg.getOrCreateSessionBySessionKey(key, {
      engine: "claude",
      source: "slack",
      sourceRef: key,
      sessionKey: key,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);

    const db = reg.initDb();
    const rows = db.prepare("SELECT id FROM sessions WHERE session_key = ?").all(key) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });
});
