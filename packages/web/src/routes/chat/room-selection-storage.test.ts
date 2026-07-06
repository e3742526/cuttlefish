import { beforeEach, describe, expect, it } from "vitest"
import {
  clearSelectedRoomId,
  loadSelectedRoomId,
  saveSelectedRoomId,
} from "./room-selection-storage"

describe("room selection storage", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips the selected room id", () => {
    expect(loadSelectedRoomId()).toBeNull()

    saveSelectedRoomId("qa")

    expect(loadSelectedRoomId()).toBe("qa")
  })

  it("clears the selected room id", () => {
    saveSelectedRoomId("dataflow")

    clearSelectedRoomId()

    expect(loadSelectedRoomId()).toBeNull()
  })

  it("treats blank stored values as no selected room", () => {
    localStorage.setItem("cuttlefish-chat-selected-room", "   ")

    expect(loadSelectedRoomId()).toBeNull()
  })
})
