import { describe, expect, it } from "vitest"
import { formatFallbackChain, formatLineList, parseFallbackChain, parseLineList } from "./settings-config"

describe("settings-config helpers", () => {
  it("round-trips newline-separated workspace roots", () => {
    const text = formatLineList(["/tmp/project-a", "/tmp/project-b"])
    expect(text).toBe("/tmp/project-a\n/tmp/project-b")
    expect(parseLineList(text)).toEqual(["/tmp/project-a", "/tmp/project-b"])
    expect(parseLineList(" \n ")).toBeUndefined()
  })

  it("round-trips pipe-delimited fallback chain rows", () => {
    const text = formatFallbackChain([
      { engine: "codex", model: "gpt-5.5", effortLevel: "high" },
      { engine: "claude", model: "claude-sonnet-5", reason: "balanced backup" },
    ])
    expect(text).toBe("codex | gpt-5.5 | high\nclaude | claude-sonnet-5 |  |  | balanced backup")
    expect(parseFallbackChain(text)).toEqual([
      { engine: "codex", model: "gpt-5.5", effortLevel: "high" },
      { engine: "claude", model: "claude-sonnet-5", reason: "balanced backup" },
    ])
  })
})
