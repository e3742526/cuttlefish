import { describe, it, expect } from "vitest"
import { describeRolePolicy, normalizeRolePolicy, normalizeRoles } from "./role-policy"

describe("normalizeRolePolicy", () => {
  it("returns undefined for an empty or blank policy", () => {
    expect(normalizeRolePolicy(undefined)).toBeUndefined()
    expect(normalizeRolePolicy({})).toBeUndefined()
    expect(normalizeRolePolicy({ override: { engine: " ", model: "" }, fallbackChain: [] })).toBeUndefined()
  })

  it("drops incomplete chain rows and strips engine/model from employee targets", () => {
    const out = normalizeRolePolicy({
      fallbackChain: [
        { engine: "codex" }, // incomplete → dropped
        { employee: " sec-reviewer " },
        { engine: " codex ", model: " gpt-5.5 ", effortLevel: "" },
      ],
    })
    expect(out).toEqual({
      fallbackChain: [
        { employee: "sec-reviewer" },
        { engine: "codex", model: "gpt-5.5" },
      ],
    })
  })

  it("caps the chain at the shared maximum", () => {
    const out = normalizeRolePolicy({
      fallbackChain: Array.from({ length: 8 }, (_, i) => ({ engine: "codex", model: `m${i}` })),
    })
    expect(out?.fallbackChain).toHaveLength(5)
  })

  it("keeps only non-empty override fields", () => {
    const out = normalizeRolePolicy({ override: { engine: "codex", model: "", effortLevel: "high" } })
    expect(out).toEqual({ override: { engine: "codex", effortLevel: "high" } })
  })
})

describe("normalizeRoles", () => {
  it("returns undefined when both roles are empty", () => {
    expect(normalizeRoles({}, {})).toBeUndefined()
  })

  it("includes only the configured role", () => {
    const out = normalizeRoles(undefined, { override: { model: "haiku" } })
    expect(out).toEqual({ reviewer: { override: { model: "haiku" } } })
  })
})

describe("describeRolePolicy", () => {
  const inherited = { engine: "claude", model: "opus" }

  it("describes an inherited primary with no failover", () => {
    expect(describeRolePolicy({}, inherited)).toBe("claude/opus (inherited)")
  })

  it("describes an override plus a mixed failover chain in order", () => {
    const text = describeRolePolicy(
      {
        override: { engine: "codex", model: "gpt-5.5" },
        fallbackChain: [{ engine: "claude", model: "haiku" }, { employee: "sec-reviewer" }],
      },
      inherited,
    )
    expect(text).toBe("codex/gpt-5.5 · failover: claude/haiku → @sec-reviewer")
  })
})
