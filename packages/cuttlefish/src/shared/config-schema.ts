import type { EngineFailureReason } from "./types.js";
import { validateKnowledge } from "./config-schema-knowledge.js";

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ENGINE_NAMES = new Set(["claude", "codex", "antigravity", "grok", "pi", "kiro", "hermes", "ollama", "kilo", "aider"]);
const FALLBACK_MODES = new Set(["auto", "ask_user", "never"]);
const RETURN_POLICIES = new Set(["ask_user", "auto", "never", "stay_on_fallback"]);
const ENGINE_FAILURE_REASONS = new Set<EngineFailureReason>([
  "rate_limit",
  "quota_exhausted",
  "engine_unavailable",
  "timeout",
  "auth_failure",
  "context_overflow",
  "unknown",
]);
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pushUnknownKeys(
  problems: string[],
  value: Record<string, unknown>,
  allowed: Iterable<string>,
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    const prefix = label === "config" ? "unknown config keys" : `unknown ${label} config keys`;
    problems.push(`${prefix}: ${unknown.join(", ")}`);
  }
}
function validateStringArray(problems: string[], path: string, value: unknown): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    problems.push(`${path} must be an array of strings`);
  }
}
function validateNumber(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "number") problems.push(`${path} must be a number (got ${typeof value})`);
}
function validatePort(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    problems.push(`${path} must be an integer from 1 to 65535`);
  }
}
function validateString(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "string") problems.push(`${path} must be a string (got ${typeof value})`);
}

function validateBoolean(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "boolean") problems.push(`${path} must be a boolean (got ${typeof value})`);
}

function validateStringOrStringArray(problems: string[], path: string, value: unknown): void {
  const valid = typeof value === "string" || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
  if (!valid) problems.push(`${path} must be a string or array of strings`);
}


function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}
function validateExecString(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "string") {
    problems.push(`${path} must be a string (got ${typeof value})`);
    return;
  }
  if (hasControlChars(value)) {
    problems.push(`${path} must not contain control characters or newlines`);
  }
}

function validateWorkspaces(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("workspaces must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["roots", "defaultCwd"], "workspaces");
  if (value.roots !== undefined) validateStringArray(problems, "workspaces.roots", value.roots);
  if (value.defaultCwd !== undefined) validateString(problems, "workspaces.defaultCwd", value.defaultCwd);
}
function validateGateway(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("gateway must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, [
    "port",
    "host",
    "streaming",
    "turnStallInactivityMs",
    "turnStallLeaderCheckMs",
    "leaderAckTimeoutMs",
    "leaderAckMaxEscalations",
    "turnStallCeilingMs",
    "turnStallRetries",
    "allowFileCustomPaths",
    "allowFileOpen",
    "fileReadRoots",
    "allowArbitraryFileRead",
    "exposeResolvedFilePaths",
    "userHeader",
  ], "gateway");
  if (value.port !== undefined) validatePort(problems, "gateway.port", value.port);
  if (value.host !== undefined) validateString(problems, "gateway.host", value.host);
  if (value.streaming !== undefined) validateBoolean(problems, "gateway.streaming", value.streaming);
  if (value.turnStallInactivityMs !== undefined) validateNumber(problems, "gateway.turnStallInactivityMs", value.turnStallInactivityMs);
  if (value.turnStallLeaderCheckMs !== undefined) validateNumber(problems, "gateway.turnStallLeaderCheckMs", value.turnStallLeaderCheckMs);
  if (value.leaderAckTimeoutMs !== undefined) validateNumber(problems, "gateway.leaderAckTimeoutMs", value.leaderAckTimeoutMs);
  if (value.leaderAckMaxEscalations !== undefined) validateNumber(problems, "gateway.leaderAckMaxEscalations", value.leaderAckMaxEscalations);
  if (value.turnStallCeilingMs !== undefined) validateNumber(problems, "gateway.turnStallCeilingMs", value.turnStallCeilingMs);
  if (value.turnStallRetries !== undefined) validateNumber(problems, "gateway.turnStallRetries", value.turnStallRetries);
  if (value.allowFileCustomPaths !== undefined) validateBoolean(problems, "gateway.allowFileCustomPaths", value.allowFileCustomPaths);
  if (value.allowFileOpen !== undefined) validateBoolean(problems, "gateway.allowFileOpen", value.allowFileOpen);
  if (value.fileReadRoots !== undefined) validateStringArray(problems, "gateway.fileReadRoots", value.fileReadRoots);
  if (value.allowArbitraryFileRead !== undefined) validateBoolean(problems, "gateway.allowArbitraryFileRead", value.allowArbitraryFileRead);
  if (value.exposeResolvedFilePaths !== undefined) validateBoolean(problems, "gateway.exposeResolvedFilePaths", value.exposeResolvedFilePaths);
  if (value.userHeader !== undefined) validateStringOrStringArray(problems, "gateway.userHeader", value.userHeader);
}

