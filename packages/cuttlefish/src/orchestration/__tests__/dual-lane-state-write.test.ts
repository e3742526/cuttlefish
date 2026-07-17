import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  dualLaneTaskDir,
  readDualLaneManifest,
  writeDualLaneManifest,
  type DualLaneManifest,
} from "../dual-lane-state.js";

function manifest(overrides: Partial<DualLaneManifest> = {}): DualLaneManifest {
  return {
    taskId: "task-1",
    coordinatorId: "coord-1",
    state: "selection_required",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    baseCwd: "/tmp/base",
    promptHash: "hash",
    lanes: [],
    comparisonReport: {
      taskId: "task-1",
      generatedAt: "2026-07-04T00:00:00.000Z",
      laneSummaries: [],
      commonFiles: [],
      uniqueFiles: { openai: [], anthropic: [] },
      majorDifferences: [],
    },
    ...overrides,
  };
}

describe("writeDualLaneManifest (atomic)", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = dualLaneTaskDir("task-1", "coord-1");
    fs.rmSync(taskDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(taskDir, { recursive: true, force: true });
  });

  it("round-trips a manifest and leaves no partial .tmp files behind", () => {
    writeDualLaneManifest(manifest({ state: "selected", selectedLane: "anthropic" }));

    const read = readDualLaneManifest("task-1", "coord-1");
    expect(read?.state).toBe("selected");
    expect(read?.selectedLane).toBe("anthropic");

    // The atomic write must not strand a temp file next to the manifest — a
    // torn write would otherwise risk losing the winner selection.
    const leftovers = fs.readdirSync(taskDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("overwrites an existing manifest in place", () => {
    writeDualLaneManifest(manifest({ state: "selection_required" }));
    writeDualLaneManifest(manifest({ state: "failed" }));
    expect(readDualLaneManifest("task-1", "coord-1")?.state).toBe("failed");
  });

  // FSR-CF-012: a single-record manifest read had no guard against the file
  // being corrupt/truncated (e.g. from an interrupted write).
  it("quarantines a corrupt manifest instead of crashing or treating it as valid", () => {
    const manifestPath = path.join(taskDir, "manifest.json");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(manifestPath, '{"taskId": "task-1", "coordinatorId": "coord-1", "state": "sel'); // truncated JSON

    expect(() => readDualLaneManifest("task-1", "coord-1")).not.toThrow();
    expect(readDualLaneManifest("task-1", "coord-1")).toBeUndefined();

    // The corrupt file must be moved aside, not deleted or left in place.
    expect(fs.existsSync(manifestPath)).toBe(false);
    const quarantined = fs.readdirSync(taskDir).filter((name) => name.startsWith("manifest.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(taskDir, quarantined[0]), "utf-8")).toContain('"state": "sel');
  });
});
