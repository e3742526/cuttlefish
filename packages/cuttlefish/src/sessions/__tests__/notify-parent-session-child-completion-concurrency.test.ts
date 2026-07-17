import { describe, expect, it } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

withStaticTempCuttlefishHome("cuttlefish-notify-parent-race-");
const reg = await import("../registry.js");
const callbacks = await import("../callbacks.js");

const originalFetch = globalThis.fetch;

describe("notifyParentSession — concurrent child completion (DAT-SESS-002)", () => {
  it("records both children's completions instead of one clobbering the other", async () => {
    reg.initDb();
    globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;

    try {
      const parent = reg.createSession({
        engine: "claude",
        source: "api",
        sourceRef: "manager-parent",
      });
      const child1 = reg.createSession({
        engine: "claude",
        source: "api",
        sourceRef: "child-1",
        parentSessionId: parent.id,
      });
      const child2 = reg.createSession({
        engine: "claude",
        source: "api",
        sourceRef: "child-2",
        parentSessionId: parent.id,
      });

      reg.patchSessionTransportMeta(parent.id, {
        managerDelegationEnforcement: {
          childSessionIds: [child1.id, child2.id],
          completedChildSessionIds: [],
        },
      });

      const parentBefore = reg.getSession(parent.id)!;
      const child1WithParent = { ...reg.getSession(child1.id)!, parentSessionId: parent.id };
      const child2WithParent = { ...reg.getSession(child2.id)!, parentSessionId: parent.id };

      // Two children of the same manager finishing near-simultaneously: fire
      // both callbacks back-to-back against the SAME stale in-memory `parent`
      // read (as notifyParentSession's own internal getSession call would also
      // do). Before the fix (getSession + updateSession as two unsynchronized
      // round-trips) the second write could clobber the first child's entry.
      expect(parentBefore.transportMeta).toMatchObject({
        managerDelegationEnforcement: { completedChildSessionIds: [] },
      });

      callbacks.notifyParentSession(child1WithParent, { result: "done-1" });
      callbacks.notifyParentSession(child2WithParent, { result: "done-2" });

      // Let fire-and-forget async work (network + logging) settle.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const parentAfter = reg.getSession(parent.id)!;
      const enforcement = (parentAfter.transportMeta as any)?.managerDelegationEnforcement;
      expect(enforcement.completedChildSessionIds).toEqual(
        expect.arrayContaining([child1.id, child2.id]),
      );
      expect(enforcement.completedChildSessionIds).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
