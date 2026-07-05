#!/usr/bin/env node

const DEFAULT_PROMPT =
  "Review two independent areas and coordinate the right specialists if useful: " +
  "1) assess whether security-token handling has obvious risks, and " +
  "2) review whether the HR/org roster looks consistent. Take the approach you think is best.";

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.base ?? process.env.CUTTLEFISH_BASE_URL ?? "http://127.0.0.1:8888").replace(/\/+$/, "");
const employee = String(args.employee ?? process.env.CUTTLEFISH_DELEGATION_EMPLOYEE ?? "parliamentarian");
const prompt = String(args.prompt ?? process.env.CUTTLEFISH_DELEGATION_PROMPT ?? DEFAULT_PROMPT);
const timeoutMs = Number(args.timeoutMs ?? process.env.CUTTLEFISH_DELEGATION_TIMEOUT_MS ?? 180_000);
const pollMs = Number(args.pollMs ?? process.env.CUTTLEFISH_DELEGATION_POLL_MS ?? 2_000);
const authToken = args.token ?? process.env.CUTTLEFISH_API_TOKEN;

const headers = {
  "Content-Type": "application/json",
  ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
};

const startedAt = Date.now();
const session = await request("POST", "/api/sessions", { employee, prompt });
const sessionId = session.id;
if (!sessionId) throw new Error(`Session create response did not include id: ${JSON.stringify(session)}`);

let latest = session;
let children = [];
while (Date.now() - startedAt < timeoutMs) {
  await sleep(pollMs);
  latest = await request("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
  children = await request("GET", `/api/sessions/${encodeURIComponent(sessionId)}/children`);
  if (["idle", "error", "waiting"].includes(String(latest.status))) break;
}

const evidence = {
  baseUrl,
  employee,
  sessionId,
  status: latest.status,
  childSessionCount: Array.isArray(children) ? children.length : 0,
  childSessions: Array.isArray(children)
    ? children.map((child) => ({
        id: child.id,
        employee: child.employee ?? null,
        status: child.status,
        title: child.title ?? null,
      }))
    : [],
  elapsedMs: Date.now() - startedAt,
  prompt,
};

console.log(JSON.stringify(evidence, null, 2));

async function request(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
