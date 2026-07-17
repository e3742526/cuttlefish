import { describe, it, expect, beforeAll, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from CUTTLEFISH_HOME).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-partial-");

type Reg = typeof import("../registry.js");
let reg: Reg;
type MessagesModule = typeof import("../registry/messages.js");
let messagesModule: MessagesModule;

function newSession(id: string): void {
  reg.initDb().prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude','web',?, 'running','t','t')",
  ).run(id, `web:${id}`);
}

beforeAll(async () => {
  reg = await import("../registry.js");
  messagesModule = await import("../registry/messages.js");
});

describe("messages partial (mid-turn streaming) blocks", () => {
  it("adds nullable partial/seq/tool_call columns on init", () => {
    const db = reg.initDb();
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("partial");
    expect(cols).toContain("seq");
    expect(cols).toContain("tool_call");
    expect(cols).toContain("blocks");
  });

  it("persists partial blocks in seq order with tool metadata, then wipes them", () => {
    newSession("p1");
    // Simulate a turn: text block, tool call, text block.
    const t1 = reg.insertPartialMessage("p1", "assistant", "Let me check", 0);
    reg.insertPartialMessage("p1", "assistant", "Using Bash", 1, "Bash");
    reg.insertPartialMessage("p1", "assistant", "Found it", 2);

    let msgs = reg.getMessages("p1");
    expect(msgs.map((m) => m.content)).toEqual(["Let me check", "Using Bash", "Found it"]);
    expect(msgs.every((m) => m.partial === true)).toBe(true);
    expect(msgs[1].toolCall).toBe("Bash");
    expect(msgs[0].toolCall).toBeUndefined();

    // Growing the current text block in place (debounced streaming).
    reg.updatePartialMessage(t1, "Let me check the logs");
    expect(reg.getMessages("p1")[0].content).toBe("Let me check the logs");

    // Turn end: wipe partials, insert the single consolidated final message.
    const removed = reg.deletePartialMessages("p1");
    expect(removed).toBe(3);
    reg.insertMessage("p1", "assistant", "Done — found the bug in logs.");

    msgs = reg.getMessages("p1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Done — found the bug in logs.");
    expect(msgs[0].partial).toBeUndefined();
  });

  it("orders blocks by seq even when timestamps collide", () => {
    newSession("p2");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    // Insert out of seq order; getMessages must return them seq-ascending.
    try {
      reg.insertPartialMessage("p2", "assistant", "third", 2);
      reg.insertPartialMessage("p2", "assistant", "first", 0);
      reg.insertPartialMessage("p2", "assistant", "second", 1);
      expect(reg.getMessages("p2").map((m) => m.content)).toEqual(["first", "second", "third"]);
    } finally {
      now.mockRestore();
    }
  });

  it("deletePartialMessages leaves final (non-partial) rows untouched", () => {
    newSession("p3");
    reg.insertMessage("p3", "user", "hi");
    reg.insertMessage("p3", "assistant", "a real prior answer");
    reg.insertPartialMessage("p3", "assistant", "streaming...", 0);

    expect(reg.deletePartialMessages("p3")).toBe(1);
    const msgs = reg.getMessages("p3");
    expect(msgs.map((m) => m.content)).toEqual(["hi", "a real prior answer"]);
  });

  it("can finalize partial blocks into canonical history", () => {
    newSession("p3b");
    reg.insertPartialMessage("p3b", "assistant", "Using run_command", 0, "run_command");
    reg.insertPartialMessage("p3b", "assistant", "Done", 1);

    expect(reg.finalizePartialMessages("p3b")).toBe(2);
    const msgs = reg.getMessages("p3b");
    expect(msgs.map((m) => m.content)).toEqual(["Using run_command", "Done"]);
    expect(msgs.some((m) => m.partial)).toBe(false);
    expect(msgs[0].toolCall).toBe("run_command");
  });

  it("clearAllPartialMessages sweeps strays across sessions (boot recovery)", () => {
    newSession("p4");
    newSession("p5");
    reg.insertPartialMessage("p4", "assistant", "stray a", 0);
    reg.insertPartialMessage("p5", "assistant", "stray b", 0);
    reg.insertMessage("p4", "assistant", "kept");

    const swept = reg.clearAllPartialMessages();
    expect(swept).toBeGreaterThanOrEqual(2);
    expect(reg.getMessages("p4").map((m) => m.content)).toEqual(["kept"]);
    expect(reg.getMessages("p5")).toHaveLength(0);
  });

  it("clearAllPartialMessages quarantines stray partials instead of deleting them (FSR-CF-008)", () => {
    newSession("p6");
    reg.insertPartialMessage("p6", "assistant", "crash-interrupted content", 0, "Bash");

    const swept = reg.clearAllPartialMessages();
    expect(swept).toBeGreaterThanOrEqual(1);

    // Quarantined rows must not resurface in the normal read path...
    expect(reg.getMessages("p6")).toHaveLength(0);

    // ...but the content must not be silently lost: it stays inspectable via
    // the quarantine path, and the underlying row is still physically present
    // in the messages table (not DELETEd).
    const quarantined = messagesModule.getQuarantinedMessages("p6");
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].content).toBe("crash-interrupted content");
    expect(quarantined[0].toolCall).toBe("Bash");
    expect(quarantined[0].sessionId).toBe("p6");

    const row = reg
      .initDb()
      .prepare("SELECT content, partial FROM messages WHERE session_id = ?")
      .get("p6") as { content: string; partial: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.content).toBe("crash-interrupted content");
    expect(row?.partial).toBe(2);

    // Global (cross-session) quarantine listing also finds it.
    expect(messagesModule.getQuarantinedMessages().some((m) => m.id === quarantined[0].id)).toBe(true);
  });

  it("persists structured block messages and applies patch/remove by block id", () => {
    newSession("block-1");
    reg.applyBlockEnvelope("block-1", {
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
    });

    let msgs = reg.getMessages("block-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Plan: 1 item");
    expect(msgs[0].blocks?.[0]?.id).toBe("plan");

    reg.applyBlockEnvelope("block-1", {
      op: "patch",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        status: "done",
        payload: { summary: "Complete" },
      },
    });

    msgs = reg.getMessages("block-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks?.[0]?.status).toBe("done");
    expect(msgs[0].blocks?.[0]?.payload).toMatchObject({ summary: "Complete" });

    reg.applyBlockEnvelope("block-1", {
      op: "remove",
      block: { id: "plan", type: "task-list", version: 1, payload: {} },
    });
    expect(reg.getMessages("block-1")).toEqual([]);
  });

  it("updates synthetic block row text created with custom fallback text", () => {
    newSession("block-custom-patch");
    reg.applyBlockEnvelope("block-custom-patch", {
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
    }, "Plan running.");

    reg.applyBlockEnvelope("block-custom-patch", {
      op: "patch",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        status: "done",
        payload: { summary: "Complete" },
      },
    }, "Plan complete.");

    const msgs = reg.getMessages("block-custom-patch");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Plan complete.");
    expect(msgs[0].blocks?.[0]?.status).toBe("done");
  });

  it("ignores patch-first block envelopes", () => {
    newSession("block-patch-first");
    const id = reg.applyBlockEnvelope("block-patch-first", {
      op: "patch",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        status: "done",
        payload: { summary: "Complete" },
      },
    }, "Plan complete.");

    expect(id).toBeNull();
    expect(reg.getMessages("block-patch-first")).toEqual([]);
  });

  it("removes synthetic block rows created with custom fallback text", () => {
    newSession("block-custom-remove");
    reg.applyBlockEnvelope("block-custom-remove", {
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
    }, "Plan");

    reg.applyBlockEnvelope("block-custom-remove", {
      op: "remove",
      block: { id: "plan", type: "task-list", version: 1, payload: {} },
    }, "Plan");

    expect(reg.getMessages("block-custom-remove")).toEqual([]);
  });

  it("keeps mixed answer text when removing a block", () => {
    newSession("block-mixed-remove");
    reg.insertMessage("block-mixed-remove", "assistant", "Keep this answer", undefined, [{
      id: "plan",
      type: "task-list",
      version: 1,
      title: "Plan",
      payload: { items: [{ id: "a", text: "Read code" }] },
    }]);

    reg.applyBlockEnvelope("block-mixed-remove", {
      op: "remove",
      block: { id: "plan", type: "task-list", version: 1, payload: {} },
    }, "Plan");

    const msgs = reg.getMessages("block-mixed-remove");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Keep this answer");
    expect(msgs[0].blocks).toBeUndefined();
  });

  it("can persist structured block messages as partial turn state", () => {
    newSession("block-partial");
    reg.applyBlockEnvelope("block-partial", {
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
    }, undefined, { partial: true, seq: 0 });

    let msgs = reg.getMessages("block-partial");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].partial).toBe(true);
    expect(msgs[0].blocks?.[0]?.id).toBe("plan");

    expect(reg.deletePartialMessages("block-partial")).toBe(1);
    msgs = reg.getMessages("block-partial");
    expect(msgs).toEqual([]);
  });

  it("can move streamed block state onto the final assistant message", () => {
    newSession("block-final");
    const block = {
      id: "plan:t1",
      type: "task-list" as const,
      version: 1,
      title: "Plan",
      payload: { items: [{ id: "a", text: "Read code", status: "done" }] },
    };

    reg.applyBlockEnvelope("block-final", {
      op: "put",
      block,
    }, undefined, { partial: true, seq: 0 });

    const streamedBlocks = reg.getMessages("block-final").flatMap((message) => message.blocks ?? []);
    expect(reg.deletePartialMessages("block-final")).toBe(1);
    reg.insertMessage("block-final", "assistant", "Done.", undefined, streamedBlocks);

    const msgs = reg.getMessages("block-final");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].partial).toBeUndefined();
    expect(msgs[0].content).toBe("Done.");
    expect(msgs[0].blocks).toEqual([block]);
  });

  it("drops obsolete stored block types when reading messages", () => {
    newSession("block-legacy-types");
    reg.initDb().prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp, blocks) VALUES ('legacy-blocks', ?, 'assistant', 'Mixed blocks', ?, ?)",
    ).run("block-legacy-types", Date.now(), JSON.stringify([
      {
        id: "old-diff",
        type: "diff",
        version: 1,
        payload: { hunks: [{ before: "old", after: "new" }] },
      },
      {
        id: "plan",
        type: "task-list",
        version: 1,
        payload: { items: [{ id: "a", text: "Read code" }] },
      },
    ]));

    const msgs = reg.getMessages("block-legacy-types");
    expect(msgs[0].blocks?.map((block) => block.id)).toEqual(["plan"]);
  });

  it("removing a block from a mixed row preserves the row text", () => {
    newSession("block-mixed");
    reg.initDb().prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp, blocks) VALUES ('mixed', ?, 'assistant', 'Keep this answer text', ?, ?)",
    ).run("block-mixed", Date.now(), JSON.stringify([{
      id: "plan",
      type: "task-list",
      version: 1,
      title: "Plan",
      payload: { items: [{ id: "a", text: "Read code" }] },
    }]));

    reg.applyBlockEnvelope("block-mixed", {
      op: "remove",
      block: { id: "plan", type: "task-list", version: 1, payload: {} },
    });

    const msgs = reg.getMessages("block-mixed");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Keep this answer text");
    expect(msgs[0].blocks).toBeUndefined();
  });

  it("patching a block on a mixed row preserves the row text", () => {
    newSession("block-mixed-patch");
    reg.initDb().prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp, blocks) VALUES ('mixed-patch', ?, 'assistant', 'Keep this answer text', ?, ?)",
    ).run("block-mixed-patch", Date.now(), JSON.stringify([{
      id: "plan",
      type: "task-list",
      version: 1,
      title: "Plan",
      payload: { items: [{ id: "a", text: "Read code" }] },
    }]));

    reg.applyBlockEnvelope("block-mixed-patch", {
      op: "patch",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        status: "done",
        payload: { summary: "Complete" },
      },
    }, "Plan complete");

    const msgs = reg.getMessages("block-mixed-patch");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Keep this answer text");
    expect(msgs[0].blocks?.[0]?.status).toBe("done");
  });

  it("migrates a legacy message DB lacking the new columns", () => {
    const legacyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-legacy-p-")), "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.exec(
      "CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL)",
    );
    legacy.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m1','s','user','old',1)").run();

    reg.migrateMessagesSchema(legacy);

    const cols = (legacy.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("partial");
    expect(cols).toContain("seq");
    expect(cols).toContain("tool_call");
    expect(cols).toContain("blocks");
    const row = legacy.prepare("SELECT content, partial, seq, tool_call, blocks FROM messages WHERE id='m1'").get() as Record<string, unknown>;
    expect(row.content).toBe("old");
    expect(row.partial).toBeNull();
    expect(row.blocks).toBeNull();
    legacy.close();
  });
});
