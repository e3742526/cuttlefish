import { describe, expect, it } from "vitest"
import type { Employee } from "@/lib/api"
import type { DepartmentRoom } from "@/lib/rooms/types"
import type { Session, ViewMode } from "../sidebar-types"
import {
  buildSidebarCollections,
  buildSidebarOrder,
  buildVirtualItems,
  CRON_GROUP,
  DIRECT_GROUP,
  formatOlderLineLabel,
} from "../sidebar-view-model"

const employeeData = new Map<string, Employee>([
  ["alice", { name: "alice", displayName: "Alice Dev", department: "platform", rank: "employee", engine: "claude", model: "opus", persona: "" }],
  ["bob", { name: "bob", displayName: "Bob Lead", department: "ops", rank: "manager", engine: "claude", model: "opus", persona: "" }],
])

function makeSession(id: string, partial: Partial<Session>): Session {
  return {
    id,
    source: "web",
    sourceRef: `web:${id}`,
    createdAt: "2026-06-22T09:00:00.000Z",
    lastActivity: "2026-06-22T09:00:00.000Z",
    ...partial,
  }
}

function buildCollections(opts: {
  sessions: Session[]
  counts?: Record<string, number>
  pinned?: Set<string>
  viewMode?: ViewMode
  search?: string
  searchResults?: Session[]
  now?: Date
}) {
  return buildSidebarCollections({
    sessions: opts.sessions,
    search: opts.search ?? "",
    searchResults: opts.searchResults,
    employeeData,
    portalSlug: "cuttlefish",
    portalName: "Cuttlefish",
    pinnedSessions: opts.pinned ?? new Set<string>(),
    counts: opts.counts ?? {},
    viewMode: opts.viewMode ?? "all",
    now: opts.now,
  })
}

