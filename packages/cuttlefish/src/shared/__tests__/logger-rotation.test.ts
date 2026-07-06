import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { configureLogger, logger } from "../logger.js";

describe("logger rotation (REL-RES-003)", () => {
  it("rotates gateway.log once the configured size cap is exceeded", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({ size: 0 } as any);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined as any);
    let streamsOpened = 0;
    vi.spyOn(fs, "createWriteStream").mockImplementation(() => {
      streamsOpened++;
      return { write: () => {}, end: () => {} } as any;
    });

    configureLogger({ level: "debug", stdout: false, file: true, maxSizeBytes: 50, maxFiles: 3 });
    expect(streamsOpened).toBe(1);

    for (let i = 0; i < 10; i++) {
      logger.info(`line ${i} - padding to exceed the tiny cap quickly`);
    }

    // Each rotation shifts .1 -> .2 and gateway.log -> .1 (maxFiles - 1 renames), then reopens the stream.
    expect(renameSpy).toHaveBeenCalled();
    expect(streamsOpened).toBeGreaterThan(1);

    vi.restoreAllMocks();
  });

  it("does not rotate while under the size cap", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined as any);
    let streamsOpened = 0;
    vi.spyOn(fs, "createWriteStream").mockImplementation(() => {
      streamsOpened++;
      return { write: () => {}, end: () => {} } as any;
    });

    configureLogger({ level: "debug", stdout: false, file: true, maxSizeBytes: 10 * 1024 * 1024, maxFiles: 3 });
    logger.info("a short line");
    logger.info("another short line");

    expect(renameSpy).not.toHaveBeenCalled();
    expect(streamsOpened).toBe(1);

    vi.restoreAllMocks();
  });
});
