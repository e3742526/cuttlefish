import type { Employee } from "@/lib/api"
import type { DepartmentRoom } from "@/lib/rooms/types"
import {
  bucketByDay,
  isFocusedSession,
  mergeSidebarEmployees,
  summarizeOlder,
} from "@/components/chat/chat-route-helpers"
import {
  getSessionActivity,
  isCronSession,
  isDirectSession,
  isVisibleSource,
  resolveRowIdentity,
  sortSessionsByActivity,
} from "./sidebar-session-helpers"
import type {
  FlatItem,
  FlatRow,
  Session,
  SidebarOrder,
  ViewMode,
} from "./sidebar-types"

export const DIRECT_GROUP = "__direct__"
export const CRON_GROUP = "__cron__"
export const VIRTUALIZE_THRESHOLD = 50

export interface OlderSummary {
  chats: number
  employees: number
}

export interface SidebarCollections {
  searching: boolean
  searchRows: FlatRow[]
  todayRows: FlatRow[]
  yesterdayRows: FlatRow[]
  olderSummary: OlderSummary
  olderFocusedRows: FlatRow[]
  hiddenAutomated: number
  olderPinned: FlatItem[]
  olderUnpinned: FlatItem[]
  pinnedFlat: FlatItem[]
  unpinnedFlat: FlatItem[]
  sortedCron: Session[]
  cronSessions: Session[]
  cronTotal: number
}

export type VirtualItem =
  | { kind: "section"; id: string; label: string; count?: number }
  | { kind: "flat"; row: FlatRow }
  | { kind: "older-line" }
  | { kind: "older-header" }
  | { kind: "employee"; item: FlatItem }
  | { kind: "room-header"; room: DepartmentRoom }
  | { kind: "cron-header" }
  | { kind: "cron-session"; session: Session }
  | { kind: "cron-more" }

export function buildVisibleSessions(rawSessions: Session[] | undefined): Session[] {
  if (!rawSessions) return []
  const filtered = rawSessions.filter(isVisibleSource)
  filtered.sort((a, b) => {
    const ta = a.lastActivity || a.createdAt || ""
    const tb = b.lastActivity || b.createdAt || ""
    return tb.localeCompare(ta)
  })
  return filtered
}

function buildPortalEmployee(portalSlug: string, portalName: string): Employee {
  return {
    name: portalSlug,
    displayName: portalName,
    emoji: "\u{1F4AC}",
    department: "direct",
    role: "",
    rank: "manager",
    engine: "",
    model: "",
    persona: "",
  } as Employee
}

