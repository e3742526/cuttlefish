import { describe, expect, it } from "vitest";
import { capAppend, ENGINE_OUTPUT_MAX, ENGINE_LINE_BUF_MAX } from "../cap-append.js";

describe("capAppend (AR-09)", () => {
  it("appends normally while under the cap", () => {
    expect(capAppend("abc", "def", 10)).toBe("abcdef");
    expect(capAppend("", "hello", 10)).toBe("hello");
  });

  it("retains only the most-recent `max` characters when over the cap", () => {
    expect(capAppend("abcd", "efgh", 5)).toBe("defgh");
    // A single oversized chunk is itself trimmed to the tail.
    expect(capAppend("", "0123456789", 4)).toBe("6789");
  });

  it("bounds unbounded accumulation across many appends", () => {
    let buf = "";
    for (let i = 0; i < 10_000; i++) buf = capAppend(buf, "x".repeat(1000), 4096);
    expect(buf.length).toBe(4096);
  });

  it("exposes sane default caps", () => {
    expect(ENGINE_OUTPUT_MAX).toBe(2 * 1024 * 1024);
    expect(ENGINE_LINE_BUF_MAX).toBe(2 * 1024 * 1024);
  });
});
