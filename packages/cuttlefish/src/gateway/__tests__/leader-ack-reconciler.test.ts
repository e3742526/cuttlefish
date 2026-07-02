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

  it("acknowledges instead of escalating when the parent already marked the child report no-op", async () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent-noop",
      prompt: "parent",
      employee: "software-delivery-lead",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-noop",
      prompt: "child",
      employee: "execution-safety-reviewer",
      parentSessionId: parent.id,
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "software-delivery-lead",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });
    reg.insertMessage(parent.id, "assistant", "Ignoring this stale acknowledgement loop. Task is closed.");

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

    expect(fixed).toBe(0);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
      acknowledgedBy: "software-delivery-lead",
    });
    expect(dispatchEscalation).not.toHaveBeenCalled();
    expect(reg.getMessages(child.id).some((message) => message.content.includes("Leader acknowledgement timeout"))).toBe(false);
  });

  it("acknowledges when the leader simply relays the report in a normal assistant reply (no explicit ack call)", async () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent-relay",
      prompt: "parent",
      employee: "research-lead",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-relay",
      prompt: "child",
      employee: "researcher",
      parentSessionId: parent.id,
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "research-lead",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });
    // Ordinary relay: the leader just tells the user what the worker found —
    // no boilerplate "acknowledged" phrase, no explicit ack API call.
    reg.insertMessage(parent.id, "assistant", "The vampire squid fact came back from research: it lives in the midnight zone.");

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

    expect(fixed).toBe(0);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
      acknowledgedBy: "research-lead",
    });
    expect(dispatchEscalation).not.toHaveBeenCalled();
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

  it("suppresses a second escalation on the same session lineage instead of re-paging HR (repro: HR closing-ack loop)", async () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent-loop",
      prompt: "parent",
      employee: "coo",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-loop",
      prompt: "child",
      employee: "scraping-lead",
      parentSessionId: parent.id,
    });

    const getConfig = () => ({
      gateway: { port: 8888, host: "127.0.0.1", leaderAckTimeoutMs: 60_000 },
      engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    } as any);

    // Round 1: worker reports, leader never explicitly acks, timeout fires -> escalates to HR.
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "coo",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });
    const dispatchEscalation = vi.fn(async () => {});
    let escalated = rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig,
      now: () => 120_000,
      dispatchEscalation,
    });
    expect(escalated).toBe(1);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "escalated",
      escalationCount: 1,
    });

    // Round 2: HR sends a closing message into the worker session; the worker's
    // reply re-arms a fresh pending cycle via markLeaderAckPending (this is the
    // notifyParentSession path — simulated directly here since that's the exact
    // re-arm this reconciler must dedupe against).
    ack.markLeaderAckPending(reg.getSession(child.id)!, {
      leaderSessionId: parent.id,
      leaderName: "coo",
      reportKind: "result",
      now: new Date(130_000).toISOString(),
    });
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "pending",
      escalationCount: 1, // carried forward, not reset
    });

    escalated = rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig,
      now: () => 250_000,
      dispatchEscalation,
    });

    // Must NOT escalate (page HR) a second time for the same session lineage.
    expect(escalated).toBe(0);
    expect(dispatchEscalation).toHaveBeenCalledTimes(1); // still just the first call
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
    });
  });
});
