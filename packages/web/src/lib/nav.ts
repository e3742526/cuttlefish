import type { LucideIcon } from "lucide-react"
import { VOCABULARY } from "./vocabulary"

// The three-group navigation architecture from
// docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 4.2:
// Work (day-to-day), Organization (the workforce), Ops (operator/admin
// surfaces). Group order below also fixes NAV_ITEMS' default order.
export type NavGroup = "work" | "organization" | "ops"

export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  work: "Work",
  organization: "Organization",
  ops: "Ops",
}

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  group: NavGroup
}

// Labels and icons are sourced from the vocabulary module (lib/vocabulary.ts)
// so a nav entry can never say something different than the page it points
// to — one canonical name per concept, enforced at the type level. Command
// Center and Orchestration were previously reachable only by typing a URL
// (or, for Command Center, via the rail's brand-logo link) — both are now
// regular nav entries.
export const NAV_ITEMS: NavItem[] = [
  // Work
  { href: "/", label: VOCABULARY.chat.label, icon: VOCABULARY.chat.icon, group: "work" },
  { href: "/kanban", label: VOCABULARY.kanban.label, icon: VOCABULARY.kanban.icon, group: "work" },
  { href: "/approvals", label: VOCABULARY.approval.plural, icon: VOCABULARY.approval.icon, group: "work" },
  { href: "/archive", label: VOCABULARY.archive.label, icon: VOCABULARY.archive.icon, group: "work" },
  // Organization
  { href: "/org", label: VOCABULARY.organization.label, icon: VOCABULARY.organization.icon, group: "organization" },
  { href: "/skills", label: VOCABULARY.skill.plural, icon: VOCABULARY.skill.icon, group: "organization" },
  { href: "/cron", label: VOCABULARY.cron.label, icon: VOCABULARY.cron.icon, group: "organization" },
  { href: "/limits", label: VOCABULARY.limits.label, icon: VOCABULARY.limits.icon, group: "organization" },
  // Ops
  { href: "/command", label: VOCABULARY.commandCenter.label, icon: VOCABULARY.commandCenter.icon, group: "ops" },
  { href: "/activity", label: VOCABULARY.activity.label, icon: VOCABULARY.activity.icon, group: "ops" },
  { href: "/orchestration", label: VOCABULARY.orchestration.label, icon: VOCABULARY.orchestration.icon, group: "ops" },
  { href: "/settings", label: VOCABULARY.settings.label, icon: VOCABULARY.settings.icon, group: "ops" },
]

// Curated 5 for the mobile bottom tab bar (iOS caps at 5). Approvals over
// Cron: attention beats configuration on a small screen. Long-tail nav
// stays reachable via the popover/settings screen.
// Derived from NAV_ITEMS by href so icons/labels stay in sync with the source.
const MOBILE_TAB_HREFS = ["/", "/command", "/org", "/approvals", "/settings"] as const
export const MOBILE_TAB_ITEMS: NavItem[] = MOBILE_TAB_HREFS.map(
  (href) => NAV_ITEMS.find((item) => item.href === href)!,
)

/**
 * Apply a user's custom nav ordering (a list of hrefs) to `items`.
 *
 * - Items are sorted by their href's position in `order`.
 * - Any item NOT named in `order` keeps its default relative position and is
 *   appended after the ordered ones — so a newly added route never disappears.
 * - Hrefs in `order` that no longer exist in `items` are ignored — so a removed
 *   route can't corrupt the result.
 *
 * `order: []` (the default) returns `items` unchanged. Pure; never mutates inputs.
 */
export function applyNavOrder(order: string[], items: NavItem[] = NAV_ITEMS): NavItem[] {
  if (!order.length) return items
  const known = new Set(items.map((item) => item.href))
  const ranked = order.filter((href) => known.has(href))
  const rank = new Map(ranked.map((href, index) => [href, index]))
  const ordered = ranked.map((href) => items.find((item) => item.href === href)!)
  const rest = items.filter((item) => !rank.has(item.href))
  return [...ordered, ...rest]
}
