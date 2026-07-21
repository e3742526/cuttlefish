import type { Session } from "./sidebar-types"

/**
 * localStorage-backed UI state for the chat sidebar: read/pin markers and the
 * collapse/expand state of employee groups and department rooms.
 * Extracted from chat-sidebar.tsx (audit AS-001 modularization) — no behavior change.
 */

const COLLAPSE_STORAGE_KEY = "cuttlefish-sidebar-collapsed"
const EXPANDED_STORAGE_KEY = "cuttlefish-sidebar-expanded"
const PINNED_STORAGE_KEY = "cuttlefish-pinned-sessions"
const READ_WATERMARKS_STORAGE_KEY = "cuttlefish-session-read-watermarks"
// Which department rooms are EXPANDED (default: none — rooms collapse to a single
// header so agents/sessions stop dominating the list; the room IS the nav unit,
// its sessions are revealed on demand).
const ROOMS_EXPANDED_STORAGE_KEY = "cuttlefish-sidebar-rooms-expanded"

export function loadExpandedRooms(): Set<string> {
  try {
    const raw = localStorage.getItem(ROOMS_EXPANDED_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set()
  } catch {
    return new Set()
  }
}

export function saveExpandedRooms(set: Set<string>): void {
  try {
    localStorage.setItem(ROOMS_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {}
}

export function getReadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem("cuttlefish-read-sessions")
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export type SessionReadWatermarks = Record<string, number>

/** Timestamp-aware read state. Legacy read ids are migrated at the current
 * time so existing sessions stay quiet until a genuinely newer agent message. */
export function getReadSessionWatermarks(
  legacyReadSessions = getReadSessions(),
  now = Date.now(),
): SessionReadWatermarks {
  let watermarks: SessionReadWatermarks = {}
  try {
    const raw = localStorage.getItem(READ_WATERMARKS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      watermarks = Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      )
    }
  } catch {}

  let migrated = false
  for (const id of legacyReadSessions) {
    if (watermarks[id] === undefined) {
      watermarks[id] = now
      migrated = true
    }
  }
  if (migrated) saveReadSessionWatermarks(watermarks)
  return watermarks
}

function saveReadSessionWatermarks(watermarks: SessionReadWatermarks): void {
  try {
    const newest = Object.entries(watermarks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500)
    localStorage.setItem(READ_WATERMARKS_STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)))
  } catch {}
}

export function markSessionRead(id: string, readAt = Date.now()) {
  const read = getReadSessions()
  const watermarks = getReadSessionWatermarks(read, readAt)
  read.add(id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem("cuttlefish-read-sessions", JSON.stringify(arr))
  watermarks[id] = Math.max(watermarks[id] ?? 0, readAt)
  saveReadSessionWatermarks(watermarks)
}

export function markAllReadForEmployee(sessions: Session[], readAt = Date.now()) {
  const read = getReadSessions()
  const watermarks = getReadSessionWatermarks(read, readAt)
  for (const s of sessions) read.add(s.id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem("cuttlefish-read-sessions", JSON.stringify(arr))
  for (const session of sessions) {
    const latestAgentMessageAt = session.lastAgentMessageAt ? Date.parse(session.lastAgentMessageAt) : Number.NaN
    const sessionReadAt = Number.isFinite(latestAgentMessageAt) ? latestAgentMessageAt : readAt
    watermarks[session.id] = Math.max(watermarks[session.id] ?? 0, sessionReadAt)
  }
  saveReadSessionWatermarks(watermarks)
}

export function getPinnedSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function savePinnedSessions(pinned: Set<string>) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(pinned)))
  } catch {}
}

export function loadCollapsedState(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function saveCollapsedState(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsed)))
  } catch {}
}

export function loadExpandedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveExpandedState(expanded: Record<string, boolean>) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
  } catch {}
}
