import type { LucideIcon } from "lucide-react"
import { VOCABULARY } from "./vocabulary"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

// Labels and icons are sourced from the vocabulary module (lib/vocabulary.ts)
// so a nav entry can never say something different than the page it points
// to — one canonical name per concept, enforced at the type level.
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: VOCABULARY.chat.label, icon: VOCABULARY.chat.icon },
  { href: "/talk", label: VOCABULARY.talk.label, icon: VOCABULARY.talk.icon },
  { href: "/org", label: VOCABULARY.organization.label, icon: VOCABULARY.organization.icon },
  { href: "/kanban", label: VOCABULARY.kanban.label, icon: VOCABULARY.kanban.icon },
  { href: "/approvals", label: VOCABULARY.approval.plural, icon: VOCABULARY.approval.icon },
  { href: "/archive", label: VOCABULARY.archive.label, icon: VOCABULARY.archive.icon },
  { href: "/cron", label: VOCABULARY.cron.label, icon: VOCABULARY.cron.icon },
  { href: "/limits", label: VOCABULARY.limits.label, icon: VOCABULARY.limits.icon },
  { href: "/activity", label: VOCABULARY.activity.label, icon: VOCABULARY.activity.icon },
  { href: "/skills", label: VOCABULARY.skill.plural, icon: VOCABULARY.skill.icon },
  { href: "/settings", label: VOCABULARY.settings.label, icon: VOCABULARY.settings.icon },
]

// Curated 5 for the mobile bottom tab bar (iOS caps at 5). Long-tail nav
// (Kanban/Limits/Activity/Skills) stays reachable on the Settings screen.
// Derived from NAV_ITEMS by href so icons/labels stay in sync with the source.
const MOBILE_TAB_HREFS = ["/", "/talk", "/org", "/cron", "/settings"] as const
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
