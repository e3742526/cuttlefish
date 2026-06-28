import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-leader-ack-");

type Rec = typeof import("../leader-ack-reconciler.js");
type Reg = typeof import("../../sessions/registry.js");
type Ack = typeof import("../../sessions/leader-ack.js");
let rec: Rec;
let reg: Reg;
let ack: Ack;

beforeAll(async () => {
  rec = await import("../leader-ack-reconciler.js");
  reg = await import("../../sessions/registry.js");
  ack = await import("../../sessions/leader-ack.js");
  reg.initDb();
});

beforeEach(() => {
  const orgDir = path.join(tmp, "org", "general");
  fs.mkdirSync(orgDir, { recursive: true });
  fs.writeFileSync(path.join(orgDir, "hr-manager.yaml"), "name: hr-manager\ndisplayName: HR Manager\ndepartment: general\nrank: manager\nengine: claude\nmodel: opus\npersona: Handle escalations.\n");
  fs.writeFileSync(path.join(orgDir, "coo.yaml"), "name: coo\ndisplayName: COO\ndepartment: general\nrank: executive\nengine: claude\nmodel: opus\npersona: Run the org.\n");
});

describe("leader acknowledgement reconciler", () => {
  it("escalates overdue pending leader acknowledgements to hr-manager", async () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent",
      prompt: "parent",
      employee: "coo",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child",
      prompt: "child",
      employee: "assistant",
      parentSessionId: parent.id,
      transportMeta: { boardTicketId: "ticket-1", boardDepartment: "general" } as any,
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "coo",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });

    const dispatchEscalation = vi.fn(async () => {});
    const fixed = rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig: () => ({
        gateway: { port: 8888, host: "127.0.0.1", leaderAckTimeoutMs: 60_000 },
        engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
        connectors: {},
        logging: { file: true, stdout: true, level: "info" },
      } as any),
      now: () => 120_000,
      dispatchEscalation,
    });

    expect(fixed).toBe(1);
    const updated = reg.getSession(child.id);
    expect(ack.readLeaderAckMeta(updated)).toMatchObject({
      state: "escalated",
      escalatedTo: "hr-manager",
    });
    expect(dispatchEscalation).toHaveBeenCalledTimes(1);
    const escalationCalls = dispatchEscalation.mock.calls as unknown[][];
    const firstEscalation = escalationCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(firstEscalation).toMatchObject({
      recipient: expect.objectContaining({ name: "hr-manager" }),
    });
    expect(reg.getMessages(child.id).some((message) => message.content.includes("Escalated to HR Manager"))).toBe(true);
  });

  it("marks the leader ack acknowledged when the child receives a real follow-up", () => {
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-ack",
      prompt: "child",
      employee: "assistant",
      parentSessionId: "parent-ack",
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: "parent-ack",
      leaderName: "boss",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });

    const changed = ack.acknowledgeLeaderAck(child.id, reg.getSession(child.id), {
      acknowledgedBy: "boss",
      now: new Date(30_000).toISOString(),
    });

    expect(changed).toBe(true);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
      acknowledgedBy: "boss",
    });
  });
});
