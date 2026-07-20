import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-instances-home-"));
process.env.CUTTLEFISH_HOME = testHome;
process.env.CUTTLEFISH_INSTANCES_REGISTRY = path.join(testHome, "instances.json");

const { INSTANCES_REGISTRY } = await import("../../shared/paths.js");
const { ensureDefaultInstance, loadInstances, saveInstances } = await import("../instances.js");

describe("instances registry isolation", () => {
  it("uses the explicit registry override for isolated runs", () => {
    expect(INSTANCES_REGISTRY).toBe(path.join(testHome, "instances.json"));

    saveInstances([{ name: "test", port: 8000, home: testHome, createdAt: "2026-06-24T00:00:00.000Z" }]);

    expect(fs.existsSync(path.join(testHome, "instances.json"))).toBe(true);
    expect(loadInstances()).toEqual([
      { name: "test", port: 8000, home: testHome, createdAt: "2026-06-24T00:00:00.000Z" },
    ]);
  });

  it("refreshes an existing canonical entry when CUTTLEFISH_HOME changes", () => {
    const customHome = path.join(os.tmpdir(), "cuttlefish-custom-list-home");
    saveInstances([{ name: "cuttlefish", port: 8888, home: testHome, createdAt: "2026-06-24T00:00:00.000Z" }]);
    vi.stubEnv("CUTTLEFISH_HOME", customHome);
    try {
      ensureDefaultInstance();
      expect(loadInstances()).toEqual([
        { name: "cuttlefish", port: 8888, home: customHome, createdAt: "2026-06-24T00:00:00.000Z" },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refreshes an existing canonical entry when its configured port changes", () => {
    saveInstances([{ name: "cuttlefish", port: 8888, home: testHome, createdAt: "2026-06-24T00:00:00.000Z" }]);

    ensureDefaultInstance(8898);

    expect(loadInstances()).toEqual([
      { name: "cuttlefish", port: 8898, home: testHome, createdAt: "2026-06-24T00:00:00.000Z" },
    ]);
  });

  it("retains an existing recorded port when no active port is supplied", () => {
    saveInstances([{ name: "cuttlefish", port: 8898, home: testHome, createdAt: "2026-06-24T00:00:00.000Z" }]);

    ensureDefaultInstance();

    expect(loadInstances()).toEqual([
      { name: "cuttlefish", port: 8898, home: testHome, createdAt: "2026-06-24T00:00:00.000Z" },
    ]);
  });
});
