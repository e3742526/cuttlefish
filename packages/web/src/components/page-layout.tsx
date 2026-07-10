
import { lazy, Suspense } from "react"
import { NavRibbon, PillNav } from "./pill-nav"
import { MobileTabBar } from "./chat/mobile-tab-bar"
import { GlobalShortcuts } from "./global-shortcuts"
import { cn } from "@/lib/utils"
import { useBreadcrumbs } from "@/context/breadcrumb-context"

const GlobalSearch = lazy(() => import("./global-search").then(m => ({ default: m.GlobalSearch })))
const LiveStreamWidget = lazy(() => import("./live-stream-widget").then(m => ({ default: m.LiveStreamWidget })))
const OnboardingWizard = lazy(() => import("./onboarding-wizard").then(m => ({ default: m.OnboardingWizard })))
// Static (not lazy): it registers the g-then-key listener on mount, and a
// lazy chunk load would leave that listener briefly missing on page load.

export function ToolbarActions({ children }: { children?: React.ReactNode }) {
  return (
    <div className="hidden items-center gap-2 lg:flex">
      {children}
    </div>
  )
}

/**
 * App shell. Desktop nav is the global NavRibbon (the same polished icon rail
 * the chat route uses) mounted as a left column — no list to fold, so its top
 * slot is the brand mark. The active rail icon is the "you are here" cue, so
 * there is no persistent title pill; pages that want a heading render their own
 * inline header (e.g. Kanban). Mobile is unchanged: the curated MobileTabBar is
 * the nav, and the legacy PillNav (title + hamburger popover) is kept ONLY on
 * mobile so long-tail pages stay reachable there. `chromeless` routes (chat)
 * draw their own rail + pills.
 *
 * `headerActions` still renders the optional right-actions pill when a page
 * supplies one (none do today — pages own their actions inline via
 * ToolbarActions — but the capability is preserved).
 */
export function PageLayout({
  children,
  headerActions,
  chromeless,
  mainLabel,
}: {
  children: React.ReactNode
  headerActions?: React.ReactNode
  chromeless?: boolean
  mainLabel?: string
}) {
  const { items } = useBreadcrumbs()
  const landmarkLabel = mainLabel ?? items.at(-1)?.label ?? "Main content"

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Suspense fallback={null}>
        <GlobalSearch />
      </Suspense>
      {/* g-then-key navigation + the "?" shortcut sheet. Chat draws its own
          richer, page-local shortcut layer instead (chromeless). */}
      {!chromeless && <GlobalShortcuts />}
      {/* Global desktop nav rail (hidden < lg from inside NavRibbon). Sibling of
          <main> so its per-icon label pills can escape rightward over content. */}
      {!chromeless && <NavRibbon />}
      <main role="main" aria-label={landmarkLabel} className="relative flex flex-1 flex-col overflow-hidden">
        {/* Mobile-only legacy chrome: title pill + hamburger popover (the only
            path to long-tail pages on phones). Desktop nav is the rail above. */}
        {!chromeless && (
          <div className="contents lg:hidden">
            <PillNav actions={headerActions} />
          </div>
        )}
        <div
          className={cn(
            "flex-1 overflow-hidden",
            // Clear the mobile pills (mobile only — desktop nav is the side rail,
            // nothing floats over the top of the content).
            !chromeless && "pt-[calc(max(var(--safe-top),12px)+52px)] lg:pt-0",
            // Clear the mobile bottom tab bar (mobile only; the bar is the
            // persistent cross-route nav). Desktop has no bar.
            !chromeless && "pb-[calc(49px+var(--safe-bottom))] lg:pb-0",
          )}
        >
          {children}
        </div>
        {/* Persistent mobile nav — same curated tab bar across every standard
            page so nav never disappears (Chat draws its own on the list screen). */}
        {!chromeless && <MobileTabBar />}
      </main>
      <Suspense fallback={null}>
        <LiveStreamWidget />
      </Suspense>
      <Suspense fallback={null}>
        <OnboardingWizard />
      </Suspense>
    </div>
  )
}
