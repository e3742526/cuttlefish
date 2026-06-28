import { Link, useLocation } from "react-router-dom"
import { isNavItemActive } from "@/components/pill-nav"
import { MOBILE_TAB_ITEMS, applyNavOrder } from "@/lib/nav"
import { useSettings } from "@/routes/settings-provider"
import { cn } from "@/lib/utils"

// The curated set of tab hrefs (which 5 are tabs is fixed — iOS caps at 5); only
// their ORDER follows the user's nav-rail preference.
const CURATED_TAB_HREFS = new Set(MOBILE_TAB_ITEMS.map((item) => item.href))

// ---------------------------------------------------------------------------
// MobileTabBar — the iOS-style bottom tab bar for the curated 5 (MOBILE_TAB_ITEMS).
// Mobile only (lg:hidden); the parent decides when to mount it. Frosted material
// over content with the single 0.5px top hairline iOS tab bars are allowed (the
// one exception to "no hairlines at rest").
//
// Icons-only (no text labels): "you are here" reads from a strong, accent-
// independent active state — a soft --fill-secondary pill behind the icon plus a
// --text-primary tint. Every tab keeps an aria-label, and the tap target stays
// ≥49px tall so a label-free bar is still fully accessible and thumb-friendly.
// ---------------------------------------------------------------------------

export function MobileTabBar() {
  const pathname = useLocation().pathname
  const { settings } = useSettings()
  // Curated 5, re-sorted to match the custom nav order (default order when unset).
  const tabs = applyNavOrder(settings.navOrder).filter((item) => CURATED_TAB_HREFS.has(item.href))

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 lg:hidden",
        "flex items-stretch",
        "border-t-[0.5px] border-[var(--separator)] bg-[var(--material-thick)]",
        "[backdrop-filter:blur(20px)_saturate(1.3)] [-webkit-backdrop-filter:blur(20px)_saturate(1.3)]",
        "py-1.5 pb-[max(var(--safe-bottom),6px)]",
      )}
    >
      {tabs.map((item) => {
        const isActive = isNavItemActive(item.href, pathname)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            to={item.href}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "min-h-[49px] flex-1 flex items-center justify-center",
              "transition-colors",
              isActive
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
            )}
          >
            <span
              className={cn(
                "flex h-9 w-14 items-center justify-center rounded-full transition-colors",
                isActive && "bg-[var(--fill-secondary)]",
              )}
            >
              <Icon size={24} className="shrink-0" />
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
