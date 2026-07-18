import { beforeEach, describe, expect, it, vi } from "vitest";

// TMP-CUT-017: the Slack connector's health flag used to be set once in
// start() and never re-probed, so a silent socket-mode disconnect kept
// getHealth() reporting "running" forever. These tests exercise the
// connection-monitor listeners added on the underlying socket-mode client
// (exposed by @slack/bolt as `receiver.client`) without opening a real
// Slack connection.

type Listener = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const client = new (class {
    private listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener) {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  })();
  const appStart = vi.fn().mockResolvedValue(undefined);
  const appStop = vi.fn().mockImplementation(async () => {
    // Mirrors real Bolt behavior: App.stop() disconnects the underlying
    // socket-mode client, which drives it through the "disconnected" state.
    client.emit("disconnected");
  });
  return { client, appStart, appStop };
});

vi.mock("@slack/bolt", () => {
  class FakeApp {
    receiver = { client: mocks.client };
    client = {
      conversations: { info: vi.fn(), replies: vi.fn() },
      chat: { postMessage: vi.fn(), update: vi.fn() },
      reactions: { add: vi.fn(), remove: vi.fn() },
      auth: { test: vi.fn().mockResolvedValue({ user_id: "U_BOT" }) },
      token: "xoxb-fake",
    };
    message = vi.fn();
    event = vi.fn();
    start = mocks.appStart;
    stop = mocks.appStop;
  }
  return { App: FakeApp };
});

import { SlackConnector } from "./index.js";

const config = { appToken: "xapp-fake", botToken: "xoxb-fake", allowFrom: ["U1"] };

describe("SlackConnector connection monitor (TMP-CUT-017)", () => {
  beforeEach(() => {
    mocks.appStart.mockClear();
    mocks.appStop.mockClear();
  });

  it("reports running after start() and does not need a disconnect to say so", async () => {
    const connector = new SlackConnector(config);
    await connector.start();
    expect(connector.getHealth().status).toBe("running");
  });

  it("reflects a silent socket-mode disconnect instead of staying running forever", async () => {
    const connector = new SlackConnector(config);
    await connector.start();
    expect(connector.getHealth().status).toBe("running");

    mocks.client.emit("disconnected", new Error("socket closed unexpectedly"));

    const health = connector.getHealth();
    expect(health.status).toBe("error");
    expect(health.detail).toContain("socket closed unexpectedly");
  });

  it("recovers to running once the socket-mode client reconnects", async () => {
    const connector = new SlackConnector(config);
    await connector.start();

    mocks.client.emit("disconnected", new Error("boom"));
    expect(connector.getHealth().status).toBe("error");

    mocks.client.emit("connected");
    expect(connector.getHealth().status).toBe("running");
  });

  it("surfaces a raw socket error without waiting for an explicit disconnect", async () => {
    const connector = new SlackConnector(config);
    await connector.start();

    mocks.client.emit("error", new Error("websocket error"));

    const health = connector.getHealth();
    expect(health.status).toBe("error");
    expect(health.detail).toContain("websocket error");
  });

  it("reports stopped (not error) after a deliberate stop(), even though stop() disconnects the client", async () => {
    const connector = new SlackConnector(config);
    await connector.start();

    await connector.stop();

    const health = connector.getHealth();
    expect(health.status).toBe("stopped");
    expect(health.detail).toBeUndefined();
  });
});
