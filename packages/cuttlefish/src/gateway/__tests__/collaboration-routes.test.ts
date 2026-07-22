import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

withStaticTempCuttlefishHome("cuttlefish-collaboration-routes-");

const hoisted = vi.hoisted(() => ({
  dispatchTurn: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    statusCode: 200,
    body: { status: "queued", sessionId },
    insertedMessageId: `message-${sessionId}`,
  })),
}));

vi.mock("../continue-session.js", () => ({ continueSession: hoisted.dispatchTurn }));
vi.mock("../org.js", () => ({
  scanOrg: () => new Map([
    ["lead", { name: "lead", displayName: "Lead", department: "engineering", rank: "manager", engine: "codex", model: "gpt-5.6-sol", persona: "lead", reportsTo: "cuttlefish" }],
    ["program-manager", { name: "program-manager", displayName: "Program Manager", department: "program", rank: "manager", engine: "codex", model: "gpt-5.6-sol", persona: "pm", reportsTo: "cuttlefish" }],
    ["dev", { name: "dev", displayName: "Developer", department: "engineering", rank: "employee", engine: "codex", model: "gpt-5.6-sol", persona: "dev", reportsTo: "lead" }],
  ]),
}));

type Registry = typeof import("../../sessions/registry.js");
type Routes = typeof import("../api/routes/collaboration.js");
let registry: Registry;
let routes: Routes;

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  routes = await import("../api/routes/collaboration.js");
  registry.initDb();
});

beforeEach(() => {
  hoisted.dispatchTurn.mockClear();
});

function responseCapture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(value: number) { status = value; return this; },
    end(value?: Buffer | string) { if (value) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() { return JSON.parse(Buffer.concat(chunks).toString("utf8")); },
  };
}

function request(method: string, path: string, body?: unknown, principal?: unknown) {
  const req = body === undefined ? new Readable({ read() { this.push(null); } }) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url: path,
    headers: { host: "localhost", "content-type": "application/json" },
    ...(principal ? { cuttlefishPrincipal: principal } : {}),
  });
  return req as never;
}

function context() {
  return {
    getConfig: () => ({
      gateway: {},
      engines: { default: "codex", codex: { model: "gpt-5.6-sol" } },
      portal: { portalName: "Cuttlefish" },
    }),
    sessionManager: {
      getEngine: () => ({ name: "codex" }),
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
        clearQueue: vi.fn(),
      }),
    },
    backgroundActivity: new Map(),
    emit: vi.fn(),
  } as never;
}

async function call(method: string, path: string, body?: unknown, principal?: unknown) {
  const capture = responseCapture();
  const req = request(method, path, body, principal);
  const handled = await routes.handleCollaborationRoutes(
    method,
    new URL(path, "http://localhost").pathname,
    req,
    new URL(path, "http://localhost"),
    capture.res,
    context(),
  );
  return { handled, status: capture.status, body: capture.body };
}

function createProject(prefix: string) {
  const root = registry.createSession({ engine: "codex", source: "web", sourceRef: `${prefix}:root`, employee: "lead", prompt: `${prefix} root`, title: `${prefix} project` });
  const child = registry.createSession({ engine: "codex", source: "web", sourceRef: `${prefix}:child`, employee: "dev", parentSessionId: root.id, prompt: "child" });
  registry.insertMessage(root.id, "user", "operator root message");
  registry.insertMessage(child.id, "assistant", "child result");
  return { root, child };
}

