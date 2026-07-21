import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { SessionQueue } from "../../sessions/queue.js";
import type { CuttlefishConfig, Engine } from "../../shared/types.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-web-session-accounting-");

function fakeEngine(run: Engine["run"]): Engine {
  return { name: "claude", run };
}

async function setup() {
  const reg = await import("../../sessions/registry.js");
  const { recordSuccessfulWebSessionTurn, runWebSession } = await import("../run-web-session.js");
  reg.initDb();
  return { reg, recordSuccessfulWebSessionTurn, runWebSession };
}

describe("web-session turn accounting (PT-SC-04)", () => {
  beforeEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("records a completed direct web turn in the durable session total", async () => {
    const { reg, runWebSession } = await setup();
    const run = vi.fn<Engine["run"]>(async () => ({ result: "completed", sessionId: "engine-session", cost: 0.25, numTurns: 2 }));
    const engine = fakeEngine(run);
    const engines = new Map([["claude", engine]]);
    const config = {
      gateway: { host: "127.0.0.1", port: 8888 },
      engines: { default: "claude", claude: { bin: "node", model: "opus" } },
      portal: { portalName: "Cuttlefish" },
    } as unknown as CuttlefishConfig;
    const context = {
      getConfig: () => config,
      connectors: new Map(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => engines,
        getQueue: () => new SessionQueue(),
      },
      startTime: Date.now(),
    } as any;
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:accounting-direct",
      sessionKey: "web:accounting-direct",
      prompt: "complete this turn",
    });
    reg.insertMessage(session.id, "user", "complete this turn");

    await runWebSession(session, "complete this turn", engine, config, context);

    expect(run).toHaveBeenCalledOnce();
    expect(reg.getSession(session.id)).toMatchObject({ totalCost: 0.25, totalTurns: 2, status: "idle" });
  });

  it("uses the same exactly-once rule for fallback and retry completions", async () => {
    const { reg, recordSuccessfulWebSessionTurn } = await setup();
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:accounting-recovery", prompt: "x" });

    recordSuccessfulWebSessionTurn(session.id, { cost: 0.1, numTurns: 1 });
    recordSuccessfulWebSessionTurn(session.id, {});
    recordSuccessfulWebSessionTurn(session.id, { error: "engine failed", cost: 5, numTurns: 5 });

    expect(reg.getSession(session.id)).toMatchObject({ totalCost: 0.1, totalTurns: 2 });
  });
});