export function buildSidebarCollections({
  sessions,
  search,
  searchResults,
  employeeData,
  portalSlug,
  portalName,
  pinnedSessions,
  counts,
  viewMode,
  now = new Date(),
}: {
  sessions: Session[]
  search: string
  searchResults: Session[] | undefined
  employeeData: Map<string, Employee>
  portalSlug: string
  portalName: string
  pinnedSessions: Set<string>
  counts: Record<string, number>
  viewMode: ViewMode
  now?: Date
}): SidebarCollections {
  const searching = search.trim().length > 0
  const displayed = searching
    ? (searchResults ?? []).filter(isVisibleSource)
    : sessions

  const toRow = (session: Session): FlatRow => ({
    session,
    ...resolveRowIdentity(session, { portalSlug, portalName, employeeData }),
  })

  if (searching) {
    return {
      searching,
      searchRows: sortSessionsByActivity(displayed).map(toRow),
      todayRows: [],
      yesterdayRows: [],
      olderSummary: { chats: 0, employees: 0 },
      olderFocusedRows: [],
      hiddenAutomated: 0,
      olderPinned: [],
      olderUnpinned: [],
      pinnedFlat: [],
      unpinnedFlat: [],
      sortedCron: [],
      cronSessions: [],
      cronTotal: 0,
    }
  }

  const focused = viewMode === "focused"
  const cronSessions: Session[] = []
  const directSessions: Session[] = []
  const employeeSessionMap = new Map<string, Session[]>()
  const todayRows: FlatRow[] = []
  const yesterdayRows: FlatRow[] = []
  const olderFocusedRows: FlatRow[] = []
  let hiddenAutomated = 0
  const recentByGroup: Record<string, number> = {}

  for (const session of displayed) {
    if (isCronSession(session)) {
      cronSessions.push(session)
      continue
    }
    const direct = isDirectSession(session, portalSlug)
    const groupKey = direct ? DIRECT_GROUP : session.employee!
    if (direct) directSessions.push(session)
    else {
      if (!employeeSessionMap.has(groupKey)) employeeSessionMap.set(groupKey, [])
      employeeSessionMap.get(groupKey)!.push(session)
    }
    if (focused && !isFocusedSession(session)) {
      hiddenAutomated += 1
      continue
    }
    const bucket = bucketByDay(getSessionActivity(session), now)
    if (bucket === "today") {
      todayRows.push(toRow(session))
      recentByGroup[groupKey] = (recentByGroup[groupKey] ?? 0) + 1
    } else if (bucket === "yesterday") {
      yesterdayRows.push(toRow(session))
      recentByGroup[groupKey] = (recentByGroup[groupKey] ?? 0) + 1
    } else if (focused) {
      olderFocusedRows.push(toRow(session))
    }
  }

  todayRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))
  yesterdayRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))
  olderFocusedRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))

  const flatItems: FlatItem[] = []
  for (const [empName, empSessions] of employeeSessionMap) {
    const sorted = sortSessionsByActivity(empSessions)
    flatItems.push({
      type: "employee",
      employeeName: empName,
      employeeData: employeeData.get(empName),
      sessions: sorted,
      sortKey: getSessionActivity(sorted[0]),
      pinKey: `emp:${empName}`,
      groupKey: empName,
      total: counts[empName] ?? sorted.length,
    })
  }
  if (directSessions.length > 0) {
    const sorted = sortSessionsByActivity(directSessions)
    flatItems.push({
      type: "employee",
      employeeName: portalSlug,
      employeeData: buildPortalEmployee(portalSlug, portalName),
      sessions: sorted,
      sortKey: getSessionActivity(sorted[0]),
      pinKey: `emp:${portalSlug}`,
      groupKey: DIRECT_GROUP,
      total: counts[DIRECT_GROUP] ?? sorted.length,
    })
  }

  const pinnedFlat = flatItems
    .filter((item) => pinnedSessions.has(item.pinKey))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  const unpinnedFlat = flatItems
    .filter((item) => !pinnedSessions.has(item.pinKey))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))

  const hasOlder = (item: FlatItem) =>
    (item.total ?? item.sessions!.length) - (recentByGroup[item.groupKey ?? item.employeeName!] ?? 0) > 0
  const olderPinned = pinnedFlat.filter(hasOlder)
  const olderUnpinned = unpinnedFlat.filter(hasOlder)

  let olderSummary: OlderSummary
  if (focused) {
    const employees = new Set<string>()
    for (const row of olderFocusedRows) {
      if (!isDirectSession(row.session, portalSlug) && row.session.employee) {
        employees.add(row.session.employee)
      }
    }
    olderSummary = { chats: olderFocusedRows.length, employees: employees.size }
  } else {
    const nonCronTotals: Record<string, number> = {}
    for (const [group, total] of Object.entries(counts)) {
      if (group !== CRON_GROUP) nonCronTotals[group] = total
    }
    olderSummary = summarizeOlder(nonCronTotals, recentByGroup, new Set([DIRECT_GROUP]))
  }

  const sortedCron = sortSessionsByActivity(cronSessions)
  const cronTotal = counts[CRON_GROUP] ?? cronSessions.length

  return {
    searching,
    searchRows: [],
    todayRows,
    yesterdayRows,
    olderSummary,
    olderFocusedRows,
    hiddenAutomated,
    olderPinned,
    olderUnpinned,
    pinnedFlat,
    unpinnedFlat,
    sortedCron,
    cronSessions,
    cronTotal,
  }
}

export function buildContactableEmployees({
  search,
  pinnedFlat,
  unpinnedFlat,
  orgEmployees,
  employeeData,
  portalSlug,
}: {
  search: string
  pinnedFlat: FlatItem[]
  unpinnedFlat: FlatItem[]
  orgEmployees: Employee[]
  employeeData: Map<string, Employee>
  portalSlug: string
}): Employee[] {
  if (search.trim()) return []
  const sessionful = [...pinnedFlat, ...unpinnedFlat]
    .map((item) => item.employeeName)
    .filter((name): name is string => !!name)
  const sessionfulSet = new Set(sessionful)
  const rosterNames = orgEmployees.map((employee) => employee.name)
  const merged = mergeSidebarEmployees(sessionful, rosterNames)
  return merged
    .filter((name) => !sessionfulSet.has(name) && name !== portalSlug)
    .map((name) => employeeData.get(name))
    .filter((employee): employee is Employee => !!employee)
}

