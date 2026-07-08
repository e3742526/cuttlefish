import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuttlefishConfig } from "../types.js";

const readCodexAppServerResult = vi.fn();

vi.mock("../codex-app-server.js", () => ({
  readCodexAppServerResult,
}));

function cfg(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "codex",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    connectors: {},
  } as CuttlefishConfig;
}

describe("discoverCodexModels", () => {
  beforeEach(() => {
    vi.resetModules();
    readCodexAppServerResult.mockReset();
  });

  it("maps app-server model/list pages into registry models", async () => {
    readCodexAppServerResult
      .mockResolvedValueOnce({
        data: [
          {
            id: "gpt-5.6",
            displayName: "GPT-5.6",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "high", description: "Deep" },
            ],
          },
        ],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5 Codex",
            isDefault: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
          },
        ],
        nextCursor: null,
      });

    const { discoverCodexModels } = await import("../codex-models.js");
    const discovered = await discoverCodexModels(cfg());

    expect(readCodexAppServerResult).toHaveBeenNthCalledWith(1, expect.anything(), {
      method: "model/list",
      params: { includeHidden: false, limit: 100 },
      timeoutMs: 8000,
    });
    expect(readCodexAppServerResult).toHaveBeenNthCalledWith(2, expect.anything(), {
      method: "model/list",
      params: { cursor: "page-2", includeHidden: false, limit: 100 },
      timeoutMs: 8000,
    });
    expect(discovered).toEqual({
      defaultModel: "gpt-5.6",
      models: [
        { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
        { id: "gpt-5.5", label: "GPT-5.5 Codex", supportsEffort: true, effortLevels: ["medium"] },
      ],
    });
  });

  it("does not map a stray context-window-like field from the app-server payload", async () => {
    readCodexAppServerResult.mockResolvedValueOnce({
      data: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5 Codex",
          isDefault: true,
          contextWindow: 999,
          context_window: 999,
          tokenLimit: 999,
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        },
      ],
      nextCursor: null,
    });

    const { discoverCodexModels } = await import("../codex-models.js");
    const discovered = await discoverCodexModels(cfg());

    expect(discovered.models).toEqual([
      { id: "gpt-5.5", label: "GPT-5.5 Codex", supportsEffort: true, effortLevels: ["medium"] },
    ]);
    expect(discovered.models[0]).not.toHaveProperty("contextWindow");
  });

  it("stops when model/list repeats a nextCursor", async () => {
    readCodexAppServerResult
      .mockResolvedValueOnce({
        data: [
          {
            id: "gpt-5.6",
            displayName: "GPT-5.6",
            isDefault: true,
            supportedReasoningEfforts: ["medium"],
          },
        ],
        nextCursor: "loop",
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            supportedReasoningEfforts: ["low"],
          },
        ],
        nextCursor: "loop",
      });

    const { discoverCodexModels } = await import("../codex-models.js");
    const discovered = await discoverCodexModels(cfg());

    expect(readCodexAppServerResult).toHaveBeenCalledTimes(2);
    expect(discovered.models.map((model) => model.id)).toEqual(["gpt-5.6", "gpt-5.5"]);
  });

  it("caps model/list pagination when nextCursor never converges", async () => {
    readCodexAppServerResult.mockImplementation(async (_config, request) => {
      const cursor = (request.params as { cursor?: string }).cursor;
      const page = cursor ? Number(cursor.replace("page-", "")) : 1;
      return {
        data: [],
        nextCursor: `page-${page + 1}`,
      };
    });

    const { discoverCodexModels } = await import("../codex-models.js");
    const discovered = await discoverCodexModels(cfg());

    expect(readCodexAppServerResult).toHaveBeenCalledTimes(20);
    expect(discovered).toEqual({ defaultModel: undefined, models: [] });
  });

  it("stops once the total discovery deadline is exhausted", async () => {
    let now = 10_000;
    let page = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    readCodexAppServerResult.mockImplementation(async () => {
      const currentPage = page;
      page += 1;
      now += 7_500;
      return {
        data: [],
        nextCursor: `page-${currentPage + 1}`,
      };
    });

    const { discoverCodexModels } = await import("../codex-models.js");
    const discovered = await discoverCodexModels(cfg());

    expect(readCodexAppServerResult).toHaveBeenCalledTimes(2);
    expect(readCodexAppServerResult).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      timeoutMs: 8000,
    }));
    expect(readCodexAppServerResult).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      timeoutMs: 7500,
    }));
    expect(discovered).toEqual({ defaultModel: undefined, models: [] });
  });
});
