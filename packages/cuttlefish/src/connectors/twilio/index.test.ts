import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import Twilio from "twilio";
import { TwilioConnector } from "./index.js";

const config = {
  fromNumber: "+15551234567",
  webhookUrl: "https://sms.example.test/webhooks/twilio/sms",
  allowFrom: ["+15557654321"],
};
const env = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-auth-token",
};

function makeRequest(body: string, signature: string): http.IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage;
  Object.assign(request, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    method: "POST",
  });
  return request;
}

function makeResponse(): { response: http.ServerResponse; status: () => number | undefined; body: () => string } {
  let statusCode: number | undefined;
  let responseBody = "";
  const response = {
    writeHead: vi.fn((status: number) => { statusCode = status; }),
    end: vi.fn((body?: string) => { responseBody = body ?? ""; }),
  } as unknown as http.ServerResponse;
  return { response, status: () => statusCode, body: () => responseBody };
}

describe("TwilioConnector", () => {
  it("accepts a signed allowlisted SMS and routes it once", async () => {
    const client = { messages: { create: vi.fn() } };
    const connector = new TwilioConnector(config, { env, client });
    const received = vi.fn();
    connector.onMessage(received);
    await connector.start();

    const params = {
      From: "+15557654321",
      To: "+15551234567",
      Body: "hello from SMS",
      MessageSid: "SM00000000000000000000000000000000",
    };
    const signature = Twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, config.webhookUrl, params);
    const body = new URLSearchParams(params).toString();
    const first = makeResponse();
    await connector.handleInboundWebhook(makeRequest(body, signature), first.response);

    expect(first.status()).toBe(200);
    expect(first.body()).toContain("<Response>");
    expect(received).toHaveBeenCalledWith(expect.objectContaining({
      connector: "twilio",
      source: "twilio",
      sessionKey: "twilio:+15557654321",
      text: "hello from SMS",
      replyContext: { channel: "+15557654321", from: "+15551234567", messageSid: params.MessageSid },
    }));

    const duplicate = makeResponse();
    await connector.handleInboundWebhook(makeRequest(body, signature), duplicate.response);
    expect(duplicate.status()).toBe(200);
    expect(received).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid signature before routing", async () => {
    const connector = new TwilioConnector(config, { env, client: { messages: { create: vi.fn() } } });
    const received = vi.fn();
    connector.onMessage(received);
    await connector.start();

    const response = makeResponse();
    await connector.handleInboundWebhook(
      makeRequest("From=%2B15557654321&To=%2B15551234567&Body=forged", "not-a-twilio-signature"),
      response.response,
    );

    expect(response.status()).toBe(403);
    expect(received).not.toHaveBeenCalled();
  });

  it("uses the inbound destination number when replying", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SMsent" });
    const connector = new TwilioConnector(config, { env, client: { messages: { create } } });
    await connector.start();

    await expect(connector.replyMessage({
      channel: "+15557654321",
      replyContext: { from: "+15551234567" },
    }, "agent reply")).resolves.toBe("SMsent");

    expect(create).toHaveBeenCalledWith({
      to: "+15557654321",
      from: "+15551234567",
      body: "agent reply",
    });
  });
});