export function buildManagerEmployees({
  search,
  orgEmployees,
  portalSlug,
}: {
  search: string
  orgEmployees: Employee[]
  portalSlug: string
}): Employee[] {
  if (search.trim()) return []
  return orgEmployees
    .filter((employee) => (employee.rank === "manager" || employee.rank === "executive") && employee.name !== portalSlug)
    .sort((a, b) => {
      const ra = a.rank === "executive" ? 0 : 1
      const rb = b.rank === "executive" ? 0 : 1
      return ra - rb || (a.displayName || a.name).localeCompare(b.displayName || b.name)
    })
}

export function buildSidebarOrder({
  searching,
  searchRows,
  viewMode,
  rooms,
  sortedCron,
  pinnedFlat,
  unpinnedFlat,
  todayRows,
  yesterdayRows,
  olderExpanded,
  olderFocusedRows,
  olderPinned,
  olderUnpinned,
  expanded,
}: {
  searching: boolean
  searchRows: FlatRow[]
  viewMode: ViewMode
  rooms: DepartmentRoom[]
  sortedCron: Session[]
  pinnedFlat: FlatItem[]
  unpinnedFlat: FlatItem[]
  todayRows: FlatRow[]
  yesterdayRows: FlatRow[]
  olderExpanded: boolean
  olderFocusedRows: FlatRow[]
  olderPinned: FlatItem[]
  olderUnpinned: FlatItem[]
  expanded: Record<string, boolean>
}): SidebarOrder {
  const sessionIds: string[] = []
  const seen = new Set<string>()
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id)
      sessionIds.push(id)
    }
  }

  if (searching) {
    for (const row of searchRows) push(row.session.id)
    return { sessionIds, employeeNames: [], employeeSessionMap: {} }
  }

  if (viewMode === "rooms") {
    const employeeNames: string[] = []
    const employeeSessionMap: Record<string, string[]> = {}
    for (const room of rooms) {
      for (const session of room.sessions) push(session.id)
    }
    for (const session of sortedCron) push(session.id)
    for (const item of [...pinnedFlat, ...unpinnedFlat]) {
      const name = item.employeeName!
      employeeNames.push(name)
      employeeSessionMap[name] = item.sessions!.map((session) => session.id)
    }
    return { sessionIds, employeeNames, employeeSessionMap }
  }

  if (viewMode === "all") {
    for (const item of [...pinnedFlat, ...unpinnedFlat]) {
      const ids = item.sessions!.map((session) => session.id)
      if (expanded[item.employeeName!]) ids.forEach(push)
      else if (ids.length > 0) push(ids[0])
    }
    for (const session of sortedCron) push(session.id)

    const employeeNames = [...pinnedFlat, ...unpinnedFlat].map((item) => item.employeeName!)
    const employeeSessionMap = Object.fromEntries(
      [...pinnedFlat, ...unpinnedFlat].map((item) => [
        item.employeeName!,
        item.sessions!.map((session) => session.id),
      ]),
    )
    return { sessionIds, employeeNames, employeeSessionMap }
  }

  for (const row of todayRows) push(row.session.id)
  for (const row of yesterdayRows) push(row.session.id)
  if (olderExpanded) {
    if (viewMode === "focused") {
      for (const row of olderFocusedRows) push(row.session.id)
    } else {
      for (const item of [...olderPinned, ...olderUnpinned]) {
        const ids = item.sessions!.map((session) => session.id)
        if (expanded[item.employeeName!]) ids.forEach(push)
        else if (ids.length > 0) push(ids[0])
      }
    }
  }
  for (const session of sortedCron) push(session.id)

  const employeeNames: string[] = []
  const employeeSessionMap: Record<string, string[]> = {}
  for (const item of [...pinnedFlat, ...unpinnedFlat]) {
    const name = item.employeeName!
    employeeNames.push(name)
    employeeSessionMap[name] = item.sessions!.map((session) => session.id)
  }
  return { sessionIds, employeeNames, employeeSessionMap }
}

