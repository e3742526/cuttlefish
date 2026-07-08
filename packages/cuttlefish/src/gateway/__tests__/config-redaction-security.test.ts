import { describe, expect, it } from "vitest";
import { deepMerge, isSensitiveConfigKey, sanitizeConfigForApi } from "../api.js";

describe("GET /api/config redaction", () => {
  it("recognizes common secret-bearing key names", () => {
    expect(isSensitiveConfigKey("token")).toBe(true);
    expect(isSensitiveConfigKey("botToken")).toBe(true);
    expect(isSensitiveConfigKey("api_key")).toBe(true);
    expect(isSensitiveConfigKey("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveConfigKey("clientSecret")).toBe(true);
    expect(isSensitiveConfigKey("private-key")).toBe(true);
    expect(isSensitiveConfigKey("model")).toBe(false);
  });

  it("recognizes the widened CF2-208 key list without over-matching ordinary keys", () => {
    expect(isSensitiveConfigKey("GITHUB_PAT")).toBe(true);
    expect(isSensitiveConfigKey("slack-pat")).toBe(true);
    expect(isSensitiveConfigKey("SENTRY_DSN")).toBe(true);
    expect(isSensitiveConfigKey("dbConnectionString")).toBe(true);
    expect(isSensitiveConfigKey("Cookie")).toBe(true);
    expect(isSensitiveConfigKey("x-auth-cookie")).toBe(true);
    expect(isSensitiveConfigKey("bearerToken")).toBe(true);
    expect(isSensitiveConfigKey("awsCredential")).toBe(true);
    // Must NOT false-positive on ordinary keys that merely contain "pat" as a substring.
    expect(isSensitiveConfigKey("path")).toBe(false);
    expect(isSensitiveConfigKey("filePath")).toBe(false);
    expect(isSensitiveConfigKey("pattern")).toBe(false);
    expect(isSensitiveConfigKey("compatMode")).toBe(false);
  });

  it("redacts DSN/URL-userinfo values regardless of key name (CF2-208)", () => {
    const sanitized = sanitizeConfigForApi({
      database: { url: "postgresql://svc_user:sup3rSecret@db.internal:5432/prod" },
      cache: { endpoint: "redis://:cachepass@redis.internal:6379/0" },
      remotes: [{ id: "dev", token: "remote-secret", url: "http://127.0.0.1:8888" }],
    });
    expect(sanitized.database.url).toBe("***");
    expect(sanitized.cache.endpoint).toBe("***");
    // A userinfo-free URL must not be swept up by the value-shape check.
    expect(sanitized.remotes[0].url).toBe("http://127.0.0.1:8888");
  });

  it("round-trips a value-shape-redacted DSN through deepMerge without corrupting it", () => {
    const original = { database: { url: "postgresql://svc_user:sup3rSecret@db.internal:5432/prod", label: "primary" } };
    const sanitized = sanitizeConfigForApi(original);
    expect(sanitized.database.url).toBe("***");

    const merged = deepMerge(original, { database: { url: "***", label: "primary (renamed)" } });
    expect((merged.database as { url: string; label: string }).url).toBe("postgresql://svc_user:sup3rSecret@db.internal:5432/prod");
    expect((merged.database as { url: string; label: string }).label).toBe("primary (renamed)");
  });

  it("recursively redacts connector, engine, MCP, and remote secrets", () => {
    const sanitized = sanitizeConfigForApi({
      gateway: { port: 8888 },
      engines: {
        claude: { model: "opus", apiKey: "sk-claude" },
      },
      connectors: {
        slack: { botToken: "xoxb-secret", signingSecret: "signing-secret" },
      },
      mcp: {
        servers: {
          search: { env: { BRAVE_API_KEY: "brave-secret", SAFE_VALUE: "kept" } },
        },
      },
      remotes: [{ id: "dev", token: "remote-secret", url: "http://127.0.0.1:8888" }],
    });

    expect(sanitized.engines.claude.apiKey).toBe("***");
    expect(sanitized.connectors.slack.botToken).toBe("***");
    expect(sanitized.connectors.slack.signingSecret).toBe("***");
    expect(sanitized.mcp.servers.search.env.BRAVE_API_KEY).toBe("***");
    expect(sanitized.mcp.servers.search.env.SAFE_VALUE).toBe("kept");
    expect(sanitized.remotes[0].token).toBe("***");
    expect(sanitized.remotes[0].url).toBe("http://127.0.0.1:8888");
  });

  it("redacts email passwords and preserves them across *** round-trips", () => {
    const original = {
      email: {
        inboxes: [{
          id: "ops",
          password: "imap-secret",
          username: "ops@example.com",
          address: "ops@example.com",
          imapHost: "imap.example.com",
        }],
      },
    };
    const sanitized = sanitizeConfigForApi(original);
    expect(sanitized.email.inboxes[0].password).toBe("***");

    const merged = deepMerge(original, {
      email: {
        inboxes: [{
          id: "ops",
          password: "***",
          username: "ops@example.com",
          address: "ops@example.com",
          imapHost: "imap.example.com",
        }],
      },
    });
    expect((merged.email as { inboxes: Array<{ password: string }> }).inboxes[0].password).toBe("imap-secret");
  });
});
