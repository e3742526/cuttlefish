import type { Employee } from "@/lib/api"
import type { Session, StatusDotState } from "./sidebar-types"

/**
 * Pure classification / formatting helpers for chat sidebar rows: time
 * formatting, session-kind detection (cron/direct/visible), activity sorting,
 * background-activity + recent-error detection, and the status-dot resolver.
 * Extracted from chat-sidebar.tsx (audit AS-001 modularization) — no behavior change.
 */

const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000
// A red error dot is only worth surfacing while the failure is fresh; older
// errored sessions fall back to the normal idle/unread treatment so the list
// isn't littered with stale red dots.
const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000

const formatTimeCache = new Map<string, string>()
const FORMAT_TIME_CACHE_MAX = 200

export function formatTime(dateStr?: string): string {
  if (!dateStr) return ""
  const cached = formatTimeCache.get(dateStr)
  if (cached !== undefined) return cached
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  let result: string
  if (diff < 60_000) result = "now"
  else if (diff < 3_600_000) result = `${Math.floor(diff / 60_000)}m`
  else if (diff < 86_400_000) {
    result = new Date(dateStr).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  } else if (diff < 172_800_000) result = "yesterday"
  else result = new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  if (formatTimeCache.size >= FORMAT_TIME_CACHE_MAX) {
    const oldest = formatTimeCache.keys().next().value
    if (oldest !== undefined) formatTimeCache.delete(oldest)
  }
  formatTimeCache.set(dateStr, result)
  return result
}

export function titleCase(slug: string | null | undefined): string {
  if (!slug) return ""
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

/** Resolve the avatar slug + human label for a flat session row. Direct/COO
 *  sessions borrow the portal identity; cron/employee-less sessions fall back to
 *  it too — they have no org employee, so search (which flattens cron rows that
 *  the grouped view renders separately) must not `.split()` a null employee.
 *  The rest use their employee's org profile. */
export function resolveRowIdentity(
  s: Pick<Session, "source" | "sourceRef" | "employee">,
  opts: { portalSlug: string; portalName: string; employeeData: Map<string, Employee> },
): { avatarName: string; avatar?: string; emoji?: string; displayName: string } {
  const { portalSlug, portalName, employeeData } = opts
  if (isDirectSession(s, portalSlug) || !s.employee) {
    return { avatarName: portalSlug, displayName: portalName }
  }
  const emp = s.employee
  const profile = employeeData.get(emp)
  return { avatarName: emp, avatar: profile?.avatar, emoji: profile?.emoji, displayName: profile?.displayName || titleCase(emp) }
}

export function isCronSession(session: Pick<Session, "source" | "sourceRef">): boolean {
  return session.source === "cron" || (session.sourceRef || "").startsWith("cron:")
}

export function isDirectSession(
  session: Pick<Session, "source" | "sourceRef" | "employee">,
  portalSlug?: string,
): boolean {
  if (isCronSession(session)) return false
  if (!session.employee) return true
  // A session tagged with the portal slug is a direct/COO session, not a
  // pseudo-employee — fold it into the direct group rather than a phantom one
  // that renders with the portal's own title.
  return !!portalSlug && session.employee.toLowerCase() === portalSlug
}

// Sources the sidebar renders directly in the main chat list.
export function isVisibleSource(s: Session): boolean {
  return s.source === "web" || s.source === "cron" || s.source === "whatsapp" || !s.source
}

export function getSessionActivity(session: Session): string {
  return session.lastActivity || session.createdAt || ""
}

export function sortSessionsByActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => getSessionActivity(b).localeCompare(getSessionActivity(a)))
}

/** Apply per-session read watermarks to the legacy read-id set. A newer
 * assistant/notification timestamp makes the session unread again. */
export function resolveReadSessions(
  sessions: Session[],
  readSessions: Set<string>,
  readWatermarks: Record<string, number>,
): Set<string> {
  const next = new Set(readSessions)
  for (const session of sessions) {
    if (!session.lastAgentMessageAt) continue
    const latest = Date.parse(session.lastAgentMessageAt)
    if (Number.isFinite(latest) && latest > (readWatermarks[session.id] ?? 0)) next.delete(session.id)
    else next.add(session.id)
  }
  return next
}

/** Idle-but-busy: the session's turn ended but subagents/background tasks are
 *  still making API calls. Running/error status always wins over this. */
export function hasBackgroundActivity(session: Pick<Session, "status" | "backgroundActivity">): boolean {
  const activity = session.backgroundActivity
  const lastActivityAt = activity?.lastActivityAt ? new Date(activity.lastActivityAt).getTime() : 0
  const stale = lastActivityAt > 0 && Date.now() - lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS
  return (
    session.status !== "running" &&
    session.status !== "error" &&
    !stale &&
    (activity?.activeStreams ?? 0) > 0
  )
}

/** A red error dot fires only for a *recently* errored session — `status` is
 *  "error" AND its last activity is inside the recency window. `nowMs` is passed
 *  in (rather than read at module load) so the window is evaluated at call time
 *  and the helper stays pure/testable. A missing or unparseable timestamp is
 *  treated as not-recent so the row falls through to the quiet treatment. */
export function isRecentError(
  status: string | undefined,
  lastActivityISO: string,
  nowMs: number,
): boolean {
  if (status !== "error") return false
  if (!lastActivityISO) return false
  const ts = new Date(lastActivityISO).getTime()
  if (Number.isNaN(ts)) return false
  return nowMs - ts < RECENT_ERROR_WINDOW_MS
}

// Resolve the attention-state dot for a session. Returns null for the resting
// "read" state so no dot is painted (quiet at rest). Optionally treat the row
// as unread even when this session is read (e.g. a grouped employee row whose
// other chats are unread).
export function getStatusDot(
  session: Session,
  readSet: Set<string>,
  forceUnread = false,
): StatusDotState | null {
  if (session.jobState === "needs_attention" || session.status === "waiting") {
    return { color: "var(--system-orange)", label: "needs your attention", pulse: true }
  }
  const unread = forceUnread || !readSet.has(session.id)
  if (unread && session.lastAgentMessageAt) {
    return { color: "var(--system-blue)", label: "new agent message", pulse: true }
  }
  if (session.jobState === "working" || session.status === "running") {
    return { color: "var(--system-blue)", label: "work in progress", pulse: true }
  }
  if (session.jobState === "failed") {
    return { color: "var(--system-red)", label: "job failed", pulse: false }
  }
  if (isRecentError(session.status, getSessionActivity(session), Date.now())) {
    return { color: "var(--system-red)", label: "error", pulse: false }
  }
  if (hasBackgroundActivity(session)) return { color: "var(--system-orange)", label: "background work running", pulse: true }
  if (session.jobState === "finished") {
    return { color: "var(--system-green)", label: "job finished", pulse: false }
  }
  // Unread uses a NEUTRAL dot (not --accent): accent is user-set and may be red,
  // which would read like an error. Calm grey stays visible without alarming.
  if (unread) return { color: "var(--text-secondary)", label: "unread", pulse: false }
  return null
}

/** Persistent text for delegated-job lifecycle states. Unlike the dot, this
 * remains understandable without relying on color or hover affordances. */
export function getJobStateLabel(
  session: Pick<Session, "status" | "jobState">,
  hasNewAgentMessage = false,
): string | null {
  if (session.jobState === "needs_attention" || session.status === "waiting") return "Needs your attention"
  if (hasNewAgentMessage) return "New agent message"
  if (session.jobState === "working") return "Work in progress"
  if (session.jobState === "finished") return "Job finished"
  if (session.jobState === "failed") return "Job failed"
  return null
}
