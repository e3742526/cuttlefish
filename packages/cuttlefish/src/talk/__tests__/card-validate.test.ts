import { describe, it, expect } from "vitest";
import { validateCard, validateCardPatch } from "../card-validate.js";

describe("validateCard", () => {
  // The voice surface is narrowed to "something to DO or a job to WATCH" (+ one
  // compact text valve). Only these 5 types are accepted; the rich-content zoo is
  // dropped (belongs in /chat).
  it("accepts a valid card of each voice-surface type", () => {
    const cards: unknown[] = [
      { id: "v1", type: "text", body: "a short thing easier read than heard" },
      { id: "v2", type: "status", label: "build", progress: 0.5, state: "running" },
      {
        id: "v3",
        type: "agent-activity",
        agents: [{ id: "a1", name: "Dev", role: "engineer", status: "done" }],
      },
      { id: "v4", type: "choice", prompt: "pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "v5", type: "approval", summary: "Send it?", details: [{ k: "To", v: "x@y.com" }], danger: true },
    ];
    for (const card of cards) {
      const result = validateCard(card);
      expect(result.ok, JSON.stringify(card)).toBe(true);
      if (result.ok) expect(result.card).toBe(card);
    }
  });

  it("accepts well-formed rich-content types (all 13 renderer types now allowed)", () => {
    const richCards: unknown[] = [
      { id: "x1", type: "list", items: [{ text: "one" }] },
      { id: "x2", type: "stat", value: "42", label: "users" },
      { id: "x3", type: "link", url: "https://x", label: "open" },
      { id: "x4", type: "image", src: "https://x/y.png" },
      { id: "x5", type: "image-grid", images: [{ src: "https://x/1.png" }] },
      { id: "x6", type: "comparison", columns: ["X", "Y"], rows: [{ label: "Price", cells: ["1", "2"] }] },
      { id: "x7", type: "keyvalue", rows: [{ k: "Uptime", v: "99%" }] },
      { id: "x8", type: "diff", hunks: [{ label: "cfg", before: "a", after: "b" }] },
    ];
    for (const card of richCards) {
      const result = validateCard(card);
      expect(result.ok, JSON.stringify(card)).toBe(true);
    }
  });

  it("rejects a card with a missing id", () => {
    const result = validateCard({ type: "text", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/id/);
  });

  it("rejects a card with an empty id", () => {
    expect(validateCard({ id: "", type: "text", body: "hi" }).ok).toBe(false);
  });

  it("rejects an unknown card type", () => {
    const result = validateCard({ id: "c1", type: "frobnicate" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown card type/);
  });

  it("rejects non-object input (null / string)", () => {
    expect(validateCard(null).ok).toBe(false);
    expect(validateCard("not a card").ok).toBe(false);
  });

  it("rejects optional title that is not a string", () => {
    expect(validateCard({ id: "c1", type: "text", body: "hi", title: 7 }).ok).toBe(false);
  });

  // --- per-type field guards (white-screen protection) for the KEPT types ---

  it("rejects a text card without a string body", () => {
    expect(validateCard({ id: "v1", type: "text" }).ok).toBe(false);
  });

  it("rejects a status card with a bad state", () => {
    const result = validateCard({ id: "v2", type: "status", label: "build", progress: 0.5, state: "exploded" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/state/);
  });

  it("rejects a status card with non-number progress", () => {
    expect(validateCard({ id: "v2", type: "status", label: "b", progress: "fast", state: "running" }).ok).toBe(false);
  });

  it("rejects an agent-activity card with a bad agent status", () => {
    const r = validateCard({
      id: "v3",
      type: "agent-activity",
      agents: [{ id: "a1", name: "Dev", role: "eng", status: "exploded" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/status/);
  });

  it("rejects a choice card with empty options", () => {
    expect(validateCard({ id: "v4", type: "choice", options: [] }).ok).toBe(false);
  });

  it("rejects a choice option missing id or label", () => {
    expect(validateCard({ id: "v4", type: "choice", options: [{ label: "A" }] }).ok).toBe(false);
    expect(validateCard({ id: "v4", type: "choice", options: [{ id: "a" }] }).ok).toBe(false);
  });

  it("rejects a choice option with non-array meta", () => {
    const r = validateCard({ id: "v4", type: "choice", options: [{ id: "a", label: "A", meta: "nope" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/meta/);
  });

  it("rejects a choice option with a non-string detail/badge", () => {
    expect(validateCard({ id: "v4", type: "choice", options: [{ id: "a", label: "A", detail: 7 }] }).ok).toBe(false);
    expect(validateCard({ id: "v4", type: "choice", options: [{ id: "a", label: "A", badge: {} }] }).ok).toBe(false);
  });

  it("rejects an approval card without a string summary", () => {
    expect(validateCard({ id: "v5", type: "approval" }).ok).toBe(false);
  });

  it("rejects an approval card with non-array details", () => {
    const r = validateCard({ id: "v5", type: "approval", summary: "ok", details: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/details/);
  });

  it("rejects an approval card whose detail item lacks string v", () => {
    expect(validateCard({ id: "v5", type: "approval", summary: "ok", details: [{ k: "A", v: 7 }] }).ok).toBe(false);
  });
});

describe("validateCard — restored rich types (mission control)", () => {
  it("accepts a link card", () => {
    const r = validateCard({ id: "l1", type: "link", url: "https://example.com", label: "Example" })
    expect(r.ok).toBe(true)
  })
  it("rejects a link card without url", () => {
    const r = validateCard({ id: "l1", type: "link", label: "Example" })
    expect(r.ok).toBe(false)
  })
  it("accepts stat / list / image / image-grid / comparison / keyvalue / diff", () => {
    const cards = [
      { id: "s1", type: "stat", value: "42", label: "Users" },
      { id: "li1", type: "list", items: [{ text: "one" }] },
      { id: "i1", type: "image", src: "https://x/y.png" },
      { id: "ig1", type: "image-grid", images: [{ src: "https://x/y.png" }] },
      { id: "c1", type: "comparison", columns: ["A", "B"], rows: [{ label: "p", cells: ["1", "2"] }] },
      { id: "k1", type: "keyvalue", rows: [{ k: "Uptime", v: "99%" }] },
      { id: "d1", type: "diff", hunks: [{ before: "a", after: "b" }] },
    ]
    for (const c of cards) expect(validateCard(c).ok, c.type as string).toBe(true)
  })
  it("rejects malformed restored types", () => {
    expect(validateCard({ id: "s1", type: "stat", value: "42" }).ok).toBe(false) // no label
    expect(validateCard({ id: "i1", type: "image" }).ok).toBe(false) // no src
    expect(validateCard({ id: "c1", type: "comparison", columns: "A", rows: [] }).ok).toBe(false)
  })
  it("validates the optional stat delta shape", () => {
    const base = { id: "s1", type: "stat", value: "42", label: "Users" }
    expect(validateCard({ ...base, delta: { dir: "up", value: "+3" } }).ok).toBe(true)
    expect(validateCard({ ...base, delta: { dir: "up", value: { nested: true } } }).ok).toBe(false)
    expect(validateCard({ ...base, delta: { dir: "sideways", value: "+3" } }).ok).toBe(false)
  })
})

describe("validateCardPatch", () => {
  it("accepts an empty patch and simple scalar patches", () => {
    expect(validateCardPatch({}).ok).toBe(true);
    expect(validateCardPatch({ title: "X", badge: "DONE", progress: 0.7 }).ok).toBe(true);
    expect(validateCardPatch({ state: "done" }).ok).toBe(true);
  });

  it("rejects non-object patches", () => {
    expect(validateCardPatch(null).ok).toBe(false);
    expect(validateCardPatch([]).ok).toBe(false);
    expect(validateCardPatch("nope").ok).toBe(false);
  });

  it("rejects a malformed scalar / status patch", () => {
    expect(validateCardPatch({ title: 7 }).ok).toBe(false);
    expect(validateCardPatch({ progress: "fast" }).ok).toBe(false);
    expect(validateCardPatch({ state: "exploded" }).ok).toBe(false);
  });

  it("rejects unsafe URL-scheme patches while allowing safe link and image URLs", () => {
    expect(validateCardPatch({ url: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateCardPatch({ src: "file:///etc/passwd" }).ok).toBe(false);
    expect(validateCardPatch({ url: "https://example.com/report" }).ok).toBe(true);
    expect(validateCardPatch({ src: "data:image/png;base64,AA==" }).ok).toBe(true);
  });

  it("rejects malformed nested fields (the post-pass injection vector)", () => {
    expect(validateCardPatch({ details: "nope" }).ok).toBe(false);
    expect(validateCardPatch({ details: [{ k: "A", v: 1 }] }).ok).toBe(false);
    expect(validateCardPatch({ options: [{ id: "a", label: "A", meta: "x" }] }).ok).toBe(false);
  });

  it("accepts valid nested patches (choice options, approval details)", () => {
    expect(validateCardPatch({ options: [{ id: "a", label: "A" }] }).ok).toBe(true);
    expect(validateCardPatch({ details: [{ k: "A", v: "B" }] }).ok).toBe(true);
  });
});