function validateEngineConfig(
  problems: string[],
  path: string,
  value: unknown,
  allowed: string[],
): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return null;
  }
  pushUnknownKeys(problems, value, allowed, path);
  if (value.bin !== undefined) validateExecString(problems, `${path}.bin`, value.bin);
  if (value.model !== undefined) validateString(problems, `${path}.model`, value.model);
  if (value.effortLevel !== undefined) validateString(problems, `${path}.effortLevel`, value.effortLevel);
  if (value.childEffortOverride !== undefined) validateString(problems, `${path}.childEffortOverride`, value.childEffortOverride);
  return value;
}

function validateEngines(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("engines must be a mapping with at least an engines.claude entry");
    return;
  }
  pushUnknownKeys(problems, value, ["default", "claude", "codex", "antigravity", "grok", "pi", "kiro", "hermes", "ollama", "kilo", "aider"], "engines");
  if (value.default !== undefined) validateString(problems, "engines.default", value.default);
  if (value.claude === undefined) {
    problems.push("engines.claude must be a mapping");
  }
  validateEngineConfig(problems, "engines.claude", value.claude, ["bin", "model", "effortLevel", "childEffortOverride", "maxLivePtys"]);
  validateEngineConfig(problems, "engines.codex", value.codex, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.antigravity !== undefined) validateEngineConfig(problems, "engines.antigravity", value.antigravity, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.grok !== undefined) validateEngineConfig(problems, "engines.grok", value.grok, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.pi !== undefined) validateEngineConfig(problems, "engines.pi", value.pi, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.ollama !== undefined) validateEngineConfig(problems, "engines.ollama", value.ollama, ["bin", "model"]);
  if (value.kilo !== undefined) validateEngineConfig(problems, "engines.kilo", value.kilo, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.aider !== undefined) validateEngineConfig(problems, "engines.aider", value.aider, ["bin", "model"]);
  if (value.claude !== undefined && isPlainObject(value.claude) && value.claude.maxLivePtys !== undefined) {
    validateNumber(problems, "engines.claude.maxLivePtys", value.claude.maxLivePtys);
  }
  if (value.kiro !== undefined) {
    const kiro = validateEngineConfig(problems, "engines.kiro", value.kiro, [
      "bin",
      "model",
      "effortLevel",
      "childEffortOverride",
      "creditBudget",
      "billingAnchorDay",
    ]);
    if (kiro?.creditBudget !== undefined) validateNumber(problems, "engines.kiro.creditBudget", kiro.creditBudget);
    if (kiro?.billingAnchorDay !== undefined) validateNumber(problems, "engines.kiro.billingAnchorDay", kiro.billingAnchorDay);
  }
  if (value.hermes !== undefined) validateEngineConfig(problems, "engines.hermes", value.hermes, ["bin", "model"]);
}

function validateModels(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("models must be a mapping");
    return;
  }
  for (const [engine, entry] of Object.entries(value)) {
    if (!ENGINE_NAMES.has(engine)) {
      problems.push(`unknown models config keys: ${engine}`);
      continue;
    }
    if (!isPlainObject(entry)) {
      problems.push(`models.${engine} must be a mapping`);
      continue;
    }
    pushUnknownKeys(problems, entry, ["default", "effortMechanism", "models"], `models.${engine}`);
    if (entry.default !== undefined) validateString(problems, `models.${engine}.default`, entry.default);
    if (entry.effortMechanism !== undefined) validateString(problems, `models.${engine}.effortMechanism`, entry.effortMechanism);
    if (!Array.isArray(entry.models)) {
      problems.push(`models.${engine}.models must be an array`);
      continue;
    }
    for (const [index, model] of entry.models.entries()) {
      if (!isPlainObject(model)) {
        problems.push(`models.${engine}.models[${index}] must be a mapping`);
        continue;
      }
      pushUnknownKeys(problems, model, ["id", "label", "supportsEffort", "effortLevels", "contextWindow"], `models.${engine}.models[${index}]`);
      if (typeof model.id !== "string" || !model.id.trim()) problems.push(`models.${engine}.models[${index}].id must be a non-empty string`);
      if (model.label !== undefined) validateString(problems, `models.${engine}.models[${index}].label`, model.label);
      if (model.supportsEffort !== undefined) validateBoolean(problems, `models.${engine}.models[${index}].supportsEffort`, model.supportsEffort);
      if (model.effortLevels !== undefined) validateStringArray(problems, `models.${engine}.models[${index}].effortLevels`, model.effortLevels);
      if (model.contextWindow !== undefined) validateNumber(problems, `models.${engine}.models[${index}].contextWindow`, model.contextWindow);
    }
  }
}
function validateSlackConnector(problems: string[], path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["id", "employee", "appToken", "botToken", "allowFrom", "ignoreOldMessagesOnBoot", "shareSessionInChannel"], path);
  if (value.id !== undefined) validateString(problems, `${path}.id`, value.id);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.appToken !== undefined) validateString(problems, `${path}.appToken`, value.appToken);
  if (value.botToken !== undefined) validateString(problems, `${path}.botToken`, value.botToken);
  if (value.allowFrom !== undefined) validateStringOrStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  if (value.ignoreOldMessagesOnBoot !== undefined) validateBoolean(problems, `${path}.ignoreOldMessagesOnBoot`, value.ignoreOldMessagesOnBoot);
  if (value.shareSessionInChannel !== undefined) validateBoolean(problems, `${path}.shareSessionInChannel`, value.shareSessionInChannel);
}

