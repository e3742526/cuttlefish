import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const webRoot = path.join(repoRoot, "packages", "cuttlefish", "dist", "web")
const port = Number(process.env.CUTTLEFISH_E2E_PORT || 7779)
const scrollSession = {
  id: "e2e-scroll-session",
  engine: "claude",
  engineSessionId: null,
  source: "web",
  sourceRef: "e2e-scroll-session",
  sessionKey: "e2e-scroll-session",
  employee: null,
  model: "opus",
  title: "E2E scroll fixture",
  status: "idle",
  totalCost: 0,
  totalTurns: 0,
  lastContextTokens: null,
  createdAt: "2026-07-16T00:00:00.000Z",
  lastActivity: "2026-07-16T00:00:00.000Z",
  lastError: null,
}
const scrollMessages = Array.from({ length: 30 }, (_, index) => ({
  id: `e2e-message-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `Scroll fixture message ${index + 1}: ${"deterministic content ".repeat(8)}`,
  timestamp: Date.parse("2026-07-16T00:00:00.000Z") + index * 1000,
}))
const projectSummary = {
  rootSessionId: scrollSession.id,
  title: "E2E collaboration project",
  lastActivity: scrollSession.lastActivity,
  jobState: "idle",
  sessionCount: 1,
  participantIds: ["builder"],
  integrity: "valid",
  runningCount: 0,
  needsAttentionCount: 0,
}
const collaborationItems = [{
  id: "e2e-collaboration-message",
  lane: "team",
  projectRootSessionId: scrollSession.id,
  sessionId: scrollSession.id,
  kind: "message",
  author: { kind: "agent", id: "builder", displayName: "Builder" },
  recipients: ["operator"],
  content: "Collaboration feed is ready",
  timestamp: Date.parse("2026-07-16T01:00:00.000Z"),
  attribution: "recorded",
  projectTitle: projectSummary.title,
}]
const managementItems = []

const emptyTelemetryBucket = {
  count: 0,
  dispositions: {},
  totalCost: 0,
  avgCost: null,
  totalLatencyMs: 0,
  avgLatencyMs: null,
  totalTokens: 0,
  avgTokens: null,
  filesChanged: 0,
  testsAdded: 0,
  testsPassed: 0,
  reviewBlockers: 0,
  humanEdits: 0,
  regressions: 0,
  score: 0,
}

const jsonFixtures = new Map([
  ["/api/auth/state", {
    authRequired: false,
    authenticated: true,
    canBootstrapLocal: false,
    networkExposed: false,
  }],
  ["/api/onboarding", {
    needed: false,
    onboarded: true,
    sessionsCount: 0,
    hasEmployees: false,
    portalName: "Cuttlefish",
    operatorName: "E2E Operator",
  }],
  ["/api/sessions", { sessions: [scrollSession], counts: { direct: 1 }, perGroup: 50 }],
  ["/api/approvals", []],
  ["/api/checkpoints", []],
  ["/api/cron", []],
  ["/api/command-center", {
    generatedAt: "2026-07-16T00:00:00.000Z",
    summary: { agents: 0, agentsRunning: 0, cronJobs: 0, ticketsOpen: 0, ticketsTotal: 0 },
    ticketCounts: {},
    managers: [],
    availableAgents: [],
  }],
  ["/api/engine-limits", {
    generatedAt: "2026-07-16T00:00:00.000Z",
    default: "claude",
    engines: {},
  }],
  ["/api/org", {
    departments: [],
    employees: [{ name: "builder", displayName: "Builder", rank: "individual", lifecycle: "active", engine: "claude" }],
    hierarchy: { root: null, sorted: [], warnings: [] },
  }],
  ["/api/workspace-profiles", { profiles: [] }],
  ["/api/engines", {
    default: "claude",
    engines: {
      claude: {
        name: "claude",
        available: false,
        defaultModel: "opus",
        effortMechanism: "claude-flag",
        models: [{ id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
      },
    },
  }],
  ["/api/skills", []],
  ["/api/orchestration/status", {
    enabled: true,
    runtimeBound: true,
    degraded: false,
    queuePaused: false,
    pausedAt: null,
    pauseReason: null,
    disabledReason: null,
    degradedReason: null,
    counts: { workers: 1, runningLeases: 1, queueItems: 0, allocations: 0, continuations: 0, activeWork: true },
  }],
  ["/api/orchestration/workers", {
    workers: [{
      id: "e2e-worker",
      provider: "openai",
      family: "openai",
      tier: "frontier",
      capabilities: ["repo_edit", "review"],
      tools: ["filesystem"],
      maxConcurrentTasks: 1,
      costClass: "medium",
      workspacePolicy: "isolated_worktree",
    }],
  }],
  ["/api/orchestration/leases", {
    leases: [{
      leaseId: "e2e-lease",
      taskId: "e2e-task",
      coordinatorId: "e2e-coordinator",
      workerId: "e2e-worker",
      role: "implementer",
      state: "running",
      leaseExpiresAt: "2026-07-20T12:00:00.000Z",
    }],
  }],
  ["/api/orchestration/queue", { queue: [], pauses: [] }],
  ["/api/orchestration/holds", {
    holds: [{
      holdId: "e2e-hold",
      managerName: "E2E manager",
      state: "active",
      roles: [],
      workerIds: ["e2e-worker"],
      taskId: null,
      coordinatorId: null,
      reason: "Reserve review capacity",
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
      expiresAt: "2026-07-20T13:00:00.000Z",
    }],
  }],
  ["/api/orchestration/allocations", { allocations: [] }],
  ["/api/orchestration/continuations", { continuations: [] }],
  ["/api/orchestration/telemetry/summary", {
    maxBytes: 1000,
    maxRecords: 100,
    summary: {
      totals: emptyTelemetryBucket,
      byProvider: {},
      byFamily: {},
      byRole: {},
      byWorker: {},
      skippedLines: 0,
    },
  }],
  ["/api/orchestration/worktrees", { worktrees: [] }],
  ["/api/orchestration/dual-lane", { manifests: [] }],
])

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}) }
      catch (error) { reject(error) }
    })
  })
}

function resolveStaticFile(pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const candidate = path.resolve(webRoot, requested)
  if (!candidate.startsWith(`${webRoot}${path.sep}`) && candidate !== webRoot) return null
  try {
    if (fs.statSync(candidate).isFile()) return candidate
  } catch {
    // SPA routes fall through to index.html.
  }
  return path.join(webRoot, "index.html")
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`)
  if (url.pathname === "/api/readyz") return sendJson(res, { status: "ready" })
  if (url.pathname === `/api/sessions/${scrollSession.id}`) {
    return sendJson(res, { ...scrollSession, messages: scrollMessages })
  }
  if (url.pathname === `/api/sessions/${scrollSession.id}/queue`) return sendJson(res, [])
  if (url.pathname === "/api/projects") return sendJson(res, { projects: [projectSummary], nextCursor: null })
  if (url.pathname === `/api/projects/${scrollSession.id}/tree`) {
    return sendJson(res, { project: projectSummary, tree: [{ session: { ...scrollSession, employee: "builder", jobState: "idle", lastAgentMessageAt: null }, depth: 0, children: [] }] })
  }
  if (url.pathname === `/api/projects/${scrollSession.id}/feed`) return sendJson(res, { items: collaborationItems, nextCursor: null })
  if (req.method === "POST" && url.pathname === `/api/projects/${scrollSession.id}/messages`) {
    const body = await readJson(req)
    collaborationItems.push({
      id: `e2e-team-${collaborationItems.length}`, lane: "team", projectRootSessionId: scrollSession.id,
      sessionId: scrollSession.id, kind: "message", author: { kind: "operator", displayName: "You" },
      recipients: body.recipientIds ?? ["builder"], content: body.message, timestamp: Date.now(), attribution: "recorded",
      projectTitle: projectSummary.title, deliveryReceipts: [{ recipientId: "builder", sessionId: scrollSession.id, state: "queued" }],
    })
    return sendJson(res, { status: "queued", receipts: [{ recipientId: "builder", sessionId: scrollSession.id, state: "queued" }] }, 202)
  }
  if (url.pathname === "/api/management/recipients") return sendJson(res, {
    recipients: [{ id: "program-manager", displayName: "Program Manager", rank: "manager", active: true }, { id: "cuttlefish", displayName: "Cuttlefish", rank: "executive", active: true }],
    defaultRecipientId: "program-manager", defaultReason: "program_manager",
  })
  if (url.pathname === "/api/management/feed") return sendJson(res, { items: managementItems, nextCursor: null })
  if (req.method === "POST" && url.pathname === "/api/management/messages") {
    const body = await readJson(req)
    const recipients = body.recipientIds ?? ["program-manager"]
    const receipts = recipients.map((recipientId) => ({ recipientId, sessionId: `e2e-${recipientId}`, state: "queued" }))
    managementItems.push({
      id: `e2e-management-${managementItems.length}`, lane: "management", kind: "message",
      author: { kind: "operator", displayName: "You" }, recipients, content: body.message,
      timestamp: Date.now(), attribution: "recorded", deliveryReceipts: receipts,
    })
    return sendJson(res, { status: "queued", receipts, ...(body.operatorDelegationScopes ? { authorityGrant: { recipientId: recipients[0], scopes: body.operatorDelegationScopes, oneTurn: true, modelEligible: true } } : {}) }, 202)
  }
  if (jsonFixtures.has(url.pathname)) return sendJson(res, jsonFixtures.get(url.pathname))
  if (url.pathname.startsWith("/api/")) {
    return sendJson(res, { error: `No E2E fixture for ${url.pathname}` }, 501)
  }

  const file = resolveStaticFile(url.pathname)
  if (!file) {
    res.writeHead(404)
    res.end("Not found")
    return
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(500)
      res.end("Built dashboard unavailable; run pnpm build")
      return
    }
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(file)] || "application/octet-stream",
    })
    res.end(content)
  })
})

server.on("upgrade", (_req, socket) => socket.destroy())
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Cuttlefish E2E server listening on http://127.0.0.1:${port}\n`)
})

function shutdown() {
  server.closeAllConnections?.()
  server.close(() => process.exit(0))
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
