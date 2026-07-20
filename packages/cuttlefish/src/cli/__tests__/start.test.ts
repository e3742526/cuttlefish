import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-start-test-");

const lifecycle = vi.hoisted(() => ({
  getStatus: vi.fn(() => ({ running: true, pid: 123 })),
  restartDetached: vi.fn(() => true),
  startForeground: vi.fn(),
  startDaemon: vi.fn(),
}));
const config = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "claude" } })),
}));
const instances = vi.hoisted(() => ({
  ensureDefaultInstance: vi.fn(),
}));

vi.mock("../../gateway/lifecycle.js", () => lifecycle);
vi.mock("../../shared/config.js", () => config);
vi.mock("../instances.js", () => instances);
vi.mock("../../shared/version.js", () => ({
  compareSemver: () => 0,
  getPackageVersion: () => "1.0.0",
  getInstanceVersion: () => "1.0.0",
}));

const { runStart } = await import("../start.js");

beforeEach(() => {
  vi.clearAllMocks();
  lifecycle.restartDetached.mockReturnValue(true);
  config.loadConfig.mockReturnValue({ gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "claude" } });
  fs.mkdirSync(tmpHome, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("runStart", () => {
  it("uses the detached restart helper when a gateway is already running, even without --daemon", async () => {
    await runStart({ daemon: false });

    expect(lifecycle.restartDetached).toHaveBeenCalledTimes(1);
    expect(lifecycle.getStatus).toHaveBeenCalledWith(8888);
    expect(instances.ensureDefaultInstance).toHaveBeenCalledWith(8888);
    expect(lifecycle.startForeground).not.toHaveBeenCalled();
    expect(lifecycle.startDaemon).not.toHaveBeenCalled();
  });

  it("checks occupancy against the overridden port before starting", async () => {
    lifecycle.getStatus.mockReturnValueOnce({ running: false, pid: 0 });

    await runStart({ daemon: true, port: 8891 });

    expect(lifecycle.getStatus).toHaveBeenCalledWith(8891);
    expect(instances.ensureDefaultInstance).toHaveBeenCalledWith(8891);
    expect(lifecycle.startDaemon).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartDetached).not.toHaveBeenCalled();
  });

  it("prints a clean config error instead of letting Commander emit a stack trace", async () => {
    config.loadConfig.mockImplementationOnce(() => {
      throw new Error("config.yaml: gateway.port must be an integer from 1 to 65535");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runStart({ daemon: true });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("gateway.port must be an integer"));
      expect(lifecycle.startDaemon).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });
});
