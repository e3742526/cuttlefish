import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-start-test-");

const lifecycle = vi.hoisted(() => ({
  getStatus: vi.fn(() => ({ running: true, pid: 123 })),
  restartDetached: vi.fn(),
  startForeground: vi.fn(),
  startDaemon: vi.fn(),
}));

vi.mock("../../gateway/lifecycle.js", () => lifecycle);
vi.mock("../../shared/config.js", () => ({
  loadConfig: () => ({ gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "claude" } }),
}));
vi.mock("../../shared/version.js", () => ({
  compareSemver: () => 0,
  getPackageVersion: () => "1.0.0",
  getInstanceVersion: () => "1.0.0",
}));

const { runStart } = await import("../start.js");

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(lifecycle.startForeground).not.toHaveBeenCalled();
    expect(lifecycle.startDaemon).not.toHaveBeenCalled();
  });

  it("checks occupancy against the overridden port before starting", async () => {
    lifecycle.getStatus.mockReturnValueOnce({ running: false, pid: 0 });

    await runStart({ daemon: true, port: 8891 });

    expect(lifecycle.getStatus).toHaveBeenCalledWith(8891);
    expect(lifecycle.startDaemon).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartDetached).not.toHaveBeenCalled();
  });
});
