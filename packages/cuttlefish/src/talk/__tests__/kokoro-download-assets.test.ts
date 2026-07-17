import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveKokoroDownloadAssets } from "../kokoro.js";

describe("Kokoro download asset resolution", () => {
  it("keeps every verified release asset inside a custom model directory", () => {
    const modelDir = path.join(path.sep, "tmp", "custom-kokoro");
    const assets = resolveKokoroDownloadAssets(modelDir);
    expect(assets.map((asset) => asset.dest)).toEqual([
      path.join(modelDir, "kokoro-v1.0.onnx"),
      path.join(modelDir, "voices-v1.0.bin"),
    ]);
    for (const asset of assets) {
      expect(asset.dest.startsWith(`${modelDir}${path.sep}`)).toBe(true);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.size).toBeGreaterThan(1_000_000);
    }
  });
});
