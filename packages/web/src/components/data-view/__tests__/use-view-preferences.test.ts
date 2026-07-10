import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useViewPreferences } from "../use-view-preferences"

describe("useViewPreferences", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("starts with sane defaults", () => {
    const { result } = renderHook(() => useViewPreferences("test-surface"))
    expect(result.current.preferences).toEqual({
      density: "comfortable",
      hiddenColumns: [],
      savedViews: [],
      pinnedViewId: null,
    })
  })

  it("namespaces storage per surface key", () => {
    const { result: a } = renderHook(() => useViewPreferences("surface-a"))
    act(() => a.current.setDensity("compact"))

    const { result: b } = renderHook(() => useViewPreferences("surface-b"))
    expect(b.current.preferences.density).toBe("comfortable")
    expect(localStorage.getItem("fleetview.prefs.v1:dataview.surface-a")).toContain("compact")
    expect(localStorage.getItem("fleetview.prefs.v1:dataview.surface-b")).toBeNull()
  })

  it("persists density across a fresh mount", () => {
    const { result, unmount } = renderHook(() => useViewPreferences("persist-density"))
    act(() => result.current.setDensity("compact"))
    unmount()

    const { result: remounted } = renderHook(() => useViewPreferences("persist-density"))
    expect(remounted.current.preferences.density).toBe("compact")
  })

  it("persists hidden columns", () => {
    const { result } = renderHook(() => useViewPreferences("hidden-cols"))
    act(() => result.current.setHiddenColumns(["provider", "family"]))
    expect(result.current.preferences.hiddenColumns).toEqual(["provider", "family"])
  })

  it("saves, applies (via presence), and deletes named views", () => {
    const { result } = renderHook(() => useViewPreferences<{ q: string }>("saved-views"))
    let id = ""
    act(() => {
      id = result.current.saveView({
        name: "Errors only",
        filters: { q: "error" },
        sort: { key: "timestamp", direction: "desc" },
        hiddenColumns: ["level"],
      })
    })
    expect(result.current.preferences.savedViews).toHaveLength(1)
    expect(result.current.preferences.savedViews[0]).toMatchObject({ id, name: "Errors only" })

    act(() => result.current.pinView(id))
    expect(result.current.preferences.pinnedViewId).toBe(id)

    act(() => result.current.deleteView(id))
    expect(result.current.preferences.savedViews).toHaveLength(0)
    // Deleting the pinned view clears the pin too.
    expect(result.current.preferences.pinnedViewId).toBeNull()
  })

  it("resets to defaults", () => {
    const { result } = renderHook(() => useViewPreferences("reset-me"))
    act(() => result.current.setDensity("compact"))
    act(() => result.current.setHiddenColumns(["a"]))
    act(() => result.current.resetToDefaults())
    expect(result.current.preferences).toEqual({
      density: "comfortable",
      hiddenColumns: [],
      savedViews: [],
      pinnedViewId: null,
    })
  })

  it("syncs across tabs via the storage event", () => {
    const { result } = renderHook(() => useViewPreferences("multi-tab"))
    expect(result.current.preferences.density).toBe("comfortable")

    // Simulate another tab writing to the same key and firing `storage`.
    const next = { density: "compact", hiddenColumns: [], savedViews: [], pinnedViewId: null }
    localStorage.setItem("fleetview.prefs.v1:dataview.multi-tab", JSON.stringify(next))
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "fleetview.prefs.v1:dataview.multi-tab", newValue: JSON.stringify(next) }),
      )
    })
    expect(result.current.preferences.density).toBe("compact")
  })

  it("ignores storage events for a different surface's key", () => {
    const { result } = renderHook(() => useViewPreferences("surface-x"))
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "fleetview.prefs.v1:dataview.surface-y", newValue: "{}" }),
      )
    })
    expect(result.current.preferences.density).toBe("comfortable")
  })

  it("falls back to defaults on corrupt stored JSON", () => {
    localStorage.setItem("fleetview.prefs.v1:dataview.corrupt", "{not json")
    const { result } = renderHook(() => useViewPreferences("corrupt"))
    expect(result.current.preferences.density).toBe("comfortable")
  })

  it("degrades gracefully when localStorage.setItem throws", () => {
    const { result } = renderHook(() => useViewPreferences("quota-full"))
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    act(() => result.current.setDensity("compact"))
    // In-memory state still updates even though persistence failed.
    expect(result.current.preferences.density).toBe("compact")
    spy.mockRestore()
  })
})
