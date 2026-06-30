import { existsSync, readFileSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { Approval, ApprovalDecision, JsonObject } from "../shared/types.js";

type ApprovalRow = {
  id: string;
  session_id: string;
  type: Approval["type"];
  payload: string;
  state: Approval["state"];
  created_at: string;
  resolved_at: string | null;
  actor: string | null;
  decision_notes: string | null;
  resulting_action: string | null;
};

export interface ApprovalRegistryDeps {
  getDb: () => Database.Database;
  getMeta: (database: Database.Database, key: string) => string | null;
  setMeta: (database: Database.Database, key: string, value: string) => void;
  parseJsonObject: (value: unknown, label?: string) => JsonObject | null;
}

function rowToApproval(row: ApprovalRow, deps: ApprovalRegistryDeps): Approval {
  const payload = deps.parseJsonObject(row.payload, "approvals.payload") ?? {};
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    payload,
    state: row.state,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    actor: row.actor,
    decisionNotes: row.decision_notes,
    resultingAction: row.resulting_action,
  };
}

export function importApprovalsJsonIfNeededFromRegistry(filePath: string, deps: ApprovalRegistryDeps): void {
  const db = deps.getDb();
  const metaKey = `approvals_json_imported:${filePath}`;
  if (deps.getMeta(db, metaKey) === "1") return;
  if (!existsSync(filePath)) {
    deps.setMeta(db, metaKey, "1");
    return;
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("legacy approvals store must be an array");

  const insert = db.prepare(`
    INSERT OR IGNORE INTO approvals
        (id, session_id, type, payload, state, created_at, resolved_at, actor, decision_notes, resulting_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // With the approvals.session_id FK enforced, an imported approval whose session
  // no longer exists would violate the constraint and abort the whole import. Such
  // an approval is already orphaned and unusable, so skip it during legacy import.
  const sessionExists = db.prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1");
  const txn = db.transaction((items: unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const approval = item as Partial<Approval>;
      if (
        typeof approval.id !== "string" ||
        typeof approval.sessionId !== "string" ||
        typeof approval.type !== "string" ||
        typeof approval.state !== "string" ||
        typeof approval.createdAt !== "string" ||
        !approval.payload ||
        typeof approval.payload !== "object" ||
        Array.isArray(approval.payload)
      ) {
        continue;
      }
      if (!sessionExists.get(approval.sessionId)) {
        continue; // orphaned legacy approval — its session is gone
      }
      insert.run(
        approval.id,
        approval.sessionId,
        approval.type,
        JSON.stringify(approval.payload),
        approval.state,
        approval.createdAt,
        approval.resolvedAt ?? null,
        approval.actor ?? null,
        approval.decisionNotes ?? null,
        approval.resultingAction ?? null,
      );
    }
    deps.setMeta(db, metaKey, "1");
  });
  txn(parsed);
}

export function listApprovalRecordsFromRegistry(
  filter: { state?: Approval["state"] | "all"; sessionId?: string; type?: Approval["type"] | "all" } | undefined,
  deps: ApprovalRegistryDeps,
): Approval[] {
  const db = deps.getDb();
  const clauses: string[] = [];
  const args: unknown[] = [];
  const state = filter?.state ?? "pending";
  if (state !== "all") {
    clauses.push("state = ?");
    args.push(state);
  }
  if (filter?.sessionId) {
    clauses.push("session_id = ?");
    args.push(filter.sessionId);
  }
  if (filter?.type && filter.type !== "all") {
    clauses.push("type = ?");
    args.push(filter.type);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC`).all(...args) as ApprovalRow[];
  return rows.map((row) => rowToApproval(row, deps));
}

export function getApprovalRecordFromRegistry(id: string, deps: ApprovalRegistryDeps): Approval | undefined {
  const row = deps.getDb().prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  return row ? rowToApproval(row, deps) : undefined;
}

export function createApprovalRecordInRegistry(input: {
  sessionId: string;
  type: Approval["type"];
  payload: JsonObject;
}, deps: ApprovalRegistryDeps): Approval {
  const db = deps.getDb();
  const txn = db.transaction(() => {
    if (input.type === "fallback") {
      const existing = db
        .prepare("SELECT * FROM approvals WHERE session_id = ? AND type = 'fallback' AND state = 'pending'")
        .get(input.sessionId) as ApprovalRow | undefined;
      if (existing) {
        db.prepare("UPDATE approvals SET payload = ? WHERE id = ?").run(JSON.stringify(input.payload), existing.id);
        return getApprovalRecordFromRegistry(existing.id, deps);
      }
    }

    const approval: Approval = {
      id: uuidv4(),
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload,
      state: "pending",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      actor: null,
      decisionNotes: null,
      resultingAction: null,
    };
    db.prepare(`
      INSERT INTO approvals
        (id, session_id, type, payload, state, created_at, resolved_at, actor, decision_notes, resulting_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.id,
      approval.sessionId,
      approval.type,
      JSON.stringify(approval.payload),
      approval.state,
      approval.createdAt,
      approval.resolvedAt,
      approval.actor,
      approval.decisionNotes,
      approval.resultingAction,
    );
    return approval;
  });
  const approval = txn() as Approval | undefined;
  if (!approval) throw new Error("failed to create approval");
  return approval;
}

export function resolveApprovalRecordInRegistry(
  id: string,
  state: ApprovalDecision,
  actor: string | null | undefined,
  decisionNotes: string | null | undefined,
  resultingAction: string | null | undefined,
  deps: ApprovalRegistryDeps,
): Approval | undefined {
  const db = deps.getDb();
  const txn = db.transaction(() => {
    const existing = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    if (!existing) return undefined;
    if (existing.state !== "pending") return rowToApproval(existing, deps);
    const resolvedAt = new Date().toISOString();
    db.prepare("UPDATE approvals SET state = ?, resolved_at = ?, actor = ?, decision_notes = ?, resulting_action = ? WHERE id = ? AND state = 'pending'")
      .run(state, resolvedAt, actor ?? null, decisionNotes ?? null, resultingAction ?? null, id);
    return getApprovalRecordFromRegistry(id, deps);
  });
  return txn() as Approval | undefined;
}

export function clearApprovalRecordsForTestInRegistry(deps: ApprovalRegistryDeps): void {
  deps.getDb().prepare("DELETE FROM approvals").run();
}
