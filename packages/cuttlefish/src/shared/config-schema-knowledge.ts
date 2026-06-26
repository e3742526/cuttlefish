function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateKnowledge(
  problems: string[],
  value: unknown,
  helpers: {
    pushUnknownKeys: (problems: string[], value: Record<string, unknown>, allowed: Iterable<string>, label: string) => void;
    validateString: (problems: string[], path: string, value: unknown) => void;
    validateNumber: (problems: string[], path: string, value: unknown) => void;
  },
): void {
  if (!isPlainObject(value)) {
    problems.push("knowledge must be a mapping");
    return;
  }
  helpers.pushUnknownKeys(problems, value, ["sink", "readProvider"], "knowledge");
  if (value.sink !== undefined) {
    if (!isPlainObject(value.sink)) {
      problems.push("knowledge.sink must be a mapping");
    } else {
      helpers.pushUnknownKeys(problems, value.sink, ["type", "jsonl", "webhook"], "knowledge.sink");
      if (value.sink.type !== undefined) {
        if (value.sink.type !== "noop" && value.sink.type !== "jsonl" && value.sink.type !== "webhook") {
          problems.push("knowledge.sink.type must be one of noop, jsonl, or webhook");
        }
      }
      if (value.sink.jsonl !== undefined) {
        if (!isPlainObject(value.sink.jsonl)) {
          problems.push("knowledge.sink.jsonl must be a mapping");
        } else {
          helpers.pushUnknownKeys(problems, value.sink.jsonl, ["path"], "knowledge.sink.jsonl");
          if (value.sink.jsonl.path !== undefined) helpers.validateString(problems, "knowledge.sink.jsonl.path", value.sink.jsonl.path);
        }
      }
      if (value.sink.webhook !== undefined) {
        if (!isPlainObject(value.sink.webhook)) {
          problems.push("knowledge.sink.webhook must be a mapping");
        } else {
          helpers.pushUnknownKeys(problems, value.sink.webhook, ["url", "token", "batchSize", "timeoutMs", "retry"], "knowledge.sink.webhook");
          if (value.sink.webhook.url !== undefined) helpers.validateString(problems, "knowledge.sink.webhook.url", value.sink.webhook.url);
          if (value.sink.webhook.token !== undefined) helpers.validateString(problems, "knowledge.sink.webhook.token", value.sink.webhook.token);
          if (value.sink.webhook.batchSize !== undefined) helpers.validateNumber(problems, "knowledge.sink.webhook.batchSize", value.sink.webhook.batchSize);
          if (value.sink.webhook.timeoutMs !== undefined) helpers.validateNumber(problems, "knowledge.sink.webhook.timeoutMs", value.sink.webhook.timeoutMs);
          if (value.sink.webhook.retry !== undefined) {
            if (!isPlainObject(value.sink.webhook.retry)) {
              problems.push("knowledge.sink.webhook.retry must be a mapping");
            } else {
              helpers.pushUnknownKeys(problems, value.sink.webhook.retry, ["baseDelayMs", "maxDelayMs"], "knowledge.sink.webhook.retry");
              if (value.sink.webhook.retry.baseDelayMs !== undefined) {
                helpers.validateNumber(problems, "knowledge.sink.webhook.retry.baseDelayMs", value.sink.webhook.retry.baseDelayMs);
              }
              if (value.sink.webhook.retry.maxDelayMs !== undefined) {
                helpers.validateNumber(problems, "knowledge.sink.webhook.retry.maxDelayMs", value.sink.webhook.retry.maxDelayMs);
              }
            }
          }
        }
      }
      if (value.sink.type === "webhook" && (!isPlainObject(value.sink.webhook) || value.sink.webhook.url === undefined)) {
        problems.push("knowledge.sink.webhook.url is required when knowledge.sink.type=webhook");
      }
    }
  }

  if (value.readProvider !== undefined) {
    if (!isPlainObject(value.readProvider)) {
      problems.push("knowledge.readProvider must be a mapping");
    } else {
      helpers.pushUnknownKeys(problems, value.readProvider, ["type", "webhook"], "knowledge.readProvider");
      if (value.readProvider.type !== undefined) {
        if (value.readProvider.type !== "none" && value.readProvider.type !== "webhook") {
          problems.push("knowledge.readProvider.type must be one of none or webhook");
        }
      }
      if (value.readProvider.webhook !== undefined) {
        if (!isPlainObject(value.readProvider.webhook)) {
          problems.push("knowledge.readProvider.webhook must be a mapping");
        } else {
          helpers.pushUnknownKeys(problems, value.readProvider.webhook, ["url", "token", "timeoutMs"], "knowledge.readProvider.webhook");
          if (value.readProvider.webhook.url !== undefined) helpers.validateString(problems, "knowledge.readProvider.webhook.url", value.readProvider.webhook.url);
          if (value.readProvider.webhook.token !== undefined) helpers.validateString(problems, "knowledge.readProvider.webhook.token", value.readProvider.webhook.token);
          if (value.readProvider.webhook.timeoutMs !== undefined) {
            helpers.validateNumber(problems, "knowledge.readProvider.webhook.timeoutMs", value.readProvider.webhook.timeoutMs);
          }
        }
      }
      if (value.readProvider.type === "webhook" && (!isPlainObject(value.readProvider.webhook) || value.readProvider.webhook.url === undefined)) {
        problems.push("knowledge.readProvider.webhook.url is required when knowledge.readProvider.type=webhook");
      }
    }
  }
}
