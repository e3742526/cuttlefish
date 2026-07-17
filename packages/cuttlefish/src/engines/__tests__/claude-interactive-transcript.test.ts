import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computeInteractiveTurnStats, computeInteractiveTurnStatsSinceAnchor } from "../claude-interactive-transcript.js";

/** Append one assistant usage line to a transcript, mirroring how the Claude
 *  interactive .jsonl grows: every turn appends more lines to the SAME
 *  session-long file, so usage read from it is cumulative for the whole
 *  session, not just the newest turn. */
function appendAssistantUsage(file: string, usage: { input_tokens: number; output_tokens: number }): void {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage },
  });
  fs.appendFileSync(file, line + "\n");
}

describe("computeInteractiveTurnStats — cumulative totals for the whole transcript", () => {
  it("sums cost/turns across every assistant line, not just the newest one", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-stats-"));
    const file = path.join(tmp, "sess.jsonl");
    fs.writeFileSync(file, "");
    appendAssistantUsage(file, { input_tokens: 1_000_000, output_tokens: 0 });
    appendAssistantUsage(file, { input_tokens: 1_000_000, output_tokens: 0 });

    const stats = computeInteractiveTurnStats(file, "claude-sonnet-5");
    expect(stats?.cost?.turns).toBe(2);
    expect(stats?.cost?.cost).toBeCloseTo(6, 5); // 2 * ($3/M input tokens)
  });
});

describe("computeInteractiveTurnStatsSinceAnchor — per-turn delta, not session-cumulative total", () => {
  it("reports only the new turn's cost/turns across consecutive turns, not the running total", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-stats-anchor-"));
    const file = path.join(tmp, "sess.jsonl");
    fs.writeFileSync(file, "");

    // Turn 1: first usage line lands in the transcript.
    appendAssistantUsage(file, { input_tokens: 1_000_000, output_tokens: 0 });
    const turn1 = computeInteractiveTurnStatsSinceAnchor(file, "claude-sonnet-5", undefined);
    expect(turn1?.cost).toEqual({ cost: 3, turns: 1 });
    expect(turn1?.cumulative).toEqual({ cost: 3, turns: 1 });

    // Turn 2: more usage is appended to the SAME (session-cumulative) transcript.
    // Without anchoring, computeInteractiveTurnStats would now read cost:6, turns:2
    // for the whole file — the bug this guards against is reporting that running
    // total as if it were turn 2's own cost.
    appendAssistantUsage(file, { input_tokens: 1_000_000, output_tokens: 0 });
    const turn2 = computeInteractiveTurnStatsSinceAnchor(file, "claude-sonnet-5", turn1?.cumulative);
    expect(turn2?.cost).toEqual({ cost: 3, turns: 1 }); // delta only, not the cumulative 6/2
    expect(turn2?.cumulative).toEqual({ cost: 6, turns: 2 });

    // Turn 3: a bigger turn, anchored off turn 2's cumulative snapshot.
    appendAssistantUsage(file, { input_tokens: 2_000_000, output_tokens: 0 });
    const turn3 = computeInteractiveTurnStatsSinceAnchor(file, "claude-sonnet-5", turn2?.cumulative);
    expect(turn3?.cost).toEqual({ cost: 6, turns: 1 });
    expect(turn3?.cumulative).toEqual({ cost: 12, turns: 3 });
  });

  it("treats a missing anchor (first turn / unknown session) as a 0 baseline, so the delta equals the raw cumulative total", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-stats-anchor-"));
    const file = path.join(tmp, "sess.jsonl");
    fs.writeFileSync(file, "");
    appendAssistantUsage(file, { input_tokens: 1_000_000, output_tokens: 1_000_000 });

    const stats = computeInteractiveTurnStatsSinceAnchor(file, "claude-sonnet-5", undefined);
    expect(stats?.cost).toEqual({ cost: 18, turns: 1 }); // $3 in + $15 out
  });

  it("clamps to 0 instead of going negative when the anchor is stale/ahead of the transcript", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-stats-anchor-"));
    const file = path.join(tmp, "sess.jsonl");
    fs.writeFileSync(file, "");
    appendAssistantUsage(file, { input_tokens: 1_000_000, output_tokens: 0 });

    const stats = computeInteractiveTurnStatsSinceAnchor(file, "claude-sonnet-5", { cost: 999, turns: 999 });
    expect(stats?.cost).toEqual({ cost: 0, turns: 0 });
  });

  it("returns null for a missing transcript file", () => {
    expect(computeInteractiveTurnStatsSinceAnchor("/nonexistent/path.jsonl", "claude-sonnet-5", undefined)).toBeNull();
  });
});
