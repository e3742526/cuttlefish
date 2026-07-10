import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { BreadcrumbProvider, useBreadcrumbs } from "@/context/breadcrumb-context"
import { PageLayout } from "./page-layout"

vi.mock("./pill-nav", () => ({
  NavRibbon: () => <div>nav-ribbon</div>,
  PillNav: () => <div>pill-nav</div>,
}))

vi.mock("./chat/mobile-tab-bar", () => ({
  MobileTabBar: () => <div>mobile-tab-bar</div>,
}))

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    events: [],
    connected: true,
    connectionSeq: 0,
    skillsVersion: 0,
    subscribe: () => () => {},
  }),
}))

function PageWithBreadcrumb() {
  useBreadcrumbs([{ label: "Approvals" }])
  return <PageLayout><div>content</div></PageLayout>
}

describe("PageLayout", () => {
  it("labels the main landmark from breadcrumbs", () => {
    render(
      <MemoryRouter>
        <BreadcrumbProvider>
          <PageWithBreadcrumb />
        </BreadcrumbProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole("main", { name: "Approvals" })).toBeTruthy()
  })

  it("prefers an explicit mainLabel when provided", () => {
    render(
      <MemoryRouter>
        <BreadcrumbProvider>
          <PageLayout chromeless mainLabel="Chat">
            <div>chat</div>
          </PageLayout>
        </BreadcrumbProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole("main", { name: "Chat" })).toBeTruthy()
  })

  it("renders a skip-to-content link targeting the main landmark", () => {
    render(
      <MemoryRouter>
        <BreadcrumbProvider>
          <PageWithBreadcrumb />
        </BreadcrumbProvider>
      </MemoryRouter>,
    )

    const skipLink = screen.getByRole("link", { name: /skip to main content/i })
    expect(skipLink.getAttribute("href")).toBe("#main-content")
    expect(screen.getByRole("main", { name: "Approvals" }).id).toBe("main-content")
  })
})
