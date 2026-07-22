import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { NavRibbon } from "../pill-nav"
import { NAV_ITEMS } from "@/lib/nav"
import { SettingsProvider } from "@/routes/settings-provider"

const useApprovalsMock = vi.fn<() => { data: Array<{ id: string }> }>(() => ({ data: [] }))

vi.mock("@/hooks/use-approvals", () => ({
  useApprovals: () => useApprovalsMock(),
}))

vi.mock("@/lib/api", () => ({ api: { getOnboarding: () => Promise.resolve({}) } }))

function renderRibbon(props: { listOpen: boolean; path?: string }) {
  return render(
    <MemoryRouter initialEntries={[props.path ?? "/"]}>
      <NavRibbon listOpen={props.listOpen} onToggleList={vi.fn()} />
    </MemoryRouter>,
  )
}

describe("NavRibbon", () => {
  beforeEach(() => {
    useApprovalsMock.mockReturnValue({ data: [] })
  })

  it("renders a brand-only top slot (no fold toggle) when mounted without list props", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/org"]}>
        <NavRibbon />
      </MemoryRouter>,
    )
    // The global (non-chat) rail has no list to fold → no toggle button.
    expect(screen.queryByLabelText("Show chats")).toBeNull()
    expect(screen.queryByLabelText("Hide chats")).toBeNull()
    expect(container.querySelector("[aria-expanded]")).toBeNull()
    // The top slot is a brand mark that links to Command Center.
    expect(container.querySelector('a[href="/command"]')).toBeTruthy()
  })

  it("renders the toggle with a state-aware label", () => {
    const { rerender } = renderRibbon({ listOpen: true })
    expect(screen.getByLabelText("Hide chats")).toBeTruthy()
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <NavRibbon listOpen={false} onToggleList={vi.fn()} />
      </MemoryRouter>,
    )
    const toggle = screen.getByLabelText("Show chats")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  })

  it("renders every nav item as a labelled link", () => {
    renderRibbon({ listOpen: true })
    for (const item of NAV_ITEMS) {
      const link = screen.getByLabelText(item.label)
      expect(link.getAttribute("href")).toBe(item.href)
    }
    expect(screen.queryByLabelText("Command")).toBeNull()
  })

  it("does not render the retired Talk surface", () => {
    const { container } = renderRibbon({ listOpen: true })
    const nav = container.querySelector('nav[aria-label="Primary"]')
    expect(nav).toBeTruthy()
    const links = within(nav as HTMLElement).getAllByRole("link")
    const labels = links.map((node) => node.getAttribute("aria-label"))
    expect(labels).not.toContain("Talk")
  })

  it("marks the active route with aria-current and a non-accent fill", () => {
    renderRibbon({ listOpen: true, path: "/org" })
    const active = screen.getByLabelText("Organization")
    expect(active.getAttribute("aria-current")).toBe("page")
    // Selection is accent-independent: a soft --fill-secondary, never --accent.
    expect(active.className).toContain("fill-secondary")
    expect(active.className).not.toContain("--accent")
    // A non-active item carries no aria-current.
    expect(screen.getByLabelText("Cron").getAttribute("aria-current")).toBeNull()
  })

  it("shows a pending-approvals badge on the approvals icon", () => {
    useApprovalsMock.mockReturnValue({ data: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] })
    renderRibbon({ listOpen: true, path: "/org" })
    expect(screen.getByLabelText("3 approvals waiting")).toBeTruthy()
  })

  it("hides the approvals badge when the approvals-badge notification preference is off", () => {
    useApprovalsMock.mockReturnValue({ data: [{ id: "a1" }] })
    localStorage.setItem(
      "cuttlefish-settings",
      JSON.stringify({ notificationPreferences: { approvals: { badge: false, toast: false } } }),
    )
    render(
      <SettingsProvider>
        <MemoryRouter initialEntries={["/org"]}>
          <NavRibbon listOpen />
        </MemoryRouter>
      </SettingsProvider>,
    )
    expect(screen.queryByLabelText(/approvals? waiting/i)).toBeNull()
  })

  it("keeps the nav brand icon fixed even when the COO icon setting is an avatar id", () => {
    localStorage.setItem("cuttlefish-settings", JSON.stringify({ portalEmoji: "aquatic:octopus" }))
    const { container } = render(
      <SettingsProvider>
        <MemoryRouter initialEntries={["/org"]}>
          <NavRibbon />
        </MemoryRouter>
      </SettingsProvider>,
    )
    const brandImg = container.querySelector('a[href="/command"] img')
    expect(brandImg?.getAttribute("src")).toBe("/brand/cuttlefish_icon_app.svg")
    expect(container.textContent).not.toContain("aquatic:octopus")
  })

  // Chat icon is OPEN-ONLY: reveals a collapsed list while already on /chat,
  // navigates otherwise, never closes.
  describe("Chat icon open-only behavior", () => {
    function renderWith(opts: { listOpen: boolean; path: string; onToggleList: () => void }) {
      render(
        <MemoryRouter initialEntries={[opts.path]}>
          <NavRibbon listOpen={opts.listOpen} onToggleList={opts.onToggleList} />
        </MemoryRouter>,
      )
      return screen.getByLabelText("Chat")
    }

    it("reveals the list when on /chat with the list hidden", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).toHaveBeenCalledTimes(1)
    })

    it("is a no-op when the list is already open on /chat", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: true, path: "/", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).not.toHaveBeenCalled()
    })

    it("navigates (never toggles) when not on /chat", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/org", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).not.toHaveBeenCalled()
    })

    it("does not hijack modified clicks (new tab / window)", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/", onToggleList })
      fireEvent.click(chat, { metaKey: true })
      expect(onToggleList).not.toHaveBeenCalled()
    })
  })
})