function validateWhatsAppConnector(problems: string[], path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["id", "employee", "authDir", "allowFrom", "ignoreOldMessagesOnBoot"], path);
  if (value.id !== undefined) validateString(problems, `${path}.id`, value.id);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.authDir !== undefined) validateString(problems, `${path}.authDir`, value.authDir);
  if (value.allowFrom !== undefined) validateStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  if (value.ignoreOldMessagesOnBoot !== undefined) validateBoolean(problems, `${path}.ignoreOldMessagesOnBoot`, value.ignoreOldMessagesOnBoot);
}

function validateConnectorInstance(
  problems: string[],
  value: unknown,
  index: number,
): void {
  const path = `connectors.instances[${index}]`;
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  if (typeof value.id !== "string" || !value.id.trim()) problems.push(`${path}.id must be a non-empty string`);
  if (typeof value.type !== "string" || !value.type.trim()) {
    problems.push(`${path}.type must be a non-empty string`);
    return;
  }
  const type = value.type;
  const baseKeys = ["id", "type", "employee", "ignoreOldMessagesOnBoot"];
  const keysByType: Record<string, string[]> = {
    slack: [...baseKeys, "appToken", "botToken", "allowFrom"],
    whatsapp: [...baseKeys, "authDir", "allowFrom"],
  };
  if (!keysByType[type]) {
    problems.push(`${path}.type must be one of: ${Object.keys(keysByType).join(", ")}`);
    return;
  }
  pushUnknownKeys(problems, value, keysByType[type], path);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.ignoreOldMessagesOnBoot !== undefined) validateBoolean(problems, `${path}.ignoreOldMessagesOnBoot`, value.ignoreOldMessagesOnBoot);
  if (value.allowFrom !== undefined) {
    validateStringOrStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  }
  if (value.botToken !== undefined) validateString(problems, `${path}.botToken`, value.botToken);
  if (value.appToken !== undefined) validateString(problems, `${path}.appToken`, value.appToken);
  if (value.authDir !== undefined) validateString(problems, `${path}.authDir`, value.authDir);
}

function validateConnectors(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("connectors must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["web", "slack", "whatsapp", "instances"], "connectors");
  if (value.web !== undefined && !isPlainObject(value.web)) problems.push("connectors.web must be a mapping");
  if (value.slack !== undefined) validateSlackConnector(problems, "connectors.slack", value.slack);
  if (value.whatsapp !== undefined) validateWhatsAppConnector(problems, "connectors.whatsapp", value.whatsapp);
  if (value.instances !== undefined) {
    if (!Array.isArray(value.instances)) {
      problems.push("connectors.instances must be an array");
    } else {
      value.instances.forEach((instance, index) => validateConnectorInstance(problems, instance, index));
    }
  }
}

function validateEmailInbox(problems: string[], path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, [
    "id",
    "label",
    "address",
    "username",
    "password",
    "imapHost",
    "imapPort",
    "useTls",
    "folder",
    "autoIngest",
    "allowFrom",
    "unreadOnly",
    "maxMessagesPerPoll",
    "maxMessageBytes",
  ], path);
  if (typeof value.id !== "string" || !value.id.trim()) problems.push(`${path}.id must be a non-empty string`);
  if (value.label !== undefined) validateString(problems, `${path}.label`, value.label);
  if (typeof value.address !== "string" || !value.address.trim()) problems.push(`${path}.address must be a non-empty string`);
  if (typeof value.username !== "string" || !value.username.trim()) problems.push(`${path}.username must be a non-empty string`);
  if (typeof value.password !== "string" || !value.password.trim()) problems.push(`${path}.password must be a non-empty string`);
  if (typeof value.imapHost !== "string" || !value.imapHost.trim()) problems.push(`${path}.imapHost must be a non-empty string`);
  if (value.imapPort !== undefined) validatePort(problems, `${path}.imapPort`, value.imapPort);
  if (value.useTls !== undefined) validateBoolean(problems, `${path}.useTls`, value.useTls);
  if (value.folder !== undefined) validateString(problems, `${path}.folder`, value.folder);
  if (value.autoIngest !== undefined) validateBoolean(problems, `${path}.autoIngest`, value.autoIngest);
  if (value.allowFrom !== undefined) validateStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  if (value.unreadOnly !== undefined) validateBoolean(problems, `${path}.unreadOnly`, value.unreadOnly);
  if (value.maxMessagesPerPoll !== undefined) validateNumber(problems, `${path}.maxMessagesPerPoll`, value.maxMessagesPerPoll);
  if (value.maxMessageBytes !== undefined) validateNumber(problems, `${path}.maxMessageBytes`, value.maxMessageBytes);
}

