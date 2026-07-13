import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpGlobalConfig, McpServerConfig, McpServerStdioConfig, McpServerUrlConfig, Employee } from "../shared/types.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { safeWriteFile } from "../shared/safe-write.js";

// Built-in MCP processes execute in an agent's tool boundary. Exact package
// versions make the code selected by a Cuttlefish release reviewable and prevent
// an upstream `latest` tag movement from silently changing that boundary.
const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.78";
const PUPPETEER_MCP_PACKAGE = "@modelcontextprotocol/server-puppeteer@2025.5.12";
const BRAVE_SEARCH_MCP_PACKAGE = "brave-search-mcp@2.1.0";
let warnedUnavailableFetch = false;

export interface ResolvedMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Resolve the MCP servers that should be available for a given employee
 * based on global config and employee-level overrides.
 */
export function resolveMcpServers(
  globalMcp: McpGlobalConfig | undefined,
  employee?: Employee,
): ResolvedMcpConfig {
  const servers: Record<string, McpServerConfig> = {};

  if (!globalMcp) return { mcpServers: servers };

  // Build the full set of available MCP servers from global config
  const available = buildAvailableServers(globalMcp);

  // Determine which servers this employee gets
  const employeeMcp = employee?.mcp;

  if (employeeMcp === false) {
    // Employee explicitly opted out of all MCP servers
    return { mcpServers: {} };
  }

  if (Array.isArray(employeeMcp)) {
    // Employee wants only specific servers
    for (const name of employeeMcp) {
      if (available[name]) {
        servers[name] = available[name];
      } else {
        logger.warn(`Employee ${employee?.name} requests MCP server "${name}" but it's not configured`);
      }
    }
  } else {
    // Employee gets all enabled servers (default behavior, or mcp: true)
    Object.assign(servers, available);
  }

  return { mcpServers: servers };
}

/**
 * Build the map of all available (enabled) MCP servers from global config.
 */
function buildAvailableServers(config: McpGlobalConfig): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  // Browser automation via Playwright
  if (config.browser?.enabled !== false) {
    const provider = config.browser?.provider || "playwright";
    if (provider === "playwright") {
      servers.browser = {
        command: "npx",
        args: ["-y", PLAYWRIGHT_MCP_PACKAGE],
      };
    } else if (provider === "puppeteer") {
      servers.browser = {
        command: "npx",
        args: ["-y", PUPPETEER_MCP_PACKAGE],
      };
    }
  }

  // Web search via Brave
  if (config.search?.enabled) {
    const apiKey = resolveEnvVar(config.search.apiKey);
    if (apiKey) {
      servers.search = {
        command: "npx",
        args: ["-y", BRAVE_SEARCH_MCP_PACKAGE],
        env: { BRAVE_API_KEY: apiKey },
      };
    } else {
      logger.warn("MCP search enabled but no API key configured (set mcp.search.apiKey or BRAVE_API_KEY env var)");
    }
  }

  // The historical @anthropic-ai fetch MCP package is no longer published.
  // Keep the configuration key for backwards-compatible parsing, but never
  // launch an unresolvable or mutable replacement automatically. Operators can
  // opt into a reviewed, pinned custom MCP fetch server instead.
  if (config.fetch?.enabled) {
    if (!warnedUnavailableFetch) {
      warnedUnavailableFetch = true;
      logger.warn("Built-in MCP fetch is unavailable; configure a reviewed pinned mcp.custom fetch server instead");
    }
  }

  // Custom user-defined MCP servers
  if (config.custom) {
    for (const [name, serverConfig] of Object.entries(config.custom)) {
      if (serverConfig.enabled === false) continue;
      const { enabled, ...rest } = serverConfig;

      // URL-based MCP server (HTTP/SSE transport)
      // Claude Code requires "type": "sse" for URL-based servers
      if ("url" in rest && (rest as McpServerUrlConfig).url) {
        servers[name] = { type: "sse", ...rest } as McpServerConfig;
        continue;
      }

      // Stdio-based MCP server — resolve env vars
      if ("env" in rest && rest.env) {
        for (const [key, value] of Object.entries(rest.env)) {
          rest.env[key] = resolveEnvVar(value) || value;
        }
      }
      servers[name] = rest as McpServerConfig;
    }
  }

  return servers;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function codexMcpServerFlags(name: string, server: McpServerConfig): string[] {
  const prefix = `mcp_servers.${name}`;
  const flags: string[] = [];
  if ("url" in server && server.url) {
    flags.push("-c", `${prefix}.url=${tomlString(server.url)}`);
    const bearer = (server as any).bearer_token_env_var ?? (server as any).bearerTokenEnvVar;
    if (typeof bearer === "string" && bearer) flags.push("-c", `${prefix}.bearer_token_env_var=${tomlString(bearer)}`);
    return flags;
  }

  const stdio = server as McpServerStdioConfig & { cwd?: string };
  flags.push("-c", `${prefix}.command=${tomlString(stdio.command)}`);
  if (stdio.args?.length) flags.push("-c", `${prefix}.args=${tomlStringArray(stdio.args)}`);
  if (stdio.cwd) flags.push("-c", `${prefix}.cwd=${tomlString(stdio.cwd)}`);
  if (stdio.env) {
    for (const [key, value] of Object.entries(stdio.env)) {
      flags.push("-c", `${prefix}.env.${key}=${tomlString(value)}`);
    }
  }
  return flags;
}

/**
 * Convert a resolved Cuttlefish MCP config into Codex CLI config overrides.
 * Codex does not accept Claude's --mcp-config JSON file; it reads
 * mcp_servers.<name> from config.toml, and `-c` can inject those keys per run.
 */
export function codexMcpConfigFlags(config: ResolvedMcpConfig): string[] {
  const flags: string[] = [];
  for (const [name, server] of Object.entries(config.mcpServers)) {
    flags.push(...codexMcpServerFlags(name, server));
  }
  return flags;
}

export function codexMcpConfigFlagsFromFile(configPath: string | undefined): string[] {
  if (!configPath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ResolvedMcpConfig;
    return codexMcpConfigFlags(parsed);
  } catch (err) {
    logger.warn(`Failed to read MCP config for Codex from ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Write a resolved MCP config to a temp file and return the path.
 * Claude Code reads this via --mcp-config <path>; Codex reads the same file
 * through codexMcpConfigFlagsFromFile() and receives equivalent -c overrides.
 */
export function writeMcpConfigFile(config: ResolvedMcpConfig, sessionId: string): string {
  const tmpDir = path.join(CUTTLEFISH_HOME, "tmp", "mcp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `${sessionId}.json`);
  safeWriteFile(filePath, JSON.stringify(config, null, 2)); // atomic + fsync (resolved MCP config read by the engine)
  return filePath;
}

/**
 * Clean up a temp MCP config file.
 */
export function cleanupMcpConfigFile(sessionId: string): void {
  const filePath = path.join(CUTTLEFISH_HOME, "tmp", "mcp", `${sessionId}.json`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Resolve a value that may reference an environment variable.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]] || undefined;
  }
  // Also check if the raw value is a plain env var name
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] || undefined;
  }
  return value;
}
