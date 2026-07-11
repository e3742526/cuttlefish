import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { convertOutsideCode, formatAndChunk } from "../shared/format.js";
import { safeWriteFile } from "../../shared/safe-write.js";

const SLACK_MAX_LENGTH = 3000;

/** Hard cap on a single downloaded Slack attachment (AR-08). */
export const SLACK_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Abort a Slack attachment download that stalls past this window (AR-08). */
export const SLACK_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Read a fetch Response body into a Buffer, aborting past `maxBytes`. */
async function readCappedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Slack attachment exceeds ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 * Handles headings, bold, strikethrough, links, and bullet lists.
 * Preserves code blocks and inline code untouched.
 */
export function markdownToSlackMrkdwn(text: string): string {
  return convertOutsideCode(text, (segment) =>
    segment
      // Headings: ## text → *text* (must be at start of line)
      .replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content) => `*${content}*`)
      // Bold: **text** or __text__ → *text*
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      // Strikethrough: ~~text~~ → ~text~
      .replace(/~~(.+?)~~/g, "~$1~")
      // Links: [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
      // Bullet lists: - item or * item → • item (with optional indentation)
      .replace(/^(\s*)[-*]\s+/gm, "$1• "),
  );
}

/**
 * Split text into chunks that fit within Slack's message length limit.
 * Converts markdown to Slack mrkdwn format before chunking.
 */
export function formatResponse(text: string): string[] {
  return formatAndChunk(text, SLACK_MAX_LENGTH, markdownToSlackMrkdwn);
}

/**
 * Download a Slack file attachment to a local directory.
 * Returns the local file path.
 */
export async function downloadAttachment(
  url: string,
  token: string,
  destDir: string,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });

  // Use a random disk filename so the saved path never trusts user-controlled names.
  // Preserve only the extension inferred from the Slack URL.
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath) || "";
  const filename = `${randomUUID()}${ext}`;
  const localPath = path.join(destDir, filename);

  // Bound the download: a timeout aborts a stalled transfer, a content-length
  // precheck rejects an oversized body up front, and the streamed read caps
  // actual bytes — so a compromised connector cannot exhaust memory/disk (AR-08).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declared = Number.parseInt(contentLength, 10);
      if (Number.isFinite(declared) && declared > SLACK_MAX_ATTACHMENT_BYTES) {
        throw new Error(`Slack attachment exceeds ${SLACK_MAX_ATTACHMENT_BYTES} byte limit (declared ${declared})`);
      }
    }
    const buffer = await readCappedBody(response, SLACK_MAX_ATTACHMENT_BYTES);
    safeWriteFile(localPath, buffer, { fsync: false }); // atomic media write; durability unneeded
    return localPath;
  } catch (err) {
    // Leave nothing behind on abort/oversize/failure.
    try { fs.rmSync(localPath, { force: true }); } catch {}
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
