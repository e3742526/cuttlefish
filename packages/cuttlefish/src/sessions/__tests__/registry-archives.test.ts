import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import {
  createArchiveAndDeleteSessionsRecord,
  createArchiveRecord,
  deleteArchiveRecord,
  getArchiveRecord,
  listArchiveRecords,
  snapshotSessionsForArchive,
  type ArchiveRegistryDeps,
} from "../registry-archives.js";

const { home: _tmp } = withStaticTempCuttlefishHome("cuttlefish-registry-archives-");

type Reg = typeof import("../registry.js");

let reg: Reg;
let deps: ArchiveRegistryDeps;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
  deps = {
    getDb: reg.initDb,
    getSession: reg.getSession,
    getMessages: reg.getMessages,
  };
});

describe("registry archive helper", () => {
  it("snapshots, persists, lists, loads, and deletes archives without the registry facade", () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:helper-archive",
      title: "Helper archive",
    });
    reg.insertMessage(session.id, "user", "save this");
    reg.insertMessage(session.id, "assistant", "saved", [
      { type: "file", url: "/api/files/file-1", name: "notes.txt" },
    ]);

    const snapshots = snapshotSessionsForArchive([session.id], deps);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].messages[1].media?.[0].name).toBe("notes.txt");

    const archive = createArchiveRecord({
      kind: "chat",
      label: "Helper",
      sessions: snapshots,
    }, deps);
    expect(listArchiveRecords(deps)[0]?.id).toBe(archive.id);
    expect(getArchiveRecord(archive.id, deps)?.sessions[0]?.id).toBe(session.id);
    expect(deleteArchiveRecord(archive.id, deps)).toBe(true);
  });

  it("keeps archive-and-delete transactional when deleting live rows", () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:helper-archive-delete",
      title: "Helper archive delete",
    });
    reg.insertMessage(session.id, "user", "archive and remove");
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");

    const archive = createArchiveAndDeleteSessionsRecord({
      kind: "chat",
      sessionIds: [session.id],
      label: "Delete helper",
    }, deps);

    expect(archive?.sessionCount).toBe(1);
    expect(reg.getSession(session.id)).toBeUndefined();
    expect(reg.getMessages(session.id)).toEqual([]);
    expect(reg.getQueueItems(session.sessionKey)).toEqual([]);
  });

  it("snapshots the full session record, not just a subset of fields (DAT-SESS-005)", () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:full-snapshot",
      connector: "web-connector",
      sessionKey: "web:full-snapshot-key",
      replyContext: { channel: "general", threadId: "t-1" },
      messageId: "msg-123",
      transportMeta: { activeRunId: "run-1" },
      userId: "user-abc",
      effortLevel: "high",
      cwd: "/workspace/project",
      title: "Full snapshot",
    });

    const [snapshot] = snapshotSessionsForArchive([session.id], deps);
    expect(snapshot).toBeDefined();
    expect(snapshot.engineSessionId).toBe(session.engineSessionId);
    expect(snapshot.connector).toBe("web-connector");
    expect(snapshot.sessionKey).toBe("web:full-snapshot-key");
    expect(snapshot.replyContext).toEqual({ channel: "general", threadId: "t-1" });
    expect(snapshot.messageId).toBe("msg-123");
    expect(snapshot.transportMeta).toMatchObject({ activeRunId: "run-1" });
    expect(snapshot.userId).toBe("user-abc");
    expect(snapshot.effortLevel).toBe("high");
    expect(snapshot.cwd).toBe("/workspace/project");
    expect(snapshot.lastContextTokens).toBe(session.lastContextTokens);
    expect(snapshot.lastError).toBe(session.lastError);
  });

  it("unlinks (does not delete) cached emails when archiving-and-deleting their session (DAT-SESS-006)", () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:archive-email-unlink",
      title: "Archive email unlink",
    });
    const db = reg.initDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO email_messages (id, inbox_id, provider_message_id, thread_key, to_addresses,
        cc_addresses, text_body, headers_json, attachments_json, status, session_id, created_at, updated_at)
       VALUES (?, 'inbox', ?, 'thread', '[]', '[]', 'body', '{}', '[]', 'processed', ?, ?, ?)`,
    ).run("archive-email-1", "archive-email-1", session.id, now, now);
    db.prepare(
      `INSERT INTO email_ingest_state (inbox_id, provider_message_id, email_message_id, status, session_id, first_seen_at, updated_at)
       VALUES ('inbox', ?, 'archive-email-1', 'ingested', ?, ?, ?)`,
    ).run("archive-email-1", session.id, now, now);

    const archive = createArchiveAndDeleteSessionsRecord({
      kind: "chat",
      sessionIds: [session.id],
      label: "Archive with email",
    }, deps);

    expect(archive?.sessionCount).toBe(1);
    expect(reg.getSession(session.id)).toBeUndefined();

    const emailRow = db.prepare("SELECT session_id as s FROM email_messages WHERE id = ?").get("archive-email-1") as { s: string | null } | undefined;
    expect(emailRow).toBeDefined();
    expect(emailRow?.s).toBeNull();

    const ingestRow = db.prepare(
      "SELECT session_id as s FROM email_ingest_state WHERE inbox_id = 'inbox' AND provider_message_id = ?",
    ).get("archive-email-1") as { s: string | null } | undefined;
    expect(ingestRow).toBeDefined();
    expect(ingestRow?.s).toBeNull();
  });
});