export function buildVirtualItems({
  searching,
  searchRows,
  viewMode,
  rooms,
  expandedRooms,
  cronSessions,
  cronCollapsed,
  sortedCron,
  cronTotal,
  todayRows,
  yesterdayRows,
  olderSummary,
  olderExpanded,
  olderFocusedRows,
  olderPinned,
  olderUnpinned,
  pinnedFlat,
  unpinnedFlat,
  portalSlug,
  portalName,
  employeeData,
}: {
  searching: boolean
  searchRows: FlatRow[]
  viewMode: ViewMode
  rooms: DepartmentRoom[]
  expandedRooms: Set<string>
  cronSessions: Session[]
  cronCollapsed: boolean
  sortedCron: Session[]
  cronTotal: number
  todayRows: FlatRow[]
  yesterdayRows: FlatRow[]
  olderSummary: OlderSummary
  olderExpanded: boolean
  olderFocusedRows: FlatRow[]
  olderPinned: FlatItem[]
  olderUnpinned: FlatItem[]
  pinnedFlat: FlatItem[]
  unpinnedFlat: FlatItem[]
  portalSlug: string
  portalName: string
  employeeData: Map<string, Employee>
}): VirtualItem[] {
  const list: VirtualItem[] = []
  if (searching) {
    for (const row of searchRows) list.push({ kind: "flat", row })
    return list
  }

  if (viewMode === "rooms") {
    for (const room of rooms) {
      list.push({ kind: "room-header", room })
      if (expandedRooms.has(room.id)) {
        for (const roomSession of room.sessions) {
          const session = roomSession as unknown as Session
          const { avatarName, avatar, emoji, displayName } = resolveRowIdentity(session, { portalSlug, portalName, employeeData })
          list.push({ kind: "flat", row: { session, avatarName, avatar, emoji, displayName } })
        }
      }
    }
    if (cronSessions.length > 0) {
      list.push({ kind: "cron-header" })
      if (!cronCollapsed) {
        for (const session of sortedCron) list.push({ kind: "cron-session", session })
        if (cronSessions.length < cronTotal) list.push({ kind: "cron-more" })
      }
    }
    return list
  }

  if (viewMode === "all") {
    const agentItems = [...pinnedFlat, ...unpinnedFlat]
    if (agentItems.length > 0) {
      list.push({ kind: "section", id: "agents", label: "Agents", count: agentItems.length })
      for (const item of agentItems) list.push({ kind: "employee", item })
    }
    if (cronSessions.length > 0) {
      list.push({ kind: "cron-header" })
      if (!cronCollapsed) {
        for (const session of sortedCron) list.push({ kind: "cron-session", session })
        if (cronSessions.length < cronTotal) list.push({ kind: "cron-more" })
      }
    }
    return list
  }

  if (todayRows.length > 0) {
    list.push({ kind: "section", id: "today", label: "Today", count: todayRows.length })
    for (const row of todayRows) list.push({ kind: "flat", row })
  }
  if (yesterdayRows.length > 0) {
    list.push({ kind: "section", id: "yesterday", label: "Yesterday", count: yesterdayRows.length })
    for (const row of yesterdayRows) list.push({ kind: "flat", row })
  }
  if (olderSummary.chats > 0) {
    if (!olderExpanded) {
      list.push({ kind: "older-line" })
    } else if (viewMode === "focused") {
      list.push({ kind: "older-header" })
      for (const row of olderFocusedRows) list.push({ kind: "flat", row })
    } else {
      list.push({ kind: "older-header" })
      for (const item of olderPinned) list.push({ kind: "employee", item })
      for (const item of olderUnpinned) list.push({ kind: "employee", item })
    }
  }
  if (cronSessions.length > 0) {
    list.push({ kind: "cron-header" })
    if (!cronCollapsed) {
      for (const session of sortedCron) list.push({ kind: "cron-session", session })
      if (cronSessions.length < cronTotal) list.push({ kind: "cron-more" })
    }
  }
  return list
}

export function formatOlderLineLabel(summary: OlderSummary): string {
  const chatWord = summary.chats === 1 ? "chat" : "chats"
  if (summary.employees <= 0) return `Older · ${summary.chats} ${chatWord}`
  const employeeWord = summary.employees === 1 ? "employee" : "employees"
  return `Older · ${summary.chats} ${chatWord} across ${summary.employees} ${employeeWord}`
}
