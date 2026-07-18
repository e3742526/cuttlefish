import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { invalidatePolicyCache } from "../../policy/loader.js";
import { ArtifactLineageStore } from "../store.js";

let store: ArtifactLineageStore;
let policyDir: string;

beforeEach(() => {
  store = ArtifactLineageStore.open(":memory:");
  policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-lineage-policy-"));
  invalidatePolicyCache();
});

afterEach(() => {
  store.close();
  fs.rmSync(policyDir, { recursive: true, force: true });
  invalidatePolicyCache();
  vi.restoreAllMocks();
});

function writePolicyFile(dir: string, name: string, rules: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ rules }));
}

describe("ArtifactLineageStore", () => {
  describe("schema and meta", () => {
    it("opens and returns schema version 1", () => {
      expect(store.getSchemaVersion()).toBe("1");
    });

    it("quarantines a corrupt on-disk database and rebuilds an empty lineage store", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-lineage-corrupt-"));
      const dbPath = path.join(dir, "artifact-lineage.db");
      fs.writeFileSync(dbPath, "not a sqlite database");

      const recovered = ArtifactLineageStore.open(dbPath);
      expect(recovered.getSchemaVersion()).toBe("1");
      recovered.close();
      expect(fs.readdirSync(dir).some((name) => name.startsWith("artifact-lineage.db.corrupt-"))).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
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

    describe("policy gate (STT-CF-001 / ARC-CFAD-007 / DAT-BUS-002)", () => {
      it("allows registration by default when no register policy rule is configured", () => {
        const record = store.registerArtifact(
          { artifactId: "art-policy-default", canonicalKind: "file:generated" },
          policyDir,
        );
        expect(record.artifactId).toBe("art-policy-default");
      });

      it("refuses registration that violates a configured register-deny policy rule", () => {
        writePolicyFile(policyDir, "00-deny-register.json", [
          { id: "deny-register-file", action: "register", kindPattern: "file:*", allow: false },
        ]);
        invalidatePolicyCache();

        expect(() =>
          store.registerArtifact({ artifactId: "art-policy-denied", canonicalKind: "file:generated" }, policyDir),
        ).toThrow(/policy/);

        // The gate must run before any row is written — the denied artifact
        // must not exist afterward.
        expect(store.getArtifact("art-policy-denied")).toBeUndefined();
      });

      it("allows registration for a kind that the deny rule does not match", () => {
        writePolicyFile(policyDir, "00-deny-register.json", [
          { id: "deny-register-file", action: "register", kindPattern: "file:*", allow: false },
        ]);
        invalidatePolicyCache();

        const record = store.registerArtifact(
          { artifactId: "art-policy-allowed", canonicalKind: "knowledge:note" },
          policyDir,
        );
        expect(record.artifactId).toBe("art-policy-allowed");
      });
    });

    describe("check-then-act is transaction-wrapped (CON-CUT-002)", () => {
      it("rolls back the entire registration atomically when a later write in the sequence fails", () => {
        // better-sqlite3 transactions are synchronous, so a real two-connection
        // race can't be driven from a single JS thread in a test. Instead this
        // proves the property that closes the race: the check (existing-row
        // lookup) and every subsequent write are now one atomic unit, so a
        // failure partway through leaves no partial state behind — the same
        // guarantee addLineageEdge already gets from its BEGIN IMMEDIATE wrap.
        const xrefSpy = vi
          .spyOn(store as unknown as { addRunArtifactXref: (input: unknown) => unknown }, "addRunArtifactXref")
          .mockImplementation(() => {
            throw new Error("simulated failure after the artifacts row write");
          });

        expect(() =>
          store.registerArtifact({
            artifactId: "art-atomic",
            canonicalKind: "file:generated",
            producingRunId: "run-atomic",
          }),
        ).toThrow(/simulated failure/);

        // Prior to the fix, the artifacts row INSERT ran as its own statement
        // outside any transaction and would have committed before this failure;
        // now the whole sequence rolls back together.
        expect(store.getArtifact("art-atomic")).toBeUndefined();

        xrefSpy.mockRestore();
      });

      it("does not leave a stray artifact_versions row when the update half of a re-registration fails", () => {
        store.registerArtifact({ artifactId: "art-atomic-2", canonicalKind: "file:generated", locator: "/a", sha256: "sha-a" });

        const xrefSpy = vi
          .spyOn(store as unknown as { addRunArtifactXref: (input: unknown) => unknown }, "addRunArtifactXref")
          .mockImplementation(() => {
            throw new Error("simulated failure during re-registration");
          });

        expect(() =>
          store.registerArtifact({
            artifactId: "art-atomic-2",
            canonicalKind: "file:generated",
            locator: "/b",
            sha256: "sha-b",
            producingRunId: "run-atomic-2",
          }),
        ).toThrow(/simulated failure/);

        // The version snapshot taken before the failed write must also be
        // rolled back — it's part of the same atomic unit now.
        expect(store.listArtifactVersions("art-atomic-2")).toHaveLength(0);
        const current = store.getArtifact("art-atomic-2")!;
        expect(current.locator).toBe("/a");
        expect(current.sha256).toBe("sha-a");

        xrefSpy.mockRestore();
      });
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

describe("ArtifactLineageStore.open — file permissions (SEC-CFDB-001)", () => {
  let permDir: string;
  let permDbPath: string;

  beforeEach(() => {
    permDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-lineage-perm-"));
    permDbPath = path.join(permDir, "artifact-lineage.db");
  });

  afterEach(() => {
    fs.rmSync(permDir, { recursive: true, force: true });
  });

  it("creates the artifact-lineage DB file with owner-only (0600) permissions", () => {
    const permStore = ArtifactLineageStore.open(permDbPath);
    try {
      const mode = fs.statSync(permDbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      permStore.close();
    }
  });

  it("tightens a pre-existing world-readable DB file back to 0600 on open", () => {
    const first = ArtifactLineageStore.open(permDbPath);
    first.close();
    fs.chmodSync(permDbPath, 0o644); // simulate a pre-hardening world-readable install

    const reopened = ArtifactLineageStore.open(permDbPath);
    try {
      const mode = fs.statSync(permDbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      reopened.close();
    }
  });
});
