import { initDb } from './core.js';
import { getArtifactLineage } from '../../artifact-lineage/index.js';

export type ArtifactKind = 'generated' | 'input' | 'downloaded' | 'manual';

export interface FileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  sha256: string | null;
  artifactKind: ArtifactKind;
  producingRunId: string | null;
  sourceUrl: string | null;
  sourcePath: string | null;
  tags: string[];
  notes: string | null;
  createdAt: string;
}

export interface ArtifactListFilter {
  kind?: ArtifactKind;
  producingRunId?: string;
  sourceUrl?: string;
  sourcePath?: string;
  tag?: string;
  q?: string;
  limit?: number;
}

export interface InsertFileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  sha256?: string | null;
  artifactKind?: ArtifactKind;
  producingRunId?: string | null;
  sourceUrl?: string | null;
  sourcePath?: string | null;
  tags?: string[];
  notes?: string | null;
}

export type UpdateArtifactMetadata = Partial<Pick<
  FileMeta,
  'sha256' | 'artifactKind' | 'producingRunId' | 'sourceUrl' | 'sourcePath' | 'tags' | 'notes'
>>;

const VALID_ARTIFACT_KINDS = new Set<ArtifactKind>(['generated', 'input', 'downloaded', 'manual']);

function normalizeKind(value: unknown): ArtifactKind {
  return typeof value === 'string' && VALID_ARTIFACT_KINDS.has(value as ArtifactKind)
    ? value as ArtifactKind
    : 'input';
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.slice(0, 50);
}

function parseTags(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return normalizeTags(JSON.parse(value));
  } catch {
    return [];
  }
}

function tagsToJson(tags: string[] | undefined): string | null {
  const normalized = normalizeTags(tags);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function rowToFileMeta(row: Record<string, unknown>): FileMeta {
  return {
    id: row.id as string,
    filename: row.filename as string,
    size: row.size as number,
    mimetype: (row.mimetype as string) ?? null,
    path: (row.path as string) ?? null,
    sha256: (row.sha256 as string) ?? null,
    artifactKind: normalizeKind(row.artifact_kind),
    producingRunId: (row.producing_run_id as string) ?? null,
    sourceUrl: (row.source_url as string) ?? null,
    sourcePath: (row.source_path as string) ?? null,
    tags: parseTags(row.tags),
    notes: (row.notes as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function insertFile(meta: InsertFileMeta): FileMeta {
  const db = initDb();
  const now = new Date().toISOString();
  const artifactKind = normalizeKind(meta.artifactKind);
  db.prepare(`
    INSERT INTO files (
      id, filename, size, mimetype, path, sha256, artifact_kind, producing_run_id,
      source_url, source_path, tags, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    meta.id,
    meta.filename,
    meta.size,
    meta.mimetype,
    meta.path,
    meta.sha256 ?? null,
    artifactKind,
    meta.producingRunId ?? null,
    meta.sourceUrl ?? null,
    meta.sourcePath ?? null,
    tagsToJson(meta.tags),
    meta.notes ?? null,
    now,
  );
  const result: FileMeta = {
    ...meta,
    sha256: meta.sha256 ?? null,
    artifactKind,
    producingRunId: meta.producingRunId ?? null,
    sourceUrl: meta.sourceUrl ?? null,
    sourcePath: meta.sourcePath ?? null,
    tags: normalizeTags(meta.tags),
    notes: meta.notes ?? null,
    createdAt: now,
  };
  try {
    getArtifactLineage().registerArtifact({
      artifactId: meta.id,
      canonicalKind: `file:${artifactKind}`,
      locator: meta.path ?? null,
      sha256: meta.sha256 ?? null,
      sizeBytes: meta.size,
      mimeType: meta.mimetype ?? null,
      producingRunId: meta.producingRunId ?? null,
      createdAt: now,
    });
  } catch {
    // lineage recording is non-fatal
  }
  return result;
}

export function getFile(id: string): FileMeta | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToFileMeta(row) : undefined;
}

/** Batched form of {@link getFile} — one query for N ids instead of N queries (PERF-CF-001). */
export function getFilesByIds(ids: string[]): FileMeta[] {
  const wanted = ids.filter(Boolean);
  if (wanted.length === 0) return [];
  const db = initDb();
  const placeholders = wanted.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...wanted) as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function listFiles(): FileMeta[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function listArtifacts(filter: ArtifactListFilter = {}): FileMeta[] {
  const db = initDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    clauses.push('artifact_kind = ?');
    params.push(filter.kind);
  }
  if (filter.producingRunId) {
    clauses.push('producing_run_id = ?');
    params.push(filter.producingRunId);
  }
  if (filter.sourceUrl) {
    clauses.push('source_url = ?');
    params.push(filter.sourceUrl);
  }
  if (filter.sourcePath) {
    clauses.push('source_path = ?');
    params.push(filter.sourcePath);
  }
  if (filter.tag) {
    clauses.push('tags LIKE ?');
    params.push(`%"${filter.tag.replace(/"/g, '\\"')}"%`);
  }
  if (filter.q) {
    const q = `%${filter.q}%`;
    clauses.push('(filename LIKE ? OR path LIKE ? OR source_path LIKE ? OR source_url LIKE ? OR notes LIKE ?)');
    params.push(q, q, q, q, q);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  // `?? 200` only covers null/undefined; a non-finite limit (e.g. Number("abc") = NaN
  // from a bad ?limit= query) would otherwise reach `LIMIT NaN` and crash SQLite with
  // a datatype mismatch. Treat any non-finite value as "use the default".
  const requestedLimit = Number.isFinite(filter.limit) ? (filter.limit as number) : 200;
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 1000);
  const rows = db.prepare(`SELECT * FROM files ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function findArtifactsByPaths(paths: string[]): FileMeta[] {
  const wanted = paths.map((p) => p.trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  const db = initDb();
  const placeholders = wanted.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM files WHERE path IN (${placeholders}) OR source_path IN (${placeholders})`).all(
    ...wanted,
    ...wanted,
  ) as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function deleteFile(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}

export function setFilePath(id: string, filePath: string): void {
  const db = initDb();
  db.prepare('UPDATE files SET path = ? WHERE id = ?').run(filePath, id);
}

export function updateArtifactMetadata(id: string, updates: UpdateArtifactMetadata): FileMeta | undefined {
  const allowed: Array<[keyof UpdateArtifactMetadata, string, unknown]> = [
    ['sha256', 'sha256', updates.sha256],
    ['artifactKind', 'artifact_kind', updates.artifactKind === undefined ? undefined : normalizeKind(updates.artifactKind)],
    ['producingRunId', 'producing_run_id', updates.producingRunId],
    ['sourceUrl', 'source_url', updates.sourceUrl],
    ['sourcePath', 'source_path', updates.sourcePath],
    ['tags', 'tags', updates.tags === undefined ? undefined : tagsToJson(updates.tags)],
    ['notes', 'notes', updates.notes],
  ];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [_key, column, value] of allowed) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return getFile(id);
  const db = initDb();
  db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return getFile(id);
}
