import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getReadSessionWatermarks,
  getReadSessions,
  markSessionRead,
} from "../sidebar-storage"

describe("sidebar read watermarks", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it("migrates legacy read ids without making old messages look new", () => {
    localStorage.setItem("cuttlefish-read-sessions", JSON.stringify(["s-1"]))

    expect(getReadSessionWatermarks(getReadSessions(), 1_000)).toEqual({ "s-1": 1_000 })
  })

  it("advances the watermark whenever the operator views the session", () => {
    markSessionRead("s-1", 1_000)
    markSessionRead("s-1", 2_000)

    expect(getReadSessions().has("s-1")).toBe(true)
    expect(getReadSessionWatermarks(getReadSessions(), 3_000)["s-1"]).toBe(2_000)
  })
})
