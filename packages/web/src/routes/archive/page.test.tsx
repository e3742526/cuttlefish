import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import type { ProjectArchive, ProjectArchiveDetail } from "@/lib/api"
import { runAxe, formatViolations } from "@/test/axe"

const archiveState = vi.hoisted(() => ({
  archives: [] as ProjectArchive[],
  archivesLoading: false,
  archivesError: null as Error | null,
  detail: null as ProjectArchiveDetail | null,
  detailLoading: false,
  detailError: null as Error | null,
}))

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/context/breadcrumb-context", () => ({
  useBreadcrumbs: () => undefined,
}))

vi.mock("@/hooks/use-archives", () => ({
  useArchives: () => ({
    data: archiveState.archives,
    isLoading: archiveState.archivesLoading,
    error: archiveState.archivesError,
  }),
  useArchive: () => ({
    data: archiveState.detail,
    isLoading: archiveState.detailLoading,
    error: archiveState.detailError,
  }),
  useDeleteArchive: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}))

import ArchivePage from "./page"

describe("ArchivePage", () => {
  beforeEach(() => {
    archiveState.archives = []
    archiveState.archivesLoading = false
    archiveState.archivesError = null
    archiveState.detail = null
    archiveState.detailLoading = false
    archiveState.detailError = null
  })

  it("renders a visible list error instead of the empty state when archive loading fails", () => {
    archiveState.archivesError = new Error("archive fetch failed")

    render(<ArchivePage />)

    expect(screen.getByText("archive fetch failed")).toBeTruthy()
    expect(screen.queryByText("No previous projects.")).toBeNull()
  })

  it("renders archive summaries and detail when data is available", () => {
    archiveState.archives = [{
      id: "archive-1",
      label: "Saved chat",
      note: "Route coverage",
      kind: "chat",
      sourceRef: "web:archive-route",
      createdAt: "2026-06-26T12:00:00.000Z",
      sessionCount: 1,
    }]
    archiveState.detail = {
      ...archiveState.archives[0],
      sessions: [{
        id: "session-1",
        engine: "claude",
        employee: "cuttlefish",
        model: "sonnet",
        title: "Archived route",
        promptExcerpt: "archive this route",
        source: "web",
        sourceRef: "web:archive-route",
        status: "completed",
        createdAt: "2026-06-26T12:00:00.000Z",
        lastActivity: "2026-06-26T12:05:00.000Z",
        totalCost: 0,
        totalTurns: 2,
        parentSessionId: null,
        messages: [{
          role: "user",
          content: "archive this route",
          timestamp: Date.parse("2026-06-26T12:00:00.000Z"),
        }],
      }],
    }

    render(<ArchivePage />)

    expect(screen.getAllByText("Saved chat")).toHaveLength(2)
    expect(screen.getAllByText("Route coverage")).toHaveLength(2)
    expect(screen.getByText("archive this route")).toBeTruthy()
  })

  it("has no axe-core structural/semantic violations (color-contrast excluded — jsdom has no real paint)", async () => {
    archiveState.archives = [{
      id: "archive-1",
      label: "Saved chat",
      note: "Route coverage",
      kind: "chat",
      sourceRef: "web:archive-route",
      createdAt: "2026-06-26T12:00:00.000Z",
      sessionCount: 1,
    }]

    const { container } = render(<ArchivePage />)
    const violations = await runAxe(container)
    expect(violations, formatViolations(violations)).toEqual([])
  })
})
