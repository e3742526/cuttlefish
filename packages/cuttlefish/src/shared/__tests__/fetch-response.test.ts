import { describe, expect, it } from "vitest";
import {
  readResponseBuffer,
  readResponseJson,
  ResponseBodyTooLargeError,
} from "../fetch-response.js";

describe("bounded fetch response readers", () => {
  it("accepts bodies at the byte limit", async () => {
    const response = new Response("1234", {
      headers: { "content-length": "4" },
    });
    await expect(readResponseBuffer(response, 4)).resolves.toEqual(Buffer.from("1234"));
  });

  it("rejects an oversized declared content length before reading", async () => {
    const response = new Response("small", {
      headers: { "content-length": "100" },
    });
    await expect(readResponseBuffer(response, 10)).rejects.toEqual(
      expect.objectContaining({
        name: "ResponseBodyTooLargeError",
        maxBytes: 10,
        observedBytes: 100,
      }),
    );
  });

  it("rejects an oversized chunked body and parses bounded JSON", async () => {
    const oversized = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
        controller.close();
      },
    }));
    await expect(readResponseBuffer(oversized, 7)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);

    const json = new Response(JSON.stringify({ ok: true }));
    await expect(readResponseJson<{ ok: boolean }>(json, 32)).resolves.toEqual({ ok: true });
  });
});
