import { describe, expect, it } from "vitest";
import { codexMcpConfigFlags, resolveMcpServers } from "../resolver.js";

describe("MCP resolver", () => {
  it("resolves browser automation to the Playwright MCP server", () => {
    const resolved = resolveMcpServers({
      browser: { enabled: true, provider: "playwright" },
    });

    expect(resolved.mcpServers.browser).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.78"],
    });
  });

  it("converts resolved MCP servers to Codex config overrides", () => {
    const flags = codexMcpConfigFlags({
      mcpServers: {
        browser: { command: "npx", args: ["-y", "@playwright/mcp@0.0.78"] },
      },
    });

    expect(flags).toEqual([
      "-c",
      'mcp_servers.browser.command="npx"',
      "-c",
      'mcp_servers.browser.args=["-y", "@playwright/mcp@0.0.78"]',
    ]);
  });

  it("pins each built-in npx package and does not launch the retired fetch package", () => {
    const resolved = resolveMcpServers({
      browser: { enabled: true, provider: "puppeteer" },
      search: { enabled: true, provider: "brave", apiKey: "brave-key" },
      fetch: { enabled: true },
    });

    expect(resolved.mcpServers.browser).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer@2025.5.12"] });
    expect(resolved.mcpServers.search).toEqual({ command: "npx", args: ["-y", "brave-search-mcp@2.1.0"], env: { BRAVE_API_KEY: "brave-key" } });
    expect(resolved.mcpServers.fetch).toBeUndefined();
    for (const server of Object.values(resolved.mcpServers)) {
      if ("args" in server) expect(server.args?.some((arg) => arg === "@latest")).toBe(false);
    }
  });
});
