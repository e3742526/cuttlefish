import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markdownToSlackMrkdwn, formatResponse, downloadAttachment, SLACK_MAX_ATTACHMENT_BYTES } from "../format.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("downloadAttachment byte limits (AR-08)", () => {
  it("rejects and cleans up when the declared content-length exceeds the cap", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(8), {
        status: 200,
        headers: { "content-length": String(SLACK_MAX_ATTACHMENT_BYTES + 1) },
      }),
    ) as unknown as typeof fetch;

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-dl-"));
    try {
      await expect(downloadAttachment("https://files.slack.com/x/big.bin", "tok", destDir))
        .rejects.toThrow(/exceeds/);
      expect(fs.readdirSync(destDir)).toHaveLength(0); // no partial file left behind
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it("rejects when a streamed body (no content-length) exceeds the cap", async () => {
    // A ReadableStream body carries no content-length, so only the streaming cap
    // in readCappedBody can stop it. Emit chunks totalling just over the limit.
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > SLACK_MAX_ATTACHMENT_BYTES) { controller.close(); return; }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-dl-"));
    try {
      await expect(downloadAttachment("https://files.slack.com/x/stream.bin", "tok", destDir))
        .rejects.toThrow(/exceeds/);
      expect(fs.readdirSync(destDir)).toHaveLength(0);
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });
});

describe("markdownToSlackMrkdwn", () => {
  describe("headings", () => {
    it("converts ## headings to bold on own line", () => {
      expect(markdownToSlackMrkdwn("## My Heading")).toBe("*My Heading*");
    });

    it("converts ### headings to bold", () => {
      expect(markdownToSlackMrkdwn("### Sub Heading")).toBe("*Sub Heading*");
    });

    it("converts # h1 to bold", () => {
      expect(markdownToSlackMrkdwn("# Title")).toBe("*Title*");
    });

    it("converts headings with up to 6 levels", () => {
      expect(markdownToSlackMrkdwn("###### Deep")).toBe("*Deep*");
    });

    it("only converts headings at start of line", () => {
      expect(markdownToSlackMrkdwn("not a ## heading")).toBe("not a ## heading");
    });
  });

  describe("bold", () => {
    it("converts **bold** to *bold*", () => {
      expect(markdownToSlackMrkdwn("this is **bold** text")).toBe("this is *bold* text");
    });

    it("converts __bold__ to *bold*", () => {
      expect(markdownToSlackMrkdwn("this is __bold__ text")).toBe("this is *bold* text");
    });

    it("handles multiple bold segments", () => {
      expect(markdownToSlackMrkdwn("**a** and **b**")).toBe("*a* and *b*");
    });
  });

  describe("italic", () => {
    it("converts _italic_ to _italic_ (passthrough)", () => {
      expect(markdownToSlackMrkdwn("this is _italic_ text")).toBe("this is _italic_ text");
    });
  });

  describe("strikethrough", () => {
    it("converts ~~strike~~ to ~strike~", () => {
      expect(markdownToSlackMrkdwn("this is ~~struck~~ out")).toBe("this is ~struck~ out");
    });
  });

  describe("links", () => {
    it("converts [text](url) to <url|text>", () => {
      expect(markdownToSlackMrkdwn("click [here](https://example.com) now")).toBe(
        "click <https://example.com|here> now",
      );
    });

    it("converts multiple links", () => {
      expect(markdownToSlackMrkdwn("[a](http://a.com) and [b](http://b.com)")).toBe(
        "<http://a.com|a> and <http://b.com|b>",
      );
    });

    it("handles bare URLs (no conversion needed)", () => {
      expect(markdownToSlackMrkdwn("visit https://example.com")).toBe("visit https://example.com");
    });
  });

  describe("bullet lists", () => {
    it("converts - item to • item", () => {
      expect(markdownToSlackMrkdwn("- first\n- second")).toBe("• first\n• second");
    });

    it("converts * item to • item", () => {
      expect(markdownToSlackMrkdwn("* first\n* second")).toBe("• first\n• second");
    });

    it("preserves indented sub-items", () => {
      expect(markdownToSlackMrkdwn("- top\n  - nested")).toBe("• top\n  • nested");
    });
  });

  describe("code (preserved)", () => {
    it("preserves inline code", () => {
      expect(markdownToSlackMrkdwn("use `console.log`")).toBe("use `console.log`");
    });

    it("preserves code blocks", () => {
      const input = "```\nconst x = 1;\n```";
      expect(markdownToSlackMrkdwn(input)).toBe("```\nconst x = 1;\n```");
    });

    it("does not convert markdown inside code blocks", () => {
      const input = "```\n## not a heading\n**not bold**\n```";
      expect(markdownToSlackMrkdwn(input)).toBe("```\n## not a heading\n**not bold**\n```");
    });

    it("does not convert markdown inside inline code", () => {
      expect(markdownToSlackMrkdwn("use `**not bold**`")).toBe("use `**not bold**`");
    });
  });

  describe("blockquotes", () => {
    it("preserves > blockquotes (Slack supports them)", () => {
      expect(markdownToSlackMrkdwn("> quoted text")).toBe("> quoted text");
    });
  });

  describe("numbered lists", () => {
    it("preserves numbered lists as-is", () => {
      expect(markdownToSlackMrkdwn("1. first\n2. second")).toBe("1. first\n2. second");
    });
  });

  describe("complex mixed content", () => {
    it("handles headings + bold + links together", () => {
      const input = "## Summary\n\nThis is **important** and [see docs](https://docs.com).";
      const expected = "*Summary*\n\nThis is *important* and <https://docs.com|see docs>.";
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });

    it("handles text between code blocks", () => {
      const input = "Before\n```\ncode\n```\n**after**";
      const expected = "Before\n```\ncode\n```\n*after*";
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });
  });
});

describe("formatResponse", () => {
  it("applies markdown conversion before chunking", () => {
    const result = formatResponse("## Hello\n\nThis is **bold**.");
    expect(result).toEqual(["*Hello*\n\nThis is *bold*."]);
  });

  it("still chunks long messages after conversion", () => {
    const longText = "## Title\n\n" + "word ".repeat(1000);
    const result = formatResponse(longText);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0].startsWith("*Title*")).toBe(true);
  });
});
