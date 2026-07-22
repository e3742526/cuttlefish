import { beforeAll, describe, expect, it } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

withStaticTempCuttlefishHome("cuttlefish-collaboration-registry-");

type Registry = typeof import("../registry.js");
let registry: Registry;

beforeAll(async () => {
  registry = await import("../registry.js");
  registry.initDb();
});

describe("communication event persistence", () => {
  it("installs the append-only table with session foreign keys and is idempotent", () => {
    const db = registry.initDb();
    const columns = db.prepare("PRAGMA table_info(communication_events)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("delivery_receipts_json");
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(communication_events)").all() as Array<{ table: string; on_delete: string }>;
    expect(foreignKeys).toHaveLength(2);
    expect(foreignKeys.every((foreignKey) => foreignKey.table === "sessions" && foreignKey.on_delete === "CASCADE")).toBe(true);
    expect(() => registry.initDb()).not.toThrow();
  });

  it("round-trips attribution, receipts, references, and metadata", () => {
    const root = registry.createSession({ engine: "codex", source: "web", sourceRef: "collab:event-root", prompt: "root" });
    const event = registry.insertCommunicationEvent({
      id: "event-round-trip",
      lane: "team",
      projectRootSessionId: root.id,
      sessionId: root.id,
      kind: "message",
      author: { kind: "operator", id: "human", displayName: "You" },
      recipients: ["worker"],
      content: "hello",
      timestamp: 42,
      deliveryReceipts: [{ recipientId: "worker", sessionId: root.id, state: "queued" }],
      referencedMessageIds: ["message-1"],
      metadata: { oneTurn: true },
    });
    expect(event).toMatchObject({ id: "event-round-trip", attribution: "recorded" });
    expect(registry.listCommunicationEvents({ lane: "team", projectRootSessionId: root.id })).toEqual([
      expect.objectContaining({
        id: "event-round-trip",
        recipients: ["worker"],
        referencedMessageIds: ["message-1"],
        metadata: { oneTurn: true },
      }),
    ]);
  });
});

describe("atomic project-tree deletion", () => {
  function project(prefix: string) {
    const root = registry.createSession({ engine: "codex", source: "web", sourceRef: `${prefix}:root`, prompt: `${prefix} root`, title: `${prefix} title` });
    const child = registry.createSession({ engine: "codex", source: "web", sourceRef: `${prefix}:child`, parentSessionId: root.id, prompt: "child" });
    const grandchild = registry.createSession({ engine: "codex", source: "web", sourceRef: `${prefix}:grandchild`, parentSessionId: child.id, prompt: "grandchild" });
    return { root, child, grandchild, ids: [root.id, child.id, grandchild.id] };
  }

  it("rejects stale counts and active descendants without deleting anything", () => {
    const tree = project("blocked");
    expect(registry.deleteSessionTreeAtomically({
      rootSessionId: tree.root.id,
      expectedTitle: tree.root.title!,
      expectedSessionCount: 2,
    })).toMatchObject({ ok: false, code: "stale_count", actualCount: 3 });
    registry.updateSession(tree.child.id, { status: "waiting" });
    expect(registry.deleteSessionTreeAtomically({
      rootSessionId: tree.root.id,
      expectedTitle: tree.root.title!,
      expectedSessionCount: 3,
    })).toMatchObject({ ok: false, code: "active", activeSessionIds: [tree.child.id] });
    expect(tree.ids.every((id) => registry.getSession(id))).toBe(true);
  });

  it("deletes the complete nested tree and its owned rows in one transaction", () => {
    const tree = project("delete");
    registry.insertMessage(tree.child.id, "user", "remove me");
    registry.insertCommunicationEvent({
      lane: "team",
      projectRootSessionId: tree.root.id,
      sessionId: tree.child.id,
      kind: "status",
      author: { kind: "system", displayName: "System" },
      content: "remove event",
    });
    const result = registry.deleteSessionTreeAtomically({
      rootSessionId: tree.root.id,
      expectedTitle: tree.root.title!,
      expectedSessionCount: 3,
    });
    expect(result).toMatchObject({ ok: true });
    expect(tree.ids.every((id) => !registry.getSession(id))).toBe(true);
    expect(registry.listCommunicationEvents({ lane: "team", projectRootSessionId: tree.root.id })).toEqual([]);
  });

  it("rolls back all owned-row deletion if the session delete fails", () => {
    const tree = project("rollback");
    const messageId = registry.insertMessage(tree.child.id, "user", "survive rollback");
    const db = registry.initDb();
    db.exec(`CREATE TRIGGER fail_project_delete BEFORE DELETE ON sessions WHEN old.id = '${tree.root.id}' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;`);
    expect(() => registry.deleteSessionTreeAtomically({
      rootSessionId: tree.root.id,
      expectedTitle: tree.root.title!,
      expectedSessionCount: 3,
    })).toThrow(/forced rollback/);
    db.exec("DROP TRIGGER fail_project_delete");
    expect(tree.ids.every((id) => registry.getSession(id))).toBe(true);
    expect(registry.getMessages(tree.child.id).some((message) => message.id === messageId)).toBe(true);
  });
});

