import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { NavRibbon } from "../pill-nav"
import { SettingsProvider } from "@/routes/settings-provider"

// The settings provider hydrates and best-effort syncs the COO name from the
// backend; stub that fetch so the test does no network and stays quiet.
vi.mock("@/lib/api", () => ({ api: { getOnboarding: () => Promise.resolve({}) } }))

function renderRibbon() {
  return render(
    <SettingsProvider>
      <MemoryRouter initialEntries={["/"]}>
        <NavRibbon listOpen onToggleList={vi.fn()} />
      </MemoryRouter>
    </SettingsProvider>,
  )
}

/** jsdom's DataTransfer is incomplete; a Map-backed stub shared across the
 *  dragstart → dragover → drop sequence round-trips setData/getData. */
function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>()
  return {
    dropEffect: "none",
    effectAllowed: "all",
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
  } as unknown as DataTransfer
}

function railLabels(): (string | null)[] {
  const nav = screen.getByRole("navigation", { name: "Primary" })
  return within(nav).getAllByRole("link").map((link) => link.getAttribute("aria-label"))
}

describe("NavRibbon drag-to-reorder", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("reorders the rail on drag-and-drop and persists the new order", () => {
    renderRibbon()

    // Default order: Settings sits after Organization.
    let labels = railLabels()
    expect(labels.indexOf("Settings")).toBeGreaterThan(labels.indexOf("Organization"))

    // Drag Settings and drop it onto the top half of Organization (insert before).
    const dt = makeDataTransfer()
    fireEvent.dragStart(screen.getByLabelText("Settings"), { dataTransfer: dt })
    fireEvent.dragOver(screen.getByLabelText("Organization"), { dataTransfer: dt, clientY: 0 })
    fireEvent.drop(screen.getByLabelText("Organization"), { dataTransfer: dt })

    // The rail now shows Settings before Organization...
    labels = railLabels()
    expect(labels.indexOf("Settings")).toBeLessThan(labels.indexOf("Organization"))

    // ...and the new order is persisted to the settings store.
    const saved = JSON.parse(localStorage.getItem("cuttlefish-settings")!)
    expect(Array.isArray(saved.navOrder)).toBe(true)
    expect(saved.navOrder.indexOf("/settings")).toBeLessThan(saved.navOrder.indexOf("/org"))
    // Talk is never part of the reorderable set.
    expect(saved.navOrder).not.toContain("/talk")
  })

  it("restores a persisted custom order on a fresh mount (reload path)", async () => {
    localStorage.setItem("cuttlefish-settings", JSON.stringify({ navOrder: ["/settings"] }))
    renderRibbon()

    // The provider hydrates from localStorage in an effect; once it does, the rail
    // reflects the custom order (Settings pulled to the front, before Organization).
    await waitFor(() => {
      const labels = railLabels()
      expect(labels.indexOf("Settings")).toBeLessThan(labels.indexOf("Organization"))
    })
  })

  it("keeps Talk docked below the main icons even after a reorder", () => {
    renderRibbon()
    const dt = makeDataTransfer()
    fireEvent.dragStart(screen.getByLabelText("Settings"), { dataTransfer: dt })
    fireEvent.dragOver(screen.getByLabelText("Organization"), { dataTransfer: dt, clientY: 0 })
    fireEvent.drop(screen.getByLabelText("Organization"), { dataTransfer: dt })

    const labels = railLabels()
    // Talk stays in the footer cluster — after every primary item, incl. Settings.
    expect(labels.indexOf("Talk")).toBeGreaterThan(labels.indexOf("Settings"))
  })
})
