import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We need to mock ORG_DIR to point to a temp directory
let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  resetOrgScanCacheForTests,
  scanOrg,
  validateEmployeeCreate as validateEmployeeCreateFromFacade,
  validateEmployeeUpdate as validateEmployeeUpdateFromFacade,
} from "../org.js";
import {
  validateEmployeeCreate,
  validateEmployeeUpdate,
} from "../org-validation.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("org facade validation compatibility", () => {
  it("re-exports the validation implementations without changing the public import path", () => {
    expect(validateEmployeeCreateFromFacade).toBe(validateEmployeeCreate);
    expect(validateEmployeeUpdateFromFacade).toBe(validateEmployeeUpdate);
  });
});

describe("scanOrg — alwaysNotify field", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-test-"));
    resetOrgScanCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetOrgScanCacheForTests();
  });

  it("defaults alwaysNotify to true when not specified in YAML", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
`);
    const registry = scanOrg();
    const emp = registry.get("dev");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("parses alwaysNotify: false from YAML", () => {
    writeYaml("platform", "worker.yaml", `
name: worker
persona: A worker
alwaysNotify: false
`);
    const registry = scanOrg();
    const emp = registry.get("worker");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(false);
  });

  it("parses alwaysNotify: true from YAML", () => {
    writeYaml("platform", "lead.yaml", `
name: lead
persona: A lead
alwaysNotify: true
`);
    const registry = scanOrg();
    const emp = registry.get("lead");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("ignores non-boolean alwaysNotify values and defaults to true", () => {
    writeYaml("platform", "bad.yaml", `
name: bad
persona: A bad config
alwaysNotify: "yes"
`);
    const registry = scanOrg();
    const emp = registry.get("bad");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("reuses the parsed registry when org files are unchanged", () => {
    writeYaml("platform", "cached.yaml", `
name: cached
persona: Cached employee
`);
    const readSpy = vi.spyOn(fs, "readFileSync");

    expect(scanOrg().get("cached")?.name).toBe("cached");
    const readsAfterFirstScan = readSpy.mock.calls.length;

    expect(scanOrg().get("cached")?.name).toBe("cached");
    expect(readSpy.mock.calls.length).toBe(readsAfterFirstScan);
  });
});
