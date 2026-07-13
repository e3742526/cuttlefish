import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuttlefishConfig } from "../../shared/types.js";

const mocks = vi.hoisted(() => {
  const state: { stopBlocker?: Promise<void> } = {};
  class MockConnector {
    name: string;
    readonly config: unknown;
    stopCalls = 0;

    constructor(name: string, config: unknown) {
      this.name = name;
      this.config = config;
    }

    async start(): Promise<void> {}
    async stop(): Promise<void> {
      this.stopCalls += 1;
      await state.stopBlocker;
    }
    onMessage(): void {}
  }
  return {
    MockConnector,
    slack: [] as MockConnector[],
    whatsapp: [] as MockConnector[],
    twilio: [] as MockConnector[],
    loadConfig: vi.fn(),
    state,
  };
});

type MockConnector = InstanceType<typeof mocks.MockConnector>;

vi.mock("../../shared/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../connectors/slack/index.js", () => ({
  SlackConnector: class extends mocks.MockConnector {
    constructor(config: unknown) {
      super("slack", config);
      mocks.slack.push(this);
    }
  },
}));
vi.mock("../../connectors/whatsapp/index.js", () => ({
  WhatsAppConnector: class extends mocks.MockConnector {
    constructor(config: unknown) {
      super("whatsapp", config);
      mocks.whatsapp.push(this);
    }
  },
}));
vi.mock("../../connectors/twilio/index.js", () => ({
  TwilioConnector: class extends mocks.MockConnector {
    constructor(config: unknown) {
      super("twilio", config);
      mocks.twilio.push(this);
    }
  },
}));

import { startConfiguredConnectors } from "./connectors.js";

function config(connectors: CuttlefishConfig["connectors"]): CuttlefishConfig {
  return { connectors } as CuttlefishConfig;
}

describe("configured connector reload", () => {
  beforeEach(() => {
    mocks.slack.length = 0;
    mocks.whatsapp.length = 0;
    mocks.twilio.length = 0;
    mocks.loadConfig.mockReset();
    mocks.state.stopBlocker = undefined;
  });

  it("replaces top-level and instance connectors from the fresh configuration", async () => {
    const initial = config({
      slack: { appToken: "old-app", botToken: "old-bot" },
      whatsapp: { allowFrom: ["old@s.whatsapp.net"] },
      twilio: { webhookUrl: "https://sms.example.test/old", fromNumber: "+15550000001" },
      instances: [{ id: "support", type: "slack", appToken: "support-app", botToken: "support-bot" }],
    });
    const next = config({
      twilio: { webhookUrl: "https://sms.example.test/new", fromNumber: "+15550000002" },
    });
    mocks.loadConfig.mockReturnValue(next);
    const sessionManager = { route: vi.fn() } as never;
    const lifecycle = startConfiguredConnectors({
      config: initial,
      sessionManager,
      getEmployeeRegistry: () => new Map(),
    });
    const initialConnectors = [...lifecycle.connectorMap.values()] as unknown as MockConnector[];

    const result = await lifecycle.reloadConnectorInstances();

    expect(result.stopped).toEqual(expect.arrayContaining(["slack", "whatsapp", "twilio", "support"]));
    expect(result.started).toEqual(["twilio"]);
    expect(initialConnectors.every((connector) => connector.stopCalls === 1)).toBe(true);
    expect([...lifecycle.connectorMap.keys()]).toEqual(["twilio"]);
    expect(lifecycle.instanceConnectorIds.size).toBe(0);
    expect(mocks.twilio).toHaveLength(2);
    expect(mocks.twilio[1]?.config).toEqual(next.connectors.twilio);
  });

  it("removes routes before an asynchronous connector shutdown completes", async () => {
    const initial = config({
      twilio: { webhookUrl: "https://sms.example.test/old", fromNumber: "+15550000001" },
    });
    const next = config({});
    let releaseShutdown: (() => void) | undefined;
    mocks.state.stopBlocker = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const lifecycle = startConfiguredConnectors({
      config: initial,
      sessionManager: { route: vi.fn() } as never,
      getEmployeeRegistry: () => new Map(),
    });

    const reload = lifecycle.reloadConfiguredConnectors(next);
    expect(lifecycle.connectorMap.size).toBe(0);
    releaseShutdown?.();
    await reload;
  });
});
