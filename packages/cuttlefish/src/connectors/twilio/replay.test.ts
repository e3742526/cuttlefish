import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Twilio from "twilio";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { logger } from "../../shared/logger.js";

// The connector is imported only after the registry path points at this
// throwaway home. That lets this test prove replay suppression survives a new
// connector instance without touching the operator's durable state.
withStaticTempCuttlefishHome("cuttlefish-twilio-replay-");

type TwilioConnectorClass = (typeof import("./index.js"))["TwilioConnector"];
let TwilioConnector: TwilioConnectorClass;
let replayTtlMs: number;

const config = {
  fromNumber: "+15551234567",
  webhookUrl: "https://sms.example.test/webhooks/twilio/sms",
  allowFrom: ["+15557654321"],
};
const env = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-auth-token",
};

function makeRequest(
  body: string,
  signature: string,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage;
  Object.assign(request, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
      ...headers,
    },
    method: "POST",
  });
  return request;
}

function makeResponse(): { response: http.ServerResponse; status: () => number | undefined } {
  let statusCode: number | undefined;
  return {
    response: {
      writeHead: vi.fn((status: number) => { statusCode = status; }),
      end: vi.fn(),
    } as unknown as http.ServerResponse,
    status: () => statusCode,
  };
}

beforeAll(async () => {
  const module = await import("./index.js");
  TwilioConnector = module.TwilioConnector;
  replayTtlMs = module.TWILIO_WEBHOOK_REPLAY_TTL_MS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TwilioConnector durable webhook replay suppression", () => {
  it("suppresses a MessageSid retry after the connector is recreated", async () => {
    const params = {
      From: "+15557654321",
      To: "+15551234567",
      Body: "replay me",
      MessageSid: "SMdurableReplay000000000000000001",
    };
    const signature = Twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, config.webhookUrl, params);
    const body = new URLSearchParams(params).toString();

    const firstHandler = vi.fn();
    const first = new TwilioConnector(config, { env, client: { messages: { create: vi.fn() } } });
    first.onMessage(firstHandler);
    await first.start();
    await first.handleInboundWebhook(makeRequest(body, signature), makeResponse().response);

    const secondHandler = vi.fn();
    const recreated = new TwilioConnector(config, { env, client: { messages: { create: vi.fn() } } });
    recreated.onMessage(secondHandler);
    await recreated.start();
    await recreated.handleInboundWebhook(makeRequest(body, signature, {
      "i-twilio-idempotency-token": "header-added-on-replay",
    }), makeResponse().response);

    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it("uses Twilio's idempotency token when a MessageSid is unavailable", async () => {
    const params = {
      From: "+15557654321",
      To: "+15551234567",
      Body: "header-only retry",
    };
    const signature = Twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, config.webhookUrl, params);
    const body = new URLSearchParams(params).toString();
    const headers = { "i-twilio-idempotency-token": "twilio-retry-token-001" };

    const firstHandler = vi.fn();
    const first = new TwilioConnector(config, { env, client: { messages: { create: vi.fn() } } });
    first.onMessage(firstHandler);
    await first.start();
    await first.handleInboundWebhook(makeRequest(body, signature, headers), makeResponse().response);

    const secondHandler = vi.fn();
    const recreated = new TwilioConnector(config, { env, client: { messages: { create: vi.fn() } } });
    recreated.onMessage(secondHandler);
    await recreated.start();
    await recreated.handleInboundWebhook(makeRequest(body, signature, headers), makeResponse().response);

    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it("allows a legitimate MessageSid reuse after the replay TTL expires", async () => {
    const params = {
      From: "+15557654321",
      To: "+15551234567",
      Body: "expired replay guard",
      MessageSid: "SMdurableReplay000000000000000002",
    };
    const signature = Twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, config.webhookUrl, params);
    const body = new URLSearchParams(params).toString();
    const startedAt = 1_000;

    const firstHandler = vi.fn();
    const first = new TwilioConnector(config, {
      env,
      client: { messages: { create: vi.fn() } },
      now: () => startedAt,
    });
    first.onMessage(firstHandler);
    await first.start();
    await first.handleInboundWebhook(makeRequest(body, signature), makeResponse().response);

    const secondHandler = vi.fn();
    const afterExpiry = new TwilioConnector(config, {
      env,
      client: { messages: { create: vi.fn() } },
      now: () => startedAt + replayTtlMs + 1,
    });
    afterExpiry.onMessage(secondHandler);
    await afterExpiry.start();
    await afterExpiry.handleInboundWebhook(makeRequest(body, signature), makeResponse().response);

    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });

  it("releases a failed dispatch claim so Twilio can retry", async () => {
    const params = {
      From: "+15557654321",
      To: "+15551234567",
      Body: "retry after dispatch failure",
      MessageSid: "SMdurableReplay000000000000000003",
    };
    const signature = Twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, config.webhookUrl, params);
    const body = new URLSearchParams(params).toString();

    const failed = new TwilioConnector(config, { env, client: { messages: { create: vi.fn() } } });
    failed.onMessage(() => { throw new Error("injected dispatch failure"); });
    await failed.start();
    const failedResponse = makeResponse();
    await failed.handleInboundWebhook(makeRequest(body, signature), failedResponse.response);
    expect(failedResponse.status()).toBe(500);

    const recoveredHandler = vi.fn();
    const retry = new TwilioConnector(config, { env, client: { messages: { create: vi.fn() } } });
    retry.onMessage(recoveredHandler);
    await retry.start();
    await retry.handleInboundWebhook(makeRequest(body, signature), makeResponse().response);

    expect(recoveredHandler).toHaveBeenCalledTimes(1);
  });

  it("emits replay telemetry without phone numbers, message text, or provider ids", async () => {
    const params = {
      From: "+15557654321",
      To: "+15551234567",
      Body: "private inbound body",
      MessageSid: "SMdurableReplay000000000000000004",
    };
    const signature = Twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, config.webhookUrl, params);
    const body = new URLSearchParams(params).toString();
    const logInfo = vi.spyOn(logger, "info");
    const connector = new TwilioConnector(config, { env, client: { messages: { create: vi.fn() } } });
    connector.onMessage(vi.fn());
    await connector.start();
    await connector.handleInboundWebhook(makeRequest(body, signature), makeResponse().response);
    await connector.handleInboundWebhook(makeRequest(body, signature), makeResponse().response);

    const telemetry = logInfo.mock.calls.map(([message]) => message).filter((message) => message.startsWith("twilio_webhook"));
    expect(telemetry).toEqual(expect.arrayContaining([
      "twilio_webhook outcome=accepted replay_key=message_sid",
      "twilio_webhook outcome=duplicate_suppressed replay_key=message_sid",
    ]));
    expect(telemetry.join("\n")).not.toContain(params.From);
    expect(telemetry.join("\n")).not.toContain(params.To);
    expect(telemetry.join("\n")).not.toContain(params.Body);
    expect(telemetry.join("\n")).not.toContain(params.MessageSid);
  });
});
