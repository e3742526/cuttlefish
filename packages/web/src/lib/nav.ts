import {
  Archive,
  MessageSquare,
  AudioLines,
  Users,
  Clock,
  LayoutGrid,
  Activity,
  Gauge,
  Zap,
  Settings,
  ShieldCheck,
  Network,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/talk", label: "Talk", icon: AudioLines },
  { href: "/org", label: "Organization", icon: Users },
  { href: "/kanban", label: "Kanban", icon: LayoutGrid },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/archive", label: "Archive", icon: Archive },
  { href: "/cron", label: "Cron", icon: Clock },
  { href: "/limits", label: "Limits", icon: Gauge },
  { href: "/logs", label: "Activity", icon: Activity },
  { href: "/skills", label: "Skills", icon: Zap },
  { href: "/settings", label: "Settings", icon: Settings },
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