describe("sidebar view model", () => {
  it("keeps focused older bucketing separate from all-mode older summary math", () => {
    const now = new Date("2026-06-22T12:00:00.000Z")
    const sessions = [
      makeSession("today-top", { employee: "alice", lastActivity: "2026-06-22T11:00:00.000Z" }),
      makeSession("older-top", { employee: "alice", lastActivity: "2026-06-20T11:00:00.000Z" }),
      makeSession("older-child", { employee: "bob", parentSessionId: "parent-1", lastActivity: "2026-06-20T10:00:00.000Z" }),
    ]

    const focused = buildCollections({
      sessions,
      counts: { alice: 2, bob: 1 },
      viewMode: "focused",
      now,
    })
    expect(focused.hiddenAutomated).toBe(1)
    expect(focused.olderFocusedRows.map((row) => row.session.id)).toEqual(["older-top"])
    expect(focused.olderSummary).toEqual({ chats: 1, employees: 1 })

    const all = buildCollections({
      sessions,
      counts: { alice: 2, bob: 1 },
      viewMode: "all",
      now,
    })
    expect(all.hiddenAutomated).toBe(0)
    expect(all.olderSummary).toEqual({ chats: 2, employees: 2 })
  })

  it("groups direct sessions under the portal slug and keeps cron in the scheduled bucket", () => {
    const sessions = [
      makeSession("direct", { employee: "cuttlefish", lastActivity: "2026-06-21T09:00:00.000Z" }),
      makeSession("worker", { employee: "alice", lastActivity: "2026-06-21T08:00:00.000Z" }),
      makeSession("cron-run", { source: "cron", sourceRef: "cron:daily", lastActivity: "2026-06-21T07:00:00.000Z" }),
    ]

    const collections = buildCollections({
      sessions,
      counts: { [DIRECT_GROUP]: 1, alice: 1, [CRON_GROUP]: 1 },
      viewMode: "all",
      now: new Date("2026-06-22T12:00:00.000Z"),
    })

    expect(collections.cronSessions.map((session) => session.id)).toEqual(["cron-run"])
    expect(collections.cronTotal).toBe(1)
    expect(collections.unpinnedFlat.map((item) => item.employeeName)).toEqual(["cuttlefish", "alice"])
    expect(collections.unpinnedFlat[0].groupKey).toBe(DIRECT_GROUP)
  })

  it("splits older employee groups into pinned and unpinned buckets", () => {
    const sessions = [
      makeSession("alice-today", { employee: "alice", lastActivity: "2026-06-22T10:00:00.000Z" }),
      makeSession("alice-old", { employee: "alice", lastActivity: "2026-06-19T10:00:00.000Z" }),
      makeSession("bob-old", { employee: "bob", lastActivity: "2026-06-19T09:00:00.000Z" }),
    ]

    const collections = buildCollections({
      sessions,
      counts: { alice: 2, bob: 1 },
      pinned: new Set(["emp:alice"]),
      viewMode: "all",
      now: new Date("2026-06-22T12:00:00.000Z"),
    })

    expect(collections.olderPinned.map((item) => item.employeeName)).toEqual(["alice"])
    expect(collections.olderUnpinned.map((item) => item.employeeName)).toEqual(["bob"])
  })

  it("builds keyboard order with collapsed vs expanded older employees deterministically", () => {
    const sessions = [
      makeSession("today", { employee: "alice", lastActivity: "2026-06-22T10:00:00.000Z" }),
      makeSession("alice-old-1", { employee: "alice", lastActivity: "2026-06-19T10:00:00.000Z" }),
      makeSession("alice-old-2", { employee: "alice", lastActivity: "2026-06-18T10:00:00.000Z" }),
      makeSession("cron-run", { source: "cron", sourceRef: "cron:daily", lastActivity: "2026-06-17T10:00:00.000Z" }),
    ]

    const collections = buildCollections({
      sessions,
      counts: { alice: 3, [CRON_GROUP]: 1 },
      viewMode: "all",
      now: new Date("2026-06-22T12:00:00.000Z"),
    })

    const collapsedOrder = buildSidebarOrder({
      searching: collections.searching,
      searchRows: collections.searchRows,
      viewMode: "all",
      rooms: [],
      sortedCron: collections.sortedCron,
      pinnedFlat: collections.pinnedFlat,
      unpinnedFlat: collections.unpinnedFlat,
      todayRows: collections.todayRows,
      yesterdayRows: collections.yesterdayRows,
      olderExpanded: true,
      olderFocusedRows: collections.olderFocusedRows,
      olderPinned: collections.olderPinned,
      olderUnpinned: collections.olderUnpinned,
      expanded: { alice: false },
    })
    expect(collapsedOrder.sessionIds).toEqual(["today", "cron-run"])

    const expandedOrder = buildSidebarOrder({
      ...collapsedOrder,
      searching: collections.searching,
      searchRows: collections.searchRows,
      viewMode: "all",
      rooms: [],
      sortedCron: collections.sortedCron,
      pinnedFlat: collections.pinnedFlat,
      unpinnedFlat: collections.unpinnedFlat,
      todayRows: collections.todayRows,
      yesterdayRows: collections.yesterdayRows,
      olderExpanded: true,
      olderFocusedRows: collections.olderFocusedRows,
      olderPinned: collections.olderPinned,
      olderUnpinned: collections.olderUnpinned,
      expanded: { alice: true },
    })
    expect(expandedOrder.sessionIds).toEqual(["today", "alice-old-1", "alice-old-2", "cron-run"])
  })

  it("builds room-mode virtual items in room-first then scheduled order", () => {
    const rooms: DepartmentRoom[] = [
      {
        id: "platform",
        name: "Platform",
        departmentId: "platform",
        isUnassigned: false,
        sessions: [makeSession("room-1", { employee: "alice", lastActivity: "2026-06-22T10:00:00.000Z" })],
        participants: [],
        sessionCount: 1,
        participantCount: 1,
        lastActivity: "2026-06-22T10:00:00.000Z",
        runningCount: 0,
        status: "idle",
      },
      {
        id: "ops",
        name: "Ops",
        departmentId: "ops",
        isUnassigned: false,
        sessions: [makeSession("room-2", { employee: "bob", lastActivity: "2026-06-22T09:00:00.000Z" })],
        participants: [],
        sessionCount: 1,
        participantCount: 1,
        lastActivity: "2026-06-22T09:00:00.000Z",
        runningCount: 0,
        status: "idle",
      },
    ]

    const collections = buildCollections({
      sessions: [
        makeSession("room-1", { employee: "alice" }),
        makeSession("room-2", { employee: "bob" }),
        makeSession("cron-run", { source: "cron", sourceRef: "cron:daily", lastActivity: "2026-06-20T07:00:00.000Z" }),
      ],
      counts: { alice: 1, bob: 1, [CRON_GROUP]: 1 },
      viewMode: "rooms",
      now: new Date("2026-06-22T12:00:00.000Z"),
    })

    const items = buildVirtualItems({
      searching: collections.searching,
      searchRows: collections.searchRows,
      viewMode: "rooms",
      rooms,
      expandedRooms: new Set(["platform"]),
      cronSessions: collections.cronSessions,
      cronCollapsed: false,
      sortedCron: collections.sortedCron,
      cronTotal: collections.cronTotal,
      todayRows: collections.todayRows,
      yesterdayRows: collections.yesterdayRows,
      olderSummary: collections.olderSummary,
      olderExpanded: false,
      olderFocusedRows: collections.olderFocusedRows,
      olderPinned: collections.olderPinned,
      olderUnpinned: collections.olderUnpinned,
      pinnedFlat: collections.pinnedFlat,
      unpinnedFlat: collections.unpinnedFlat,
      portalSlug: "cuttlefish",
      portalName: "Cuttlefish",
      employeeData,
    })

    expect(items.map((item) => item.kind)).toEqual([
      "room-header",
      "flat",
      "room-header",
      "cron-header",
      "cron-session",
    ])
  })

  it("formats the older summary line with and without employee counts", () => {
    expect(formatOlderLineLabel({ chats: 1, employees: 0 })).toBe("Older · 1 chat")
    expect(formatOlderLineLabel({ chats: 4, employees: 2 })).toBe("Older · 4 chats across 2 employees")
  })

  it("renders one expandable agent row in All view instead of repeating recent child sessions", () => {
    const collections = buildCollections({
      sessions: [
        makeSession("alice-child-1", { employee: "alice", parentSessionId: "manager-1", lastActivity: "2026-06-22T11:00:00.000Z" }),
        makeSession("alice-child-2", { employee: "alice", parentSessionId: "manager-2", lastActivity: "2026-06-22T10:00:00.000Z" }),
        makeSession("bob-child", { employee: "bob", parentSessionId: "manager-1", lastActivity: "2026-06-21T10:00:00.000Z" }),
      ],
      counts: { alice: 2, bob: 1 },
      viewMode: "all",
      now: new Date("2026-06-22T12:00:00.000Z"),
    })

    const items = buildVirtualItems({
      searching: collections.searching,
      searchRows: collections.searchRows,
      viewMode: "all",
      rooms: [],
      expandedRooms: new Set(),
      cronSessions: collections.cronSessions,
      cronCollapsed: false,
      sortedCron: collections.sortedCron,
      cronTotal: collections.cronTotal,
      todayRows: collections.todayRows,
      yesterdayRows: collections.yesterdayRows,
      olderSummary: collections.olderSummary,
      olderExpanded: false,
      olderFocusedRows: collections.olderFocusedRows,
      olderPinned: collections.olderPinned,
      olderUnpinned: collections.olderUnpinned,
      pinnedFlat: collections.pinnedFlat,
      unpinnedFlat: collections.unpinnedFlat,
      portalSlug: "cuttlefish",
      portalName: "Cuttlefish",
      employeeData,
    })

    expect(items.map((item) => item.kind)).toEqual(["section", "employee", "employee"])
    expect(items[0]).toEqual({ kind: "section", id: "agents", label: "Agents", count: 2 })
    expect(items.slice(1).map((item) => item.kind === "employee" ? item.item.employeeName : null)).toEqual(["alice", "bob"])

    const collapsed = buildSidebarOrder({
      searching: false,
      searchRows: [],
      viewMode: "all",
      rooms: [],
      sortedCron: [],
      pinnedFlat: collections.pinnedFlat,
      unpinnedFlat: collections.unpinnedFlat,
      todayRows: collections.todayRows,
      yesterdayRows: collections.yesterdayRows,
      olderExpanded: false,
      olderFocusedRows: [],
      olderPinned: [],
      olderUnpinned: [],
      expanded: {},
    })
    expect(collapsed.sessionIds).toEqual(["alice-child-1", "bob-child"])

    const expanded = buildSidebarOrder({
      searching: false,
      searchRows: [],
      viewMode: "all",
      rooms: [],
      sortedCron: [],
      pinnedFlat: collections.pinnedFlat,
      unpinnedFlat: collections.unpinnedFlat,
      todayRows: collections.todayRows,
      yesterdayRows: collections.yesterdayRows,
      olderExpanded: false,
      olderFocusedRows: [],
      olderPinned: [],
      olderUnpinned: [],
      expanded: { alice: true },
    })
    expect(expanded.sessionIds).toEqual(["alice-child-1", "alice-child-2", "bob-child"])
  })
})
