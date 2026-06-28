import { Fragment, useEffect, useState, type ComponentType, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { Menu, Sun, Moon, Palette, ArrowLeftRight, PanelLeft } from "lucide-react"
import { useTheme } from "@/routes/providers"
import { useSettings } from "@/routes/settings-provider"
import { DEFAULT_PORTAL_ICON } from "@/lib/settings"
import { THEMES, type ThemeId } from "@/lib/themes"
import { NAV_ITEMS, applyNavOrder } from "@/lib/nav"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Frosted pill primitives (mockup _shared.css `.pill` recipe)
// ---------------------------------------------------------------------------
// backdrop-blur(20px) saturate(1.3) over a theme-aware translucent material,
// 0.5px theme-aware border (the shadow's built-in ring, NOT a hairline at rest),
// overlay shadow, full radius. Material + border flip with the active theme via
// --pill-bg / --pill-border (globals.css). The cross-page pill system and the
// chat header pills share this single primitive.
export const PILL_CLASS =
  "pointer-events-auto inline-flex items-center gap-0.5 rounded-full border-[0.5px] border-[var(--pill-border)] " +
  "bg-[var(--pill-bg)] p-1 shadow-[var(--shadow-overlay)] " +
  "[backdrop-filter:blur(20px)_saturate(1.3)] [-webkit-backdrop-filter:blur(20px)_saturate(1.3)]"

// The nav popover reuses the EXACT pill material — same translucent fill, 0.5px
// ring, blur and overlay shadow — only the radius differs (panel, not pill).
const POPOVER_CLASS =
  "rounded-[var(--radius-lg)] border-[0.5px] border-[var(--pill-border)] " +
  "bg-[var(--pill-bg)] shadow-[var(--shadow-overlay)] " +
  "[backdrop-filter:blur(20px)_saturate(1.3)] [-webkit-backdrop-filter:blur(20px)_saturate(1.3)]"

export function PillButton({
  onClick,
  title,
  ariaLabel,
  ariaExpanded,
  className,
  children,
}: {
  onClick?: () => void
  title?: string
  ariaLabel?: string
  ariaExpanded?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      className={cn(
        // 36px tap target at base (Apple HIG floor); tighten to 32px on desktop.
        "inline-flex size-9 lg:size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        "text-[var(--text-secondary)]",
        "hover:bg-[var(--fill-secondary)] hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Nav primitives — shared by the popover (non-chat pages) AND the chat route's
// in-surface list⇄nav swap, so the nav links read identically everywhere.
// ---------------------------------------------------------------------------

/** The single active-route rule used across the rail, drawer, popover and pill. */
export function isNavItemActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href)
}

export function NavList({
  pathname,
  onNavigate,
}: {
  pathname: string
  onNavigate?: () => void
}) {
  const { settings } = useSettings()
  return (
    <div className="flex flex-col gap-0.5 p-1.5">
      {applyNavOrder(settings.navOrder).map((item) => {
        const isActive = isNavItemActive(item.href, pathname)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            to={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex h-10 items-center gap-3 rounded-[10px] px-3 text-[length:var(--text-subheadline)] transition-colors",
              isActive
                ? "bg-[var(--fill-secondary)] font-[var(--weight-semibold)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
            )}
          >
            <Icon size={18} className="shrink-0" />
            {item.label}
          </Link>
        )
      })}
    </div>
  )
}

function ThemeIcon({ theme }: { theme: ThemeId }) {
  if (theme === "light") return <Sun size={18} />
  if (theme === "dark") return <Moon size={18} />
  return <Palette size={18} />
}

interface InstanceInfo {
  name: string
  port: number
  running: boolean
  current: boolean
}

/** Footer for the nav surface — the theme toggle + (when >1) instance switcher.
 *  Re-homed verbatim from the retired rail so nothing is lost. Used by the
 *  popover and the chat in-surface nav swap. */
export function NavFooter() {
  const { theme, setTheme } = useTheme()
  const [instances, setInstances] = useState<InstanceInfo[]>([])

  useEffect(() => {
    fetch("/api/instances")
      .then((r) => r.json())
      .then(setInstances)
      .catch(() => {})
  }, [])

  function cycleTheme() {
    const ids = THEMES.map((t) => t.id)
    const idx = ids.indexOf(theme)
    setTheme(ids[(idx + 1) % ids.length])
  }

  return (
    <div className="flex flex-col gap-0.5 p-1.5 pt-0">
      {instances.length > 1 && (
        <>
          <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
            <ArrowLeftRight size={11} className="shrink-0" />
            Instances
          </div>
          {instances.map((inst) => (
            <button
              key={inst.port}
              onClick={() => {
                if (!inst.current && inst.running) {
                  window.location.href = `http://localhost:${inst.port}/chat`
                }
              }}
              className={cn(
                "flex h-9 w-full items-center justify-between rounded-[10px] px-3 text-left text-[length:var(--text-footnote)] transition-colors",
                inst.current
                  ? "bg-[var(--fill-secondary)] font-[var(--weight-semibold)] text-[var(--text-primary)]"
                  : inst.running
                    ? "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
                    : "cursor-default text-[var(--text-quaternary)]",
              )}
            >
              <span className="truncate">{inst.name}</span>
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: inst.running ? "var(--system-green)" : "var(--text-quaternary)" }}
              />
            </button>
          ))}
          <div className="mx-2 my-1 h-px bg-[var(--separator)]" />
        </>
      )}
      <button
        onClick={cycleTheme}
        aria-label={`Theme: ${theme}. Click to cycle.`}
        className="flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-[length:var(--text-subheadline)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
      >
        <span className="shrink-0">
          <ThemeIcon theme={theme} />
        </span>
        <span className="capitalize">{theme}</span>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// NavRibbon — the chat route's permanent slim icon rail (~56px). Always mounted
// (desktop only). Icons-only at rest; the rail NEVER widens, so the chat list is
// never covered. Hovering/focusing a single icon springs ONLY that icon's label
// out as a small frosted pill to its right — a per-key "piano" reveal — while the
// icon itself lifts a touch (Dock-style). The top slot shows the Cuttlefish logo at
// rest and cross-fades to the sidebar toggle on hover (ChatGPT-style). Active
// item = soft --fill-secondary, NEVER --accent.
// ---------------------------------------------------------------------------

// The floating label that springs out beside a hovered/focused icon. Calm and
// crisp: a flat opaque --bg-tertiary surface with a 0.5px --separator hairline
// and a subtle drop shadow — NO backdrop saturate (no colored halo) and NOT the
// heavy overlay shadow (no glow). Theme-aware, quiet, readable over the list.
// The icon carries the real aria-label, so the pill is decorative (aria-hidden).
// Under reduced motion it fades only (no slide).
const RIBBON_LABEL_PILL =
  "whitespace-nowrap rounded-full border-[0.5px] border-[var(--separator)] bg-[var(--bg-tertiary)] " +
  "px-2.5 py-1 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] " +
  "shadow-[var(--shadow-subtle)] " +
  "opacity-0 transition-[opacity,transform] duration-150 [transition-timing-function:var(--ease-snappy)] " +
  "motion-safe:-translate-x-1.5 group-hover/row:opacity-100 group-hover/row:translate-x-0 " +
  "group-focus-within/row:opacity-100 group-focus-within/row:translate-x-0 motion-reduce:transition-opacity"

/** One ribbon entry — a fixed 44px icon square. It never resizes; the label is a
 *  floating pill that escapes to the right on hover/focus (the piano reveal), and
 *  the icon lifts/scales a touch like a pressed Dock key. */
interface RibbonDragProps {
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (e: ReactDragEvent) => void
  onDragOver?: (e: ReactDragEvent) => void
  onDrop?: (e: ReactDragEvent) => void
  onDragEnd?: (e: ReactDragEvent) => void
}

function RibbonRow({
  Icon,
  label,
  isActive,
  href,
  onClick,
  draggable,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  Icon: ComponentType<{ size?: number | string; className?: string }>
  label: string
  isActive?: boolean
  href?: string
  // Receives the click event so a link row can preventDefault a no-op
  // same-route navigation (used by the Chat icon to reveal the list instead).
  onClick?: (e: ReactMouseEvent) => void
} & RibbonDragProps) {
  const cls = cn(
    "group/row relative flex size-11 shrink-0 items-center justify-center rounded-[12px] transition-colors duration-150 [transition-timing-function:var(--ease-smooth)]",
    isActive
      ? "bg-[var(--fill-secondary)] text-[var(--text-primary)]"
      : "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
    dragging && "opacity-40",
  )
  // While ANY icon is being dragged (the nav carries data-dragging), freeze the
  // per-icon lift/scale and hide the piano-reveal label so they don't fight the drag.
  const dragHandlers: RibbonDragProps = { draggable, onDragStart, onDragOver, onDrop, onDragEnd }
  const inner = (
    <>
      <span className="flex items-center justify-center transition-transform duration-150 [transition-timing-function:var(--ease-snappy)] motion-safe:group-hover/row:-translate-y-px motion-safe:group-hover/row:scale-110 motion-safe:group-active/row:scale-95 motion-reduce:transform-none group-data-[dragging=true]/ribbon:!transform-none">
        <Icon size={20} className="shrink-0" />
      </span>
      {/* Piano reveal — floats past the rail edge; flex-centers vertically so the
          inner pill is free to animate on the X axis. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-full z-50 ml-2 flex items-center group-data-[dragging=true]/ribbon:hidden">
        <span className={RIBBON_LABEL_PILL}>{label}</span>
      </span>
    </>
  )
  if (href) {
    return (
      <Link
        to={href}
        onClick={onClick}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        className={cls}
        {...dragHandlers}
      >
        {inner}
      </Link>
    )
  }
  return (
    <button type="button" onClick={onClick} aria-label={label} className={cls} {...dragHandlers}>
      {inner}
    </button>
  )
}

/** The slim icon nav rail. On the chat route `listOpen` + `onToggleList` drive
 *  the chat-list fold (top slot = logo↔toggle morph). Mounted globally elsewhere
 *  with NEITHER prop — then the top slot is a brand mark linking home, with no
 *  fold/toggle (there is no list to fold). */
export function NavRibbon({
  listOpen = false,
  onToggleList,
}: {
  listOpen?: boolean
  onToggleList?: () => void
}) {
  const pathname = useLocation().pathname
  const { theme, setTheme } = useTheme()
  const { settings, setNavOrder } = useSettings()
  const portalName = settings.portalName ?? "Cuttlefish"
  const brandIcon = settings.portalIcon ?? DEFAULT_PORTAL_ICON
  const emoji = settings.portalEmoji
  const cycleTheme = () => {
    const ids = THEMES.map((t) => t.id)
    setTheme(ids[(ids.indexOf(theme) + 1) % ids.length])
  }

  // ── Drag-to-reorder (native HTML5 DnD; the rail is desktop-only). Only the
  // primary icons reorder — Talk and the theme toggle stay docked. The commit is
  // derived entirely from the drop event (dragged href from `dataTransfer`, target
  // from the dropped-on row + pointer Y) so it never depends on React state having
  // re-rendered between the dragstart/dragover/drop events. `draggingHref`/`dropIndex`
  // drive only the visual dim + drop-line indicator.
  const [draggingHref, setDraggingHref] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const resetDrag = () => {
    setDraggingHref(null)
    setDropIndex(null)
  }
  const insertsAfter = (e: ReactDragEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return e.clientY > rect.top + rect.height / 2
  }
  const handleRowDragStart = (href: string) => (e: ReactDragEvent) => {
    e.dataTransfer.setData("text/plain", href)
    e.dataTransfer.effectAllowed = "move"
    setDraggingHref(href)
  }
  const handleRowDragOver = (index: number) => (e: ReactDragEvent) => {
    e.preventDefault() // unconditional — required for `drop` to fire in real browsers
    e.dataTransfer.dropEffect = "move"
    setDropIndex(insertsAfter(e) ? index + 1 : index)
  }
  const handleRowDrop = (index: number) => (e: ReactDragEvent) => {
    e.preventDefault()
    const draggedHref = e.dataTransfer.getData("text/plain")
    const from = primaryHrefs.indexOf(draggedHref)
    if (from === -1) return resetDrag() // not one of our icons — ignore
    const without = primaryHrefs.filter((href) => href !== draggedHref)
    let slot = insertsAfter(e) ? index + 1 : index
    if (from < slot) slot -= 1 // the dragged item left a hole before the slot
    slot = Math.max(0, Math.min(slot, without.length))
    without.splice(slot, 0, draggedHref)
    setNavOrder(without)
    resetDrag()
  }
  // The Chat icon is OPEN-ONLY. While already on the chat route ("/") with the
  // list collapsed, a plain click reveals the list instead of firing a dead
  // same-route navigation. Not on "/" → the Link navigates as before; list
  // already open → harmless no-op. Modified clicks (new tab/window) fall through
  // to the Link untouched. Closing the list stays the top toggle's job, so one
  // control never means both open and close.
  const onChatIconClick = (e: ReactMouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (onToggleList && pathname === "/" && !listOpen) {
      e.preventDefault()
      onToggleList()
    }
  }
  const orderedNavItems = applyNavOrder(settings.navOrder)
  const primaryNavItems = orderedNavItems.filter((item) => item.href !== "/talk")
  const primaryHrefs = primaryNavItems.map((item) => item.href)
  const talkNavItem = NAV_ITEMS.find((item) => item.href === "/talk")
  return (
    // The placeholder reserves the rail width (w-14 = 56px) in the flex row; the
    // real rail floats above it so the per-icon label pills can escape to the
    // right (over the list / thread) without widening the rail or reflowing it.
    <div className="relative hidden h-full w-14 shrink-0 lg:block">
      <nav
        aria-label="Primary"
        data-dragging={draggingHref ? "true" : undefined}
        className="group/ribbon absolute inset-y-0 left-0 z-30 flex w-14 flex-col items-center gap-0.5 bg-[var(--ribbon-bg)] px-1.5 pb-2.5 pt-3.5"
      >
        {/* Top slot — a plain, button-sized Cuttlefish brand mark that fills the rail
            top (no frosted-pill chrome). It morphs to the sidebar.left toggle
            while the pointer is anywhere over the LEFT region — the rail AND the
            chat-list column (ChatGPT-style, via group/sidebar on the region
            wrapper in chat/page.tsx) — or while the button is focused after a
            click; it reverts to the logo on mouse-leave. The thread/main content
            sits outside that group, so hovering it never triggers the morph.
            pt-3.5 centers the 44px button on the same y (~36px) as the thread's
            right actions pill, so rail-top and header read as one row. */}
        <div className="group/logo mb-1">
          {onToggleList ? (
            <button
              type="button"
              onClick={onToggleList}
              title={listOpen ? "Hide chats" : "Show chats"}
              aria-label={listOpen ? "Hide chats" : "Show chats"}
              aria-expanded={listOpen}
              className="relative flex size-11 items-center justify-center rounded-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
            >
              <span
                aria-hidden
                className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/sidebar:opacity-0 group-focus-within/logo:opacity-0"
              >
                {emoji ? (
                  <span className="text-[26px] leading-none [font-variant-emoji:emoji]">{emoji}</span>
                ) : (
                  <img src={brandIcon} alt="" className="size-7 object-contain" draggable={false} />
                )}
              </span>
              <PanelLeft
                size={22}
                className="opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100 group-focus-within/logo:opacity-100"
              />
            </button>
          ) : (
            // Global (non-chat) rail: no list to fold, so the top slot is a plain
            // brand mark that links home.
            <Link
              to="/"
              aria-label={portalName}
              title={portalName}
              className="relative flex size-11 items-center justify-center rounded-[12px] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              <span
                aria-hidden
                className="flex items-center justify-center"
              >
                {emoji ? (
                  <span className="text-[26px] leading-none [font-variant-emoji:emoji]">{emoji}</span>
                ) : (
                  <img src={brandIcon} alt="" className="size-7 object-contain" draggable={false} />
                )}
              </span>
            </Link>
          )}
        </div>

        {/* Nav icons — drag to reorder (per-icon piano reveal). A thin accent line
            marks the drop slot while dragging. */}
        {primaryNavItems.map((item, index) => (
          <Fragment key={item.href}>
            {draggingHref && dropIndex === index && (
              <div aria-hidden className="h-0.5 w-7 shrink-0 rounded-full bg-[var(--accent)]" />
            )}
            <RibbonRow
              Icon={item.icon}
              label={item.label}
              href={item.href}
              isActive={isNavItemActive(item.href, pathname)}
              onClick={item.href === "/" ? onChatIconClick : undefined}
              draggable
              dragging={draggingHref === item.href}
              onDragStart={handleRowDragStart(item.href)}
              onDragOver={handleRowDragOver(index)}
              onDrop={handleRowDrop(index)}
              onDragEnd={resetDrag}
            />
          </Fragment>
        ))}
        {draggingHref && dropIndex === primaryNavItems.length && (
          <div aria-hidden className="h-0.5 w-7 shrink-0 rounded-full bg-[var(--accent)]" />
        )}

        {/* Footer utilities — Talk stays docked just above the theme control. */}
        <div className="mt-auto flex flex-col gap-0.5 pt-1">
          {talkNavItem && (
            <RibbonRow
              Icon={talkNavItem.icon}
              label={talkNavItem.label}
              href={talkNavItem.href}
              isActive={isNavItemActive(talkNavItem.href, pathname)}
            />
          )}
          <RibbonRow Icon={themeGlyph(theme)} label={`Theme: ${theme}`} onClick={cycleTheme} />
        </div>
      </nav>
    </div>
  )
}

function themeGlyph(theme: ThemeId): ComponentType<{ size?: number | string; className?: string }> {
  if (theme === "light") return Sun
  if (theme === "dark") return Moon
  return Palette
}

/** Frosted nav popover anchored under the left pill — non-chat pages reach the
 *  global nav here (the chat route swaps its left surface in place instead). */
export function NavPopover({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = useLocation().pathname
  if (!open) return null
  return (
    <>
      {/* Click-away scrim (transparent — the popover floats over content). */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div
        className={cn(
          "absolute left-[max(var(--safe-left),12px)] top-[calc(max(var(--safe-top),12px)+46px)] z-50 w-[244px] lg:left-4 lg:top-[52px]",
          POPOVER_CLASS,
        )}
        style={{ animation: "pillNavIn 160ms var(--ease-smooth)" }}
        role="menu"
      >
        <NavList pathname={pathname} onNavigate={onClose} />
        <div className="mx-2 h-px bg-[var(--separator)]" />
        <NavFooter />
      </div>
      <style>{`
        @keyframes pillNavIn {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  )
}

// ---------------------------------------------------------------------------
// PillNav — the pinned two-pill page chrome rendered by PageLayout for every
// non-chat route. LEFT pill = nav button (opens the popover) + route icon +
// page title (from the breadcrumb provider). RIGHT pill = page actions, and is
// absent entirely when a page has none (clean corner).
// ---------------------------------------------------------------------------

export function PillNav({ actions }: { actions?: ReactNode }) {
  const pathname = useLocation().pathname
  const { items } = useBreadcrumbs()
  const { settings } = useSettings()
  const brandIcon = settings.portalIcon ?? DEFAULT_PORTAL_ICON
  const emoji = settings.portalEmoji
  const [navOpen, setNavOpen] = useState(false)

  const title = items[0]?.label ?? ""
  const navItem = NAV_ITEMS.find((n) => isNavItemActive(n.href, pathname))
  const RouteIcon = navItem?.icon

  return (
    <>
      {/* LEFT pill — nav button + route icon + page title. */}
      <div className="pointer-events-none absolute left-[max(var(--safe-left),12px)] top-[max(var(--safe-top),12px)] z-40 lg:left-4 lg:top-4">
        <div className={cn(PILL_CLASS, "group/brand")}>
          <PillButton
            onClick={() => setNavOpen((o) => !o)}
            title="Menu"
            ariaLabel="Open navigation"
            ariaExpanded={navOpen}
          >
            {/* Brand-anchor: the portal logo is the constant at rest on desktop,
                cross-fading to the hamburger on hover (mirrors the chat ribbon's
                logo→toggle top slot). Mobile has no hover, so it always shows the
                hamburger — the nav popover must stay one tap away. */}
            <span className="relative flex size-[17px] items-center justify-center">
              <span
                aria-hidden
                className="absolute inset-0 hidden items-center justify-center transition-opacity duration-150 lg:flex lg:group-hover/brand:opacity-0"
              >
                {emoji ? (
                  <span className="text-[14px] leading-none [font-variant-emoji:emoji]">{emoji}</span>
                ) : (
                  <img src={brandIcon} alt="" className="size-4 object-contain" draggable={false} />
                )}
              </span>
              <Menu
                size={17}
                className="transition-opacity duration-150 lg:opacity-0 lg:group-hover/brand:opacity-100"
              />
            </span>
          </PillButton>
          {title && (
            <span className="flex select-none items-center gap-1.5 pl-0.5 pr-2.5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {RouteIcon && <RouteIcon size={15} className="shrink-0 text-[var(--text-tertiary)]" />}
              <span className="truncate max-w-[42vw]">{title}</span>
            </span>
          )}
        </div>
      </div>

      <NavPopover open={navOpen} onClose={() => setNavOpen(false)} />

      {/* RIGHT pill — only when the page provides actions. */}
      {actions && (
        <div className="pointer-events-none absolute right-[max(var(--safe-right),12px)] top-[max(var(--safe-top),12px)] z-40 lg:right-4 lg:top-4">
          <div className={PILL_CLASS}>{actions}</div>
        </div>
      )}
    </>
  )
}