function validateEmail(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("email must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "pollIntervalSeconds", "inboxes"], "email");
  if (value.enabled !== undefined) validateBoolean(problems, "email.enabled", value.enabled);
  if (value.pollIntervalSeconds !== undefined) validateNumber(problems, "email.pollIntervalSeconds", value.pollIntervalSeconds);
  if (value.inboxes !== undefined) {
    if (!Array.isArray(value.inboxes)) {
      problems.push("email.inboxes must be an array");
    } else {
      if (value.inboxes.length > 3) problems.push("email.inboxes must contain at most 3 inboxes");
      const ids = new Set<string>();
      value.inboxes.forEach((entry, index) => {
        const path = `email.inboxes[${index}]`;
        validateEmailInbox(problems, path, entry);
        if (isPlainObject(entry) && typeof entry.id === "string" && entry.id.trim()) {
          if (ids.has(entry.id.trim())) problems.push(`duplicate email inbox id: ${entry.id.trim()}`);
          ids.add(entry.id.trim());
        }
      });
    }
  }
  if (value.enabled === true && (!Array.isArray(value.inboxes) || value.inboxes.length === 0)) {
    problems.push("email.enabled requires at least one configured inbox");
  }
}

function validateLogging(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("logging must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["file", "stdout", "level"], "logging");
  if (value.file !== undefined) validateBoolean(problems, "logging.file", value.file);
  if (value.stdout !== undefined) validateBoolean(problems, "logging.stdout", value.stdout);
  if (value.level !== undefined) validateString(problems, "logging.level", value.level);
}

function validateMcp(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("mcp must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["browser", "search", "fetch", "custom", "gateway"], "mcp");
  if (value.browser !== undefined) {
    if (!isPlainObject(value.browser)) {
      problems.push("mcp.browser must be a mapping");
    } else {
      pushUnknownKeys(problems, value.browser, ["enabled", "provider"], "mcp.browser");
      if (value.browser.enabled !== undefined) validateBoolean(problems, "mcp.browser.enabled", value.browser.enabled);
      if (value.browser.provider !== undefined) validateString(problems, "mcp.browser.provider", value.browser.provider);
    }
  }
  if (value.search !== undefined) {
    if (!isPlainObject(value.search)) {
      problems.push("mcp.search must be a mapping");
    } else {
      pushUnknownKeys(problems, value.search, ["enabled", "provider", "apiKey"], "mcp.search");
      if (value.search.enabled !== undefined) validateBoolean(problems, "mcp.search.enabled", value.search.enabled);
      if (value.search.provider !== undefined) validateString(problems, "mcp.search.provider", value.search.provider);
      if (value.search.apiKey !== undefined) validateString(problems, "mcp.search.apiKey", value.search.apiKey);
    }
  }
  if (value.fetch !== undefined) {
    if (!isPlainObject(value.fetch)) {
      problems.push("mcp.fetch must be a mapping");
    } else {
      pushUnknownKeys(problems, value.fetch, ["enabled"], "mcp.fetch");
      if (value.fetch.enabled !== undefined) validateBoolean(problems, "mcp.fetch.enabled", value.fetch.enabled);
    }
  }
  if (value.gateway !== undefined) {
    if (!isPlainObject(value.gateway)) {
      problems.push("mcp.gateway must be a mapping");
    } else {
      pushUnknownKeys(problems, value.gateway, ["enabled"], "mcp.gateway");
      if (value.gateway.enabled !== undefined) validateBoolean(problems, "mcp.gateway.enabled", value.gateway.enabled);
    }
  }
  if (value.custom !== undefined) {
    if (!isPlainObject(value.custom)) {
      problems.push("mcp.custom must be a mapping");
    } else {
      for (const [name, server] of Object.entries(value.custom)) {
        if (!isPlainObject(server)) {
          problems.push(`mcp.custom.${name} must be a mapping`);
          continue;
        }
        pushUnknownKeys(problems, server, ["enabled", "command", "args", "env", "type", "url", "headers"], `mcp.custom.${name}`);
        if (server.enabled !== undefined) validateBoolean(problems, `mcp.custom.${name}.enabled`, server.enabled);
        if (server.command !== undefined) validateExecString(problems, `mcp.custom.${name}.command`, server.command);
        if (server.args !== undefined) validateStringArray(problems, `mcp.custom.${name}.args`, server.args);
        if (server.type !== undefined) validateString(problems, `mcp.custom.${name}.type`, server.type);
        if (server.url !== undefined) validateString(problems, `mcp.custom.${name}.url`, server.url);
        if (server.env !== undefined && !isPlainObject(server.env)) problems.push(`mcp.custom.${name}.env must be a mapping`);
        if (server.headers !== undefined && !isPlainObject(server.headers)) problems.push(`mcp.custom.${name}.headers must be a mapping`);
      }
    }
  }
}

function validateFallbackTarget(
  problems: string[],
  path: string,
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["engine", "model", "effortLevel", "employee", "reason"], path);
  if (typeof value.engine !== "string" || !value.engine.trim()) problems.push(`${path}.engine must be a non-empty string`);
  if (value.model !== undefined) validateString(problems, `${path}.model`, value.model);
  if (value.effortLevel !== undefined) validateString(problems, `${path}.effortLevel`, value.effortLevel);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.reason !== undefined) validateString(problems, `${path}.reason`, value.reason);
}

function validateModelFallback(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("modelFallback must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "defaultMode", "globalChain", "triggers", "handoff", "returnPolicy"], "modelFallback");
  if (value.enabled !== undefined) validateBoolean(problems, "modelFallback.enabled", value.enabled);
  if (value.defaultMode !== undefined) {
    if (typeof value.defaultMode !== "string" || !FALLBACK_MODES.has(value.defaultMode)) {
      problems.push("modelFallback.defaultMode must be one of: auto, ask_user, never");
    }
  }
  if (value.globalChain !== undefined) {
    if (!Array.isArray(value.globalChain)) {
      problems.push("modelFallback.globalChain must be an array");
    } else {
      value.globalChain.forEach((entry, index) => validateFallbackTarget(problems, `modelFallback.globalChain[${index}]`, entry));
    }
  }
  if (value.triggers !== undefined) {
    if (!isPlainObject(value.triggers)) {
      problems.push("modelFallback.triggers must be a mapping");
    } else {
      pushUnknownKeys(problems, value.triggers, ENGINE_FAILURE_REASONS, "modelFallback.triggers");
      for (const [reason, enabled] of Object.entries(value.triggers)) {
        if (!ENGINE_FAILURE_REASONS.has(reason as EngineFailureReason)) continue;
        validateBoolean(problems, `modelFallback.triggers.${reason}`, enabled);
      }
    }
  }
  if (value.handoff !== undefined) {
    if (!isPlainObject(value.handoff)) {
      problems.push("modelFallback.handoff must be a mapping");
    } else {
      pushUnknownKeys(problems, value.handoff, [
        "createSummary",
        "includeArtifacts",
        "includeLogs",
        "includeOpenQuestions",
        "includeRecentTranscriptTurns",
      ], "modelFallback.handoff");
      if (value.handoff.createSummary !== undefined) validateBoolean(problems, "modelFallback.handoff.createSummary", value.handoff.createSummary);
      if (value.handoff.includeArtifacts !== undefined) validateBoolean(problems, "modelFallback.handoff.includeArtifacts", value.handoff.includeArtifacts);
      if (value.handoff.includeLogs !== undefined) validateBoolean(problems, "modelFallback.handoff.includeLogs", value.handoff.includeLogs);
      if (value.handoff.includeOpenQuestions !== undefined) validateBoolean(problems, "modelFallback.handoff.includeOpenQuestions", value.handoff.includeOpenQuestions);
      if (value.handoff.includeRecentTranscriptTurns !== undefined) {
        validateNumber(problems, "modelFallback.handoff.includeRecentTranscriptTurns", value.handoff.includeRecentTranscriptTurns);
      }
    }
  }
  if (value.returnPolicy !== undefined) {
    if (!isPlainObject(value.returnPolicy)) {
      problems.push("modelFallback.returnPolicy must be a mapping");
    } else {
      pushUnknownKeys(problems, value.returnPolicy, ["whenPrimaryAvailable"], "modelFallback.returnPolicy");
      if (value.returnPolicy.whenPrimaryAvailable !== undefined) {
        if (typeof value.returnPolicy.whenPrimaryAvailable !== "string" || !RETURN_POLICIES.has(value.returnPolicy.whenPrimaryAvailable)) {
          problems.push("modelFallback.returnPolicy.whenPrimaryAvailable must be one of: ask_user, auto, never, stay_on_fallback");
        }
      }
    }
  }
}

function validateSessions(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("sessions must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["maxDurationMinutes", "maxCostUsd", "interruptOnNewMessage", "rateLimitStrategy", "fallbackEngine", "autoResumeOnBoot"], "sessions");
  if (value.maxDurationMinutes !== undefined) validateNumber(problems, "sessions.maxDurationMinutes", value.maxDurationMinutes);
  if (value.maxCostUsd !== undefined) validateNumber(problems, "sessions.maxCostUsd", value.maxCostUsd);
  if (value.interruptOnNewMessage !== undefined) validateBoolean(problems, "sessions.interruptOnNewMessage", value.interruptOnNewMessage);
  if (value.rateLimitStrategy !== undefined) validateString(problems, "sessions.rateLimitStrategy", value.rateLimitStrategy);
  if (value.fallbackEngine !== undefined) validateString(problems, "sessions.fallbackEngine", value.fallbackEngine);
  if (value.autoResumeOnBoot !== undefined) validateBoolean(problems, "sessions.autoResumeOnBoot", value.autoResumeOnBoot);
}

function validateFeatures(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("features must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["multiRoleEmployeeExecution"], "features");
  if (value.multiRoleEmployeeExecution !== undefined) {
    validateBoolean(problems, "features.multiRoleEmployeeExecution", value.multiRoleEmployeeExecution);
  }
}

function validateBoardWorker(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("boardWorker must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "idleMinutes", "timezone", "schedule", "usage"], "boardWorker");
  if (value.enabled !== undefined) validateBoolean(problems, "boardWorker.enabled", value.enabled);
  if (value.idleMinutes !== undefined) validateNumber(problems, "boardWorker.idleMinutes", value.idleMinutes);
  if (value.timezone !== undefined) {
    if (typeof value.timezone !== "string") {
      problems.push(`boardWorker.timezone must be a string (got ${typeof value.timezone})`);
    } else {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value.timezone });
      } catch {
        problems.push(`boardWorker.timezone must be a valid IANA timezone (got ${value.timezone})`);
      }
    }
  }
  if (value.schedule !== undefined) {
    if (!isPlainObject(value.schedule)) {
      problems.push("boardWorker.schedule must be a mapping");
    } else {
      pushUnknownKeys(problems, value.schedule, ["weekday", "weekend"], "boardWorker.schedule");
      for (const key of ["weekday", "weekend"] as const) {
        const window = value.schedule[key];
        if (window === undefined) continue;
        if (!isPlainObject(window)) {
          problems.push(`boardWorker.schedule.${key} must be a mapping`);
          continue;
        }
        pushUnknownKeys(problems, window, ["start", "end"], `boardWorker.schedule.${key}`);
        if (typeof window.start !== "string" || !TIME_OF_DAY_RE.test(window.start)) {
          problems.push(`boardWorker.schedule.${key}.start must be HH:MM`);
        }
        if (typeof window.end !== "string" || !TIME_OF_DAY_RE.test(window.end)) {
          problems.push(`boardWorker.schedule.${key}.end must be HH:MM`);
        }
      }
    }
  }
  if (value.usage !== undefined) {
    if (!isPlainObject(value.usage)) {
      problems.push("boardWorker.usage must be a mapping");
    } else {
      pushUnknownKeys(problems, value.usage, ["minRemainingPercent"], "boardWorker.usage");
      if (value.usage.minRemainingPercent !== undefined) {
        validateNumber(problems, "boardWorker.usage.minRemainingPercent", value.usage.minRemainingPercent);
      }
    }
  }
}

function validateOrchestration(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("orchestration must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, [
    "enabled",
    "configDir",
    "dbPath",
    "leaseDurationMs",
    "reaperIntervalMs",
    "worktreeRoot",
    "maxWorktrees",
    "sameFamilyReviewerFallback",
    "empiricalRouting",
  ], "orchestration");
  if (value.enabled !== undefined) validateBoolean(problems, "orchestration.enabled", value.enabled);
  if (value.configDir !== undefined) validateString(problems, "orchestration.configDir", value.configDir);
  if (value.dbPath !== undefined) validateString(problems, "orchestration.dbPath", value.dbPath);
  if (value.leaseDurationMs !== undefined) validateNumber(problems, "orchestration.leaseDurationMs", value.leaseDurationMs);
  if (value.reaperIntervalMs !== undefined) validateNumber(problems, "orchestration.reaperIntervalMs", value.reaperIntervalMs);
  if (value.worktreeRoot !== undefined) validateString(problems, "orchestration.worktreeRoot", value.worktreeRoot);
  if (value.maxWorktrees !== undefined) validateNumber(problems, "orchestration.maxWorktrees", value.maxWorktrees);
  if (value.sameFamilyReviewerFallback !== undefined) {
    validateBoolean(problems, "orchestration.sameFamilyReviewerFallback", value.sameFamilyReviewerFallback);
  }
  if (value.empiricalRouting !== undefined) validateBoolean(problems, "orchestration.empiricalRouting", value.empiricalRouting);
}

function validateCron(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("cron must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["defaultDelivery", "alertChannel", "alertConnector", "alertThresholdMs"], "cron");
  if (value.defaultDelivery !== undefined) {
    if (!isPlainObject(value.defaultDelivery)) {
      problems.push("cron.defaultDelivery must be a mapping");
    } else {
      pushUnknownKeys(problems, value.defaultDelivery, ["connector", "channel", "thread"], "cron.defaultDelivery");
      if (value.defaultDelivery.connector !== undefined) validateString(problems, "cron.defaultDelivery.connector", value.defaultDelivery.connector);
      if (value.defaultDelivery.channel !== undefined) validateString(problems, "cron.defaultDelivery.channel", value.defaultDelivery.channel);
      if (value.defaultDelivery.thread !== undefined) validateString(problems, "cron.defaultDelivery.thread", value.defaultDelivery.thread);
    }
  }
  if (value.alertChannel !== undefined) validateString(problems, "cron.alertChannel", value.alertChannel);
  if (value.alertConnector !== undefined) validateString(problems, "cron.alertConnector", value.alertConnector);
  if (value.alertThresholdMs !== undefined) validateNumber(problems, "cron.alertThresholdMs", value.alertThresholdMs);
}

function validateNotifications(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("notifications must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["connector", "channel"], "notifications");
  if (value.connector !== undefined) validateString(problems, "notifications.connector", value.connector);
  if (value.channel !== undefined) validateString(problems, "notifications.channel", value.channel);
}

function collectConfiguredConnectorIds(config: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  if (!isPlainObject(config.connectors)) return ids;

  const connectors = config.connectors;
  if (isPlainObject(connectors.slack) && typeof connectors.slack.appToken === "string" && typeof connectors.slack.botToken === "string") {
    ids.add("slack");
  }
  if (isPlainObject(connectors.whatsapp)) {
    ids.add("whatsapp");
  }
  if (!Array.isArray(connectors.instances)) return ids;

  for (const instance of connectors.instances) {
    if (!isPlainObject(instance)) continue;
    if (typeof instance.id !== "string" || !instance.id.trim()) continue;
    if (instance.type !== "slack" && instance.type !== "whatsapp") continue;
    ids.add(instance.id);
  }
  return ids;
}

function validateNotificationConnectorReference(problems: string[], config: Record<string, unknown>): void {
  if (!isPlainObject(config.notifications)) return;

  const channel = config.notifications.channel;
  if (channel === undefined || typeof channel !== "string" || !channel.trim()) return;

  const connectorName = config.notifications.connector;
  const effectiveConnector = typeof connectorName === "string" && connectorName.trim() ? connectorName : "slack";
  const supportedConnectors = collectConfiguredConnectorIds(config);
  if (supportedConnectors.has(effectiveConnector)) return;

  const available = [...supportedConnectors].sort();
  const detail = available.length > 0
    ? `available connectors: ${available.join(", ")}`
    : "no supported connectors are configured";
  problems.push(`notifications.connector must reference a configured connector; got "${effectiveConnector}" (${detail})`);
}

function validatePortal(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("portal must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["portalName", "operatorName", "language", "onboarded", "setupComplete"], "portal");
  if (value.portalName !== undefined) validateString(problems, "portal.portalName", value.portalName);
  if (value.operatorName !== undefined) validateString(problems, "portal.operatorName", value.operatorName);
  if (value.language !== undefined) validateString(problems, "portal.language", value.language);
  if (value.onboarded !== undefined) validateBoolean(problems, "portal.onboarded", value.onboarded);
  if (value.setupComplete !== undefined) validateBoolean(problems, "portal.setupComplete", value.setupComplete);
}

function validateContext(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("context must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["maxChars"], "context");
  if (value.maxChars !== undefined) validateNumber(problems, "context.maxChars", value.maxChars);
}

function validateStt(problems: string[], value: unknown, path = "stt"): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "model", "language", "languages"], path);
  if (value.enabled !== undefined) validateBoolean(problems, `${path}.enabled`, value.enabled);
  if (value.model !== undefined) validateString(problems, `${path}.model`, value.model);
  if (value.language !== undefined) validateString(problems, `${path}.language`, value.language);
  if (value.languages !== undefined) validateStringArray(problems, `${path}.languages`, value.languages);
}

function validateTalk(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("talk must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "engine", "orchestratorModel", "kokoro"], "talk");
  if (value.enabled !== undefined) validateBoolean(problems, "talk.enabled", value.enabled);
  if (value.engine !== undefined) validateString(problems, "talk.engine", value.engine);
  if (value.orchestratorModel !== undefined) validateString(problems, "talk.orchestratorModel", value.orchestratorModel);
  if (value.kokoro !== undefined) {
    if (!isPlainObject(value.kokoro)) {
      problems.push("talk.kokoro must be a mapping");
    } else {
      pushUnknownKeys(problems, value.kokoro, ["voice", "modelDir", "sidecarPort"], "talk.kokoro");
      if (value.kokoro.voice !== undefined) validateString(problems, "talk.kokoro.voice", value.kokoro.voice);
      if (value.kokoro.modelDir !== undefined) validateString(problems, "talk.kokoro.modelDir", value.kokoro.modelDir);
      if (value.kokoro.sidecarPort !== undefined) validateNumber(problems, "talk.kokoro.sidecarPort", value.kokoro.sidecarPort);
    }
  }
}

function validatePolicy(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("policy must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["dir"], "policy");
  if (value.dir !== undefined) validateString(problems, "policy.dir", value.dir);
}

function validateRemotes(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("remotes must be a mapping");
    return;
  }
  for (const [name, remote] of Object.entries(value)) {
    if (!isPlainObject(remote)) {
      problems.push(`remotes.${name} must be a mapping`);
      continue;
    }
    pushUnknownKeys(problems, remote, ["url", "label", "token"], `remotes.${name}`);
    if (remote.url === undefined) {
      problems.push(`remotes.${name}.url is required`);
    } else {
      validateString(problems, `remotes.${name}.url`, remote.url);
    }
    if (remote.label !== undefined) validateString(problems, `remotes.${name}.label`, remote.label);
    if (remote.token !== undefined) validateString(problems, `remotes.${name}.token`, remote.token);
  }
}

export function validateConfigShape(config: unknown): string[] {
  if (config === null || config === undefined) {
    return ["file is empty or parsed to null — expected a YAML mapping"];
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return [`expected a YAML mapping, got ${Array.isArray(config) ? "an array" : typeof config}`];
  }

  const problems: string[] = [];
  const c = config as Record<string, unknown>;

  pushUnknownKeys(problems, c, [
    "cuttlefish",
    "workspaces",
    "gateway",
    "engines",
    "models",
    "connectors",
    "email",
    "logging",
    "mcp",
    "modelFallback",
    "orchestration",
    "sessions",
    "features",
    "boardWorker",
    "cron",
    "notifications",
    "portal",
    "context",
    "stt",
    "talk",
    "knowledge",
    "remotes",
    "policy",
  ], "config");

  if (c.cuttlefish !== undefined) {
    if (!isPlainObject(c.cuttlefish)) {
      problems.push("cuttlefish must be a mapping");
    } else {
      pushUnknownKeys(problems, c.cuttlefish, ["version"], "cuttlefish");
      if (c.cuttlefish.version !== undefined) validateString(problems, "cuttlefish.version", c.cuttlefish.version);
    }
  }
  if (c.workspaces !== undefined) validateWorkspaces(problems, c.workspaces);
  if (c.gateway !== undefined) validateGateway(problems, c.gateway);
  validateEngines(problems, c.engines);
  if (c.models !== undefined) validateModels(problems, c.models);
  if (c.connectors !== undefined) validateConnectors(problems, c.connectors);
  if (c.email !== undefined) validateEmail(problems, c.email);
  if (c.logging !== undefined) validateLogging(problems, c.logging);
  if (c.mcp !== undefined) validateMcp(problems, c.mcp);
  if (c.modelFallback !== undefined) validateModelFallback(problems, c.modelFallback);
  if (c.orchestration !== undefined) validateOrchestration(problems, c.orchestration);
  if (c.sessions !== undefined) validateSessions(problems, c.sessions);
  if (c.features !== undefined) validateFeatures(problems, c.features);
  if (c.boardWorker !== undefined) validateBoardWorker(problems, c.boardWorker);
  if (c.cron !== undefined) validateCron(problems, c.cron);
  if (c.notifications !== undefined) validateNotifications(problems, c.notifications);
  if (c.portal !== undefined) validatePortal(problems, c.portal);
  if (c.context !== undefined) validateContext(problems, c.context);
  if (c.stt !== undefined) validateStt(problems, c.stt);
  if (c.talk !== undefined) validateTalk(problems, c.talk);
  if (c.knowledge !== undefined) validateKnowledge(problems, c.knowledge, { pushUnknownKeys, validateString, validateNumber });
  if (c.remotes !== undefined) validateRemotes(problems, c.remotes);
  if (c.policy !== undefined) validatePolicy(problems, c.policy);
  validateNotificationConnectorReference(problems, c);

  return problems;
}
