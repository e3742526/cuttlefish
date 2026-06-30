import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { ARTIFACT_LINEAGE_DB } from "../shared/paths.js";
import {
  type AddLineageEdgeInput,
  type AddQuarantineRecordInput,
  type ArtifactRecord,
  type LineageEdge,
  type QuarantineRecord,
  type RegisterArtifactInput,
  type RunArtifactXref,
  artifactRecordSchema,
  lineageEdgeSchema,
  quarantineRecordSchema,
  runArtifactXrefSchema,
} from "./types.js";

const SCHEMA_VERSION = 1;

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  canonical_kind TEXT NOT NULL,
  locator TEXT,
  sha256 TEXT,
  size_bytes INTEGER,
  mime_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_artifacts_kind ON artifacts (canonical_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_versions (
  version_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  locator TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  note TEXT,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lineage_versions_artifact ON artifact_versions (artifact_id, created_at);

CREATE TABLE IF NOT EXISTS source_references (
  ref_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT,
  source_locator TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lineage_source_refs_artifact ON source_references (artifact_id, created_at);

CREATE TABLE IF NOT EXISTS lineage_edges (
  edge_id TEXT PRIMARY KEY,
  from_artifact_id TEXT NOT NULL,
  to_artifact_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_edges_from ON lineage_edges (from_artifact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lineage_edges_to ON lineage_edges (to_artifact_id, created_at);

CREATE TABLE IF NOT EXISTS quarantine_records (
  record_id TEXT PRIMARY KEY,
  artifact_id TEXT,
  reason TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lineage_quarantine_artifact ON quarantine_records (artifact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lineage_quarantine_unresolved ON quarantine_records (resolved_at, created_at);

CREATE TABLE IF NOT EXISTS run_artifact_xref (
  xref_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, artifact_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_lineage_xref_run ON run_artifact_xref (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lineage_xref_artifact ON run_artifact_xref (artifact_id, created_at);
DELETE FROM run_artifact_xref
  WHERE xref_id NOT IN (
    SELECT MIN(xref_id) FROM run_artifact_xref GROUP BY run_id, artifact_id, relation
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_xref_unique ON run_artifact_xref (run_id, artifact_id, relation);
`;

export class ArtifactLineageStore {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath = ARTIFACT_LINEAGE_DB): ArtifactLineageStore {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new Database(dbPath, { timeout: 5000 });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.exec(CREATE_SCHEMA);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
    return new ArtifactLineageStore(db);
  }

  close(): void {
    this.db.close();
  }

  getSchemaVersion(): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  }

  getArtifact(artifactId: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId) as Record<string, unknown> | undefined;
    return row ? parseArtifactRow(row) : undefined;
  }

  registerArtifact(input: RegisterArtifactInput): ArtifactRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const existing = this.getArtifact(input.artifactId);
    if (existing) {
      this.db.prepare(`
        UPDATE artifacts SET canonical_kind = ?, locator = ?, sha256 = ?, size_bytes = ?,
          mime_type = ?, updated_at = ? WHERE artifact_id = ?
      `).run(
        input.canonicalKind,
        input.locator ?? null,
        input.sha256 ?? null,
        input.sizeBytes ?? null,
        input.mimeType ?? null,
        createdAt,
        input.artifactId,
      );
    } else {
      this.db.prepare(`
        INSERT INTO artifacts (artifact_id, canonical_kind, locator, sha256, size_bytes, mime_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.artifactId,
        input.canonicalKind,
        input.locator ?? null,
        input.sha256 ?? null,
        input.sizeBytes ?? null,
        input.mimeType ?? null,
        createdAt,
        createdAt,
      );
    }
    if (input.producingRunId) {
      this.addRunArtifactXref({ runId: input.producingRunId, artifactId: input.artifactId, relation: "produced_by", createdAt });
    }
    return this.getArtifact(input.artifactId)!;
  }

  addLineageEdge(input: AddLineageEdgeInput): LineageEdge {
    const fromArtifact = this.getArtifact(input.fromArtifactId);
    if (!fromArtifact) throw new Error(`lineage: from_artifact_id ${input.fromArtifactId} does not exist`);
    const toArtifact = this.getArtifact(input.toArtifactId);
    if (!toArtifact) throw new Error(`lineage: to_artifact_id ${input.toArtifactId} does not exist`);
    if (this.hasCycle(input.fromArtifactId, input.toArtifactId)) {
      throw new Error(`lineage: adding edge from ${input.fromArtifactId} to ${input.toArtifactId} would create a cycle`);
    }
    const edgeId = uuidv4();
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO lineage_edges (edge_id, from_artifact_id, to_artifact_id, relation_type, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(edgeId, input.fromArtifactId, input.toArtifactId, input.relationType, input.runId ?? null, createdAt);
    return lineageEdgeSchema.parse({
      edgeId,
      fromArtifactId: input.fromArtifactId,
      toArtifactId: input.toArtifactId,
      relationType: input.relationType,
      runId: input.runId ?? null,
      createdAt,
    });
  }

  addQuarantineRecord(input: AddQuarantineRecordInput): QuarantineRecord {
    const recordId = uuidv4();
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO quarantine_records (record_id, artifact_id, reason, run_id, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run(recordId, input.artifactId ?? null, input.reason, input.runId ?? null, createdAt);
    return quarantineRecordSchema.parse({
      recordId,
      artifactId: input.artifactId ?? null,
      reason: input.reason,
      runId: input.runId ?? null,
      createdAt,
      resolvedAt: null,
    });
  }

  listQuarantineRecords(opts: { limit?: number; unresolvedOnly?: boolean } = {}): QuarantineRecord[] {
    const where = opts.unresolvedOnly ? "WHERE resolved_at IS NULL" : "";
    const limit = opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : "";
    const rows = this.db.prepare(`SELECT * FROM quarantine_records ${where} ORDER BY created_at DESC${limit}`).all() as Record<string, unknown>[];
    return rows.map(parseQuarantineRow);
  }

  listLineageEdges(artifactId: string): LineageEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM lineage_edges WHERE from_artifact_id = ? OR to_artifact_id = ? ORDER BY created_at
    `).all(artifactId, artifactId) as Record<string, unknown>[];
    return rows.map(parseEdgeRow);
  }

  listRunArtifactXrefs(runId: string): RunArtifactXref[] {
    const rows = this.db.prepare("SELECT * FROM run_artifact_xref WHERE run_id = ? ORDER BY created_at").all(runId) as Record<string, unknown>[];
    return rows.map(parseXrefRow);
  }

  listArtifactRunXrefs(artifactId: string): RunArtifactXref[] {
    const rows = this.db.prepare("SELECT * FROM run_artifact_xref WHERE artifact_id = ? ORDER BY created_at").all(artifactId) as Record<string, unknown>[];
    return rows.map(parseXrefRow);
  }

  private addRunArtifactXref(input: { runId: string; artifactId: string; relation: string; createdAt: string }): RunArtifactXref {
    const xrefId = uuidv4();
    this.db.prepare(`
      INSERT OR IGNORE INTO run_artifact_xref (xref_id, run_id, artifact_id, relation, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(xrefId, input.runId, input.artifactId, input.relation, input.createdAt);
    return runArtifactXrefSchema.parse({
      xrefId,
      runId: input.runId,
      artifactId: input.artifactId,
      relation: input.relation,
      createdAt: input.createdAt,
    });
  }

  private hasCycle(fromId: string, toId: string): boolean {
    // DFS forward from toId following outgoing edges, looking for fromId (would close a cycle)
    const visited = new Set<string>();
    const stack = [toId];
    const stmt = this.db.prepare("SELECT to_artifact_id FROM lineage_edges WHERE from_artifact_id = ?");
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === fromId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const rows = stmt.all(current) as Array<{ to_artifact_id: string }>;
      for (const row of rows) {
        stack.push(row.to_artifact_id);
      }
    }
    return false;
  }
}

function parseArtifactRow(row: Record<string, unknown>): ArtifactRecord {
  return artifactRecordSchema.parse({
    artifactId: row.artifact_id,
    canonicalKind: row.canonical_kind,
    locator: row.locator ?? null,
    sha256: row.sha256 ?? null,
    sizeBytes: row.size_bytes ?? null,
    mimeType: row.mime_type ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseEdgeRow(row: Record<string, unknown>): LineageEdge {
  return lineageEdgeSchema.parse({
    edgeId: row.edge_id,
    fromArtifactId: row.from_artifact_id,
    toArtifactId: row.to_artifact_id,
    relationType: row.relation_type,
    runId: row.run_id ?? null,
    createdAt: row.created_at,
  });
}

function parseQuarantineRow(row: Record<string, unknown>): QuarantineRecord {
  return quarantineRecordSchema.parse({
    recordId: row.record_id,
    artifactId: row.artifact_id ?? null,
    reason: row.reason,
    runId: row.run_id ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  });
}

function parseXrefRow(row: Record<string, unknown>): RunArtifactXref {
  return runArtifactXrefSchema.parse({
    xrefId: row.xref_id,
    runId: row.run_id,
    artifactId: row.artifact_id,
    relation: row.relation,
    createdAt: row.created_at,
  });
}
