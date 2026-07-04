import fs from "node:fs";
import path from "node:path";
import { TMP_DIR } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";
import type { OrchestrationRunSession } from "./run-mode.js";
import type { WorktreeHandle } from "./worktree.js";
import { safePathSegment } from "./path-segments.js";

export const DUAL_LANE_STATE_DIR = path.join(TMP_DIR, "orchestration-dual-lane");

export type DualLaneState = "selection_required" | "selected" | "failed";

export interface DualLaneManifest {
  taskId: string;
  coordinatorId: string;
  state: DualLaneState;
  createdAt: string;
  updatedAt: string;
  baseCwd: string;
  promptHash: string;
  selectedLane?: "openai" | "anthropic";
  archivedLane?: "openai" | "anthropic";
  lanes: DualLaneManifestLane[];
  comparisonReport: DualLaneComparisonReport;
}

export interface DualLaneManifestLane {
  id: "openai" | "anthropic";
  role: string;
  family: "openai" | "anthropic";
  workerId: string;
  leaseId: string;
  session: OrchestrationRunSession;
  worktree: WorktreeHandle;
  archive?: DualLaneArchiveRecord;
}

export interface DualLaneArchiveRecord {
  diffPath: string;
  metadataPath: string;
  archivedAt: string;
}

export interface DualLaneComparisonReport {
  taskId: string;
  generatedAt: string;
  laneSummaries: Array<{
    laneId: "openai" | "anthropic";
    changedFiles: string[];
    addedLines: number;
    removedLines: number;
    status: string;
    error: string | null;
  }>;
  commonFiles: string[];
  uniqueFiles: Record<"openai" | "anthropic", string[]>;
  majorDifferences: string[];
}

export function writeDualLaneManifest(manifest: DualLaneManifest): void {
  const file = dualLaneManifestPath(manifest.taskId, manifest.coordinatorId);
  // Atomic tmp+fsync+rename: this manifest's `state` gates whether a lane's patch
  // may be applied, so a torn write would silently lose a winner selection. Use the
  // repo's safe-write doctrine rather than a raw writeFileSync.
  safeWriteFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readDualLaneManifest(taskId: string, coordinatorId: string): DualLaneManifest | undefined {
  return readManifestFile(dualLaneManifestPath(taskId, coordinatorId), taskId, coordinatorId);
}

export function updateDualLaneManifest(manifest: DualLaneManifest): DualLaneManifest {
  const updated = { ...manifest, updatedAt: new Date().toISOString() };
  writeDualLaneManifest(updated);
  return updated;
}

export function listProtectedDualLaneTaskIds(root = DUAL_LANE_STATE_DIR): Set<string> {
  const protectedIds = new Set<string>();
  for (const manifest of listDualLaneManifests(root)) {
    if (manifest.state === "selection_required" || manifest.state === "selected") {
      protectedIds.add(manifest.taskId);
    }
  }
  return protectedIds;
}

export function listDualLaneManifests(root = DUAL_LANE_STATE_DIR): DualLaneManifest[] {
  if (!fs.existsSync(root)) return [];
  const manifests: DualLaneManifest[] = [];
  const seen = new Set<string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const manifestPath of manifestPathsUnder(path.join(root, entry.name))) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as DualLaneManifest;
        const key = `${manifest.taskId}\0${manifest.coordinatorId}`;
        if (manifest.taskId && manifest.coordinatorId && !seen.has(key)) {
          seen.add(key);
          manifests.push(manifest);
        }
      } catch {
        // Ignore malformed local artifacts; observe routes report only valid manifests.
      }
    }
  }
  return manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId) || a.coordinatorId.localeCompare(b.coordinatorId));
}

export function dualLaneTaskDir(taskId: string, coordinatorId: string): string {
  const taskDir = path.join(DUAL_LANE_STATE_DIR, safePathSegment(taskId, "dual-lane task path segment"));
  return path.join(taskDir, safePathSegment(coordinatorId, "dual-lane coordinator path segment"));
}

export function dualLaneArchiveDir(taskId: string, coordinatorId: string): string {
  return path.join(dualLaneTaskDir(taskId, coordinatorId), "archive");
}

function dualLaneManifestPath(taskId: string, coordinatorId: string): string {
  return path.join(dualLaneTaskDir(taskId, coordinatorId), "manifest.json");
}

function readManifestFile(file: string, taskId: string, coordinatorId?: string): DualLaneManifest | undefined {
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as DualLaneManifest;
  if (parsed.taskId !== taskId) throw new Error(`dual-lane manifest task mismatch: ${file}`);
  if (coordinatorId && parsed.coordinatorId !== coordinatorId) throw new Error(`dual-lane manifest coordinator mismatch: ${file}`);
  return parsed;
}

function manifestPathsUnder(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name, "manifest.json");
    if (fs.existsSync(nested)) paths.push(nested);
  }
  return paths;
}