describe("collaboration API routes", () => {
  it("lists projects, returns recursive trees, and projects attributed feeds", async () => {
    const project = createProject("read");
    const listing = await call("GET", "/api/projects?limit=200");
    expect(listing.status).toBe(200);
    expect(listing.body.projects).toContainEqual(expect.objectContaining({ rootSessionId: project.root.id, sessionCount: 2 }));
    const tree = await call("GET", `/api/projects/${project.root.id}/tree`);
    expect(tree.body.tree[0].children[0].session.id).toBe(project.child.id);
    const feed = await call("GET", `/api/projects/${project.root.id}/feed`);
    expect(feed.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "operator root message", author: expect.objectContaining({ kind: "operator" }) }),
      expect.objectContaining({ content: "child result", author: expect.objectContaining({ id: "dev" }) }),
    ]));
  });

  it("limits a scoped principal to its own project and forbids collection writes", async () => {
    const own = createProject("scoped-own");
    const other = createProject("scoped-other");
    const principal = { kind: "session", sessionId: own.child.id };
    const listing = await call("GET", "/api/projects?limit=200", undefined, principal);
    expect(listing.body.projects).toEqual([expect.objectContaining({ rootSessionId: own.root.id })]);
    expect((await call("GET", `/api/projects/${other.root.id}/tree`, undefined, principal)).status).toBe(404);
    expect((await call("GET", `/api/projects/${other.root.id}/feed`, undefined, principal)).status).toBe(404);
    expect((await call("GET", "/api/management/feed", undefined, principal)).status).toBe(403);
    const send = await call("POST", `/api/projects/${own.root.id}/messages`, { message: "x", recipientIds: ["dev"] }, principal);
    expect(send).toMatchObject({ status: 403, body: { code: "operator_only" } });
  });

  it("routes a structured Team recipient and records one deduplicating event", async () => {
    const project = createProject("team-send");
    const result = await call("POST", `/api/projects/${project.root.id}/messages`, { message: "continue", recipientIds: ["dev"] });
    expect(result).toMatchObject({ status: 202, body: { status: "queued" } });
    expect(result.body.receipts).toEqual([expect.objectContaining({ recipientId: "dev", sessionId: project.child.id, state: "queued" })]);
    expect(registry.listCommunicationEvents({ lane: "team", projectRootSessionId: project.root.id })).toEqual([
      expect.objectContaining({ recipients: ["dev"], referencedMessageIds: [`message-${project.child.id}`] }),
    ]);
  });

  it("resolves the project lead, confirms management all, and restricts authority targets", async () => {
    const project = createProject("management");
    const recipients = await call("GET", `/api/management/recipients?projectRootSessionId=${project.root.id}`);
    expect(recipients.body).toMatchObject({ defaultRecipientId: "lead", defaultReason: "project_lead" });
    const unconfirmed = await call("POST", "/api/management/messages", { message: "broadcast", recipientMode: "all" });
    expect(unconfirmed.status).toBe(400);
    const forbiddenGrant = await call("POST", "/api/management/messages", {
      message: "approve",
      recipientIds: ["lead"],
      operatorDelegationScopes: ["approve"],
    });
    expect(forbiddenGrant).toMatchObject({ status: 403, body: { code: "operator_delegation_target_forbidden" } });
    const eligible = await call("POST", "/api/management/messages", {
      message: "approve this turn",
      recipientIds: ["cuttlefish"],
      projectRootSessionId: project.root.id,
      operatorDelegationScopes: ["approve"],
    });
    expect(eligible).toMatchObject({
      status: 202,
      body: { authorityGrant: { recipientId: "cuttlefish", scopes: ["approve"], oneTurn: true } },
    });
    const sessionId = eligible.body.receipts[0].sessionId;
    expect(registry.getSession(sessionId)?.transportMeta).toMatchObject({ managementProjectRootSessionId: project.root.id });
  });

  it("requires exact deletion confirmation and atomically removes a terminal tree", async () => {
    const project = createProject("delete-route");
    const mismatch = await call("DELETE", `/api/projects/${project.root.id}`, {
      expectedTitle: project.root.title,
      expectedSessionCount: 2,
      confirmation: "wrong",
    });
    expect(mismatch.status).toBe(400);
    const deleted = await call("DELETE", `/api/projects/${project.root.id}`, {
      expectedTitle: project.root.title,
      expectedSessionCount: 2,
      confirmation: project.root.title,
    });
    expect(deleted).toMatchObject({ status: 200, body: { status: "deleted", count: 2 } });
    expect(registry.getSession(project.root.id)).toBeUndefined();
    expect(registry.getSession(project.child.id)).toBeUndefined();
  });
});
