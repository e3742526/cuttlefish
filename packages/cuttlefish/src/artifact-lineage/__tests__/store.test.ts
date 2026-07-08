import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactLineageStore } from "../store.js";

let store: ArtifactLineageStore;

beforeEach(() => {
  store = ArtifactLineageStore.open(":memory:");
});

afterEach(() => {
  store.close();
});

describe("ArtifactLineageStore", () => {
  describe("schema and meta", () => {
    it("opens and returns schema version 1", () => {
      expect(store.getSchemaVersion()).toBe("1");
    });
  });

  describe("registerArtifact", () => {
    it("inserts a new artifact and returns it", () => {
      const record = store.registerArtifact({
        artifactId: "art-1",
        canonicalKind: "file:generated",
        locator: "/tmp/file.txt",
        sha256: "abc123",
        sizeBytes: 42,
        mimeType: "text/plain",
      });
      expect(record.artifactId).toBe("art-1");
      expect(record.canonicalKind).toBe("file:generated");
      expect(record.locator).toBe("/tmp/file.txt");
      expect(record.sha256).toBe("abc123");
      expect(record.sizeBytes).toBe(42);
      expect(record.mimeType).toBe("text/plain");
      expect(record.createdAt).toBeTruthy();
      expect(record.updatedAt).toBeTruthy();
    });

    it("returns the artifact by id after insert", () => {
      store.registerArtifact({ artifactId: "art-2", canonicalKind: "orchestration:prompt" });
      const found = store.getArtifact("art-2");
      expect(found).toBeDefined();
      expect(found?.canonicalKind).toBe("orchestration:prompt");
    });

    it("returns undefined for unknown artifact id", () => {
      expect(store.getArtifact("no-such-artifact")).toBeUndefined();
    });

    it("upserts on duplicate artifactId (updates fields)", () => {
      store.registerArtifact({ artifactId: "art-3", canonicalKind: "file:input", locator: "/a" });
      store.registerArtifact({ artifactId: "art-3", canonicalKind: "file:generated", locator: "/b" });
      const found = store.getArtifact("art-3");
      expect(found?.canonicalKind).toBe("file:generated");
      expect(found?.locator).toBe("/b");
    });

    it("snapshots the superseded content identity into artifact_versions on re-registration (DAT-INT-001)", () => {
      store.registerArtifact({ artifactId: "art-versioned", canonicalKind: "file:generated", locator: "/a", sha256: "sha-a" });
      store.registerArtifact({ artifactId: "art-versioned", canonicalKind: "file:generated", locator: "/b", sha256: "sha-b" });
      store.registerArtifact({ artifactId: "art-versioned", canonicalKind: "file:generated", locator: "/c", sha256: "sha-c" });

      const versions = store.listArtifactVersions("art-versioned");
      expect(versions).toHaveLength(2);
      expect(versions.map((v) => v.locator)).toEqual(["/a", "/b"]);
      expect(versions.map((v) => v.sha256)).toEqual(["sha-a", "sha-b"]);
      expect(versions.every((v) => v.artifactId === "art-versioned")).toBe(true);
      expect(versions.every((v) => v.versionId)).toBeTruthy();

      // Current content identity is untouched by the snapshot.
      const current = store.getArtifact("art-versioned")!;
      expect(current.locator).toBe("/c");
      expect(current.sha256).toBe("sha-c");
    });

    it("does not snapshot a version when re-registration only changes metadata, not content identity", () => {
      store.registerArtifact({ artifactId: "art-meta-only", canonicalKind: "file:generated", locator: "/a", sha256: "sha-a", mimeType: "text/plain" });
      store.registerArtifact({ artifactId: "art-meta-only", canonicalKind: "file:generated", locator: "/a", sha256: "sha-a", mimeType: "text/markdown" });

      expect(store.listArtifactVersions("art-meta-only")).toHaveLength(0);
      expect(store.getArtifact("art-meta-only")?.mimeType).toBe("text/markdown");
    });

    it("first registration of a new artifactId never creates a version row", () => {
      store.registerArtifact({ artifactId: "art-fresh", canonicalKind: "file:generated", locator: "/a" });
      expect(store.listArtifactVersions("art-fresh")).toHaveLength(0);
    });

    it("creates a run-artifact xref when producingRunId is provided", () => {
      store.registerArtifact({ artifactId: "art-run", canonicalKind: "file:generated", producingRunId: "run-1" });
      const xrefs = store.listRunArtifactXrefs("run-1");
      expect(xrefs).toHaveLength(1);
      expect(xrefs[0].artifactId).toBe("art-run");
      expect(xrefs[0].relation).toBe("produced_by");
    });

    it("stores null fields when optional fields are omitted", () => {
      store.registerArtifact({ artifactId: "art-minimal", canonicalKind: "file:input" });
      const record = store.getArtifact("art-minimal")!;
      expect(record.locator).toBeNull();
      expect(record.sha256).toBeNull();
      expect(record.sizeBytes).toBeNull();
      expect(record.mimeType).toBeNull();
    });
  });

  describe("addLineageEdge", () => {
    beforeEach(() => {
      store.registerArtifact({ artifactId: "parent-1", canonicalKind: "file:input" });
      store.registerArtifact({ artifactId: "child-1", canonicalKind: "file:generated" });
    });

    it("adds an edge and returns it", () => {
      const edge = store.addLineageEdge({
        fromArtifactId: "parent-1",
        toArtifactId: "child-1",
        relationType: "parent",
        runId: "run-99",
      });
      expect(edge.fromArtifactId).toBe("parent-1");
      expect(edge.toArtifactId).toBe("child-1");
      expect(edge.relationType).toBe("parent");
      expect(edge.runId).toBe("run-99");
      expect(edge.edgeId).toBeTruthy();
    });

    it("throws when fromArtifactId does not exist", () => {
      expect(() =>
        store.addLineageEdge({ fromArtifactId: "ghost", toArtifactId: "child-1", relationType: "derived_from" }),
      ).toThrow(/from_artifact_id/);
    });

    it("throws when toArtifactId does not exist", () => {
      expect(() =>
        store.addLineageEdge({ fromArtifactId: "parent-1", toArtifactId: "ghost", relationType: "derived_from" }),
      ).toThrow(/to_artifact_id/);
    });

    it("lists edges for an artifact", () => {
      store.addLineageEdge({ fromArtifactId: "parent-1", toArtifactId: "child-1", relationType: "parent" });
      const edges = store.listLineageEdges("parent-1");
      expect(edges).toHaveLength(1);
      expect(edges[0].toArtifactId).toBe("child-1");
    });

    it("detects and rejects direct cycles", () => {
      store.addLineageEdge({ fromArtifactId: "parent-1", toArtifactId: "child-1", relationType: "parent" });
      expect(() =>
        store.addLineageEdge({ fromArtifactId: "child-1", toArtifactId: "parent-1", relationType: "parent" }),
      ).toThrow(/cycle/);
    });

    it("detects and rejects transitive cycles", () => {
      store.registerArtifact({ artifactId: "mid", canonicalKind: "file:generated" });
      store.addLineageEdge({ fromArtifactId: "parent-1", toArtifactId: "mid", relationType: "parent" });
      store.addLineageEdge({ fromArtifactId: "mid", toArtifactId: "child-1", relationType: "parent" });
      expect(() =>
        store.addLineageEdge({ fromArtifactId: "child-1", toArtifactId: "parent-1", relationType: "parent" }),
      ).toThrow(/cycle/);
    });
  });

  describe("quarantine records", () => {
    it("adds and retrieves a quarantine record", () => {
      const record = store.addQuarantineRecord({ reason: "test quarantine", artifactId: "art-q", runId: "run-q" });
      expect(record.recordId).toBeTruthy();
      expect(record.reason).toBe("test quarantine");
      expect(record.artifactId).toBe("art-q");
      expect(record.runId).toBe("run-q");
      expect(record.resolvedAt).toBeNull();
    });

    it("lists all quarantine records", () => {
      store.addQuarantineRecord({ reason: "r1" });
      store.addQuarantineRecord({ reason: "r2" });
      const records = store.listQuarantineRecords();
      expect(records.length).toBeGreaterThanOrEqual(2);
    });

    it("filters to unresolved records only", () => {
      store.addQuarantineRecord({ reason: "unresolved" });
      const records = store.listQuarantineRecords({ unresolvedOnly: true });
      expect(records.every((r) => r.resolvedAt === null)).toBe(true);
    });

    it("respects the limit option", () => {
      for (let i = 0; i < 5; i++) {
        store.addQuarantineRecord({ reason: `reason ${i}` });
      }
      const records = store.listQuarantineRecords({ limit: 3 });
      expect(records).toHaveLength(3);
    });

    it("accepts a quarantine record without an artifactId", () => {
      const record = store.addQuarantineRecord({ reason: "no artifact" });
      expect(record.artifactId).toBeNull();
    });
  });

  describe("runArtifactXref", () => {
    it("lists xrefs for a run", () => {
      store.registerArtifact({ artifactId: "xref-art", canonicalKind: "file:generated", producingRunId: "xref-run" });
      const xrefs = store.listRunArtifactXrefs("xref-run");
      expect(xrefs).toHaveLength(1);
      expect(xrefs[0].runId).toBe("xref-run");
      expect(xrefs[0].artifactId).toBe("xref-art");
    });

    it("returns empty array for unknown run", () => {
      expect(store.listRunArtifactXrefs("unknown-run")).toHaveLength(0);
    });
  });
});
