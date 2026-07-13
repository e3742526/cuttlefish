import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { SessionQueue } from "../../sessions/queue.js";
import type { CuttlefishConfig, Engine } from "../../shared/types.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-manager-delegation-");

function writeEmployee(department: string, name: string, lines: string[]): void {
  const dir = path.join(home, "org", department);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), `${lines.join("\n")}\n`);
}

function fakeEngine(name: string, run: Engine["run"]): Engine {
  return { name, run };
}

describe("manager delegation enforcement", () => {
  beforeEach(async () => {
    fs.rmSync(path.join(home, "org"), { recursive: true, force: true });
    fs.rmSync(path.join(home, "sessions.db"), { force: true });
    writeEmployee("compliance", "parliamentarian", [
      "name: parliamentarian",
      "displayName: Parliamentarian",
      "department: compliance",
      "rank: manager",
      "engine: claude",
      "model: opus",
      "persona: Coordinate compliance work and synthesize specialist reports.",
    ]);
    writeEmployee("compliance", "senior-security-officer", [
      "name: senior-security-officer",
      "displayName: Senior Security Officer",
      "department: compliance",
      "rank: senior",
      "engine: codex",
      "model: gpt-5.5",
      "reportsTo: parliamentarian",
      "persona: Investigate authentication, bearer tokens, secrets, vulnerabilities, and security risk.",
    ]);
    const reg = await import("../../sessions/registry.js");
    reg.initDb();
  });

  it("spawns the matched specialist before the manager model can work inline", async () => {
    const reg = await import("../../sessions/registry.js");
    const { runWebSession } = await import("../run-web-session.js");

    const managerRun = vi.fn<Engine["run"]>(async () => ({ result: "manager should not run inline", sessionId: "manager-engine-session" }));
    const specialistRun = vi.fn<Engine["run"]>(async () => ({ result: "security result", sessionId: "specialist-engine-session", durationMs: 1 }));
    const engines = new Map<string, Engine>([
      ["claude", fakeEngine("claude", managerRun)],
      ["codex", fakeEngine("codex", specialistRun)],
    ]);
    const queue = new SessionQueue();
    const config = {
      gateway: { host: "127.0.0.1", port: 8888 },
      // bin: "node" — runWebSession gates on real binary availability (PATH
      // lookup) before dispatch; the engines' run() functions are mocked, so
      // point both at a binary that exists in every test environment.
      engines: { default: "claude", claude: { bin: "node", model: "opus" }, codex: { bin: "node", model: "gpt-5.5" } },
      portal: { portalName: "Cuttlefish" },
    } as unknown as CuttlefishConfig;
    const events: Array<{ event: string; payload: unknown }> = [];
    const context = {
      getConfig: () => config,
      connectors: new Map(),
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
      sessionManager: {
        getEngine: (name: string) => engines.get(name),
        getEngines: () => engines,
        getQueue: () => queue,
      },
      startTime: Date.now(),
    } as any;

    const managerOnlyMarker = "MANAGER_ONLY_DELEGATION_SENTINEL";
    const managerOnlyResource = "MANAGER_ONLY_RESOURCE_SENTINEL";
    const prompt = `Review the bearer token security exposure and summarize the compliance impact. ${managerOnlyMarker}`;
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:test-parent",
      connector: "web",
      sessionKey: "web:test-parent",
      employee: "parliamentarian",
      model: "opus",
      prompt,
      portalName: "Cuttlefish",
    });
    reg.insertMessage(parent.id, "user", prompt);

    await runWebSession(
      parent,
      prompt,
      engines.get("claude")!,
      config,
      context,
      undefined,
      managerOnlyResource,
    );

    expect(managerRun).not.toHaveBeenCalled();
    const children = reg.listChildSessions(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      employee: "senior-security-officer",
      parentSessionId: parent.id,
      engine: "codex",
    });
    const childPrompt = reg.getMessages(children[0].id).find((message) => message.role === "user")?.content ?? "";
    expect(childPrompt).not.toContain(managerOnlyMarker);
    expect(childPrompt).not.toContain("Original task:");
    expect(children[0].promptExcerpt).not.toContain(managerOnlyMarker);
    expect((reg.getSession(parent.id)?.transportMeta as any)?.managerDelegationEnforcement).toMatchObject({
      childSessionIds: [children[0].id],
      completedChildSessionIds: [],
      synthesisDispatched: false,
    });
    await waitFor(() => specialistRun.mock.calls.length === 1);
    expect(specialistRun).toHaveBeenCalledTimes(1);
    expect(specialistRun.mock.calls[0][0].prompt).not.toContain(managerOnlyResource);
    expect(specialistRun.mock.calls[0][0].systemPrompt).not.toContain(managerOnlyResource);
    expect(reg.getMessages(parent.id).some((message) => message.role === "assistant" && message.content.includes("Delegated specialist work"))).toBe(true);
    expect(events.some((entry) => entry.event === "manager:delegated")).toBe(true);
  });

  it("does not automatically fan out a later manager message that resembles a child report", async () => {
    const reg = await import("../../sessions/registry.js");
    const { runWebSession } = await import("../run-web-session.js");

    const managerRun = vi.fn<Engine["run"]>(async () => ({ result: "handled inline", sessionId: "manager-engine-session" }));
    const specialistRun = vi.fn<Engine["run"]>(async () => ({ result: "security result", sessionId: "specialist-engine-session" }));
    const engines = new Map<string, Engine>([
      ["claude", fakeEngine("claude", managerRun)],
      ["codex", fakeEngine("codex", specialistRun)],
    ]);
    const config = {
      gateway: { host: "127.0.0.1", port: 8888 },
      engines: { default: "claude", claude: { bin: "node", model: "opus" }, codex: { bin: "node", model: "gpt-5.5" } },
      portal: { portalName: "Cuttlefish" },
    } as unknown as CuttlefishConfig;
    const context = {
      getConfig: () => config,
      connectors: new Map(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: (name: string) => engines.get(name),
        getEngines: () => engines,
        getQueue: () => new SessionQueue(),
      },
      startTime: Date.now(),
    } as any;

    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:manager-follow-up",
      connector: "web",
      sessionKey: "web:manager-follow-up",
      employee: "parliamentarian",
      model: "opus",
      prompt: "Initial inline task",
      portalName: "Cuttlefish",
    });
    reg.insertMessage(parent.id, "user", "Initial inline task");
    reg.insertMessage(parent.id, "assistant", "Initial inline response");
    const childLikeMessage = "Security token report from a child: inspect bearer authentication exposure.";
    reg.insertMessage(parent.id, "user", childLikeMessage);

    await runWebSession(parent, childLikeMessage, engines.get("claude")!, config, context);

    expect(managerRun).toHaveBeenCalledTimes(1);
    expect(reg.listChildSessions(parent.id)).toHaveLength(0);
  });

  it("does not restore an engine resume id from a quietly interrupted turn", async () => {
    const reg = await import("../../sessions/registry.js");
    const { runWebSession } = await import("../run-web-session.js");
    const interruptedRun = vi.fn<Engine["run"]>(async () => ({
      sessionId: "stale-grok-session",
      result: "",
      error: "Interrupted by user",
    }));
    const engine = fakeEngine("grok", interruptedRun);
    const config = {
      gateway: { host: "127.0.0.1", port: 8888 },
      engines: { default: "grok", grok: { bin: "node", model: "grok-4.5" } },
      portal: { portalName: "Cuttlefish" },
    } as unknown as CuttlefishConfig;
    const context = {
      getConfig: () => config,
      connectors: new Map(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => new Map([["grok", engine]]),
        getQueue: () => new SessionQueue(),
      },
      startTime: Date.now(),
    } as any;
    const session = reg.createSession({
      engine: "grok",
      source: "web",
      sourceRef: "web:stopped-grok",
      sessionKey: "web:stopped-grok",
      model: "grok-4.5",
      prompt: "resume freshly",
    });
    reg.insertMessage(session.id, "user", "resume freshly");

    await runWebSession(session, "resume freshly", engine, config, context);

    expect(interruptedRun).toHaveBeenCalledTimes(1);
    expect(reg.getSession(session.id)).toMatchObject({
      status: "idle",
      engineSessionId: null,
      lastError: null,
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
