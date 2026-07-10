import { useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"

export interface GoToTarget {
  key: string
  href: string
  label: string
}

// Mnemonic map for "g then <key>" navigation — press g, then any key below,
// to jump straight to that surface from anywhere in the app. Every letter is
// unique across the map. See
// docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 6.3.
export const GO_TO_TARGETS: GoToTarget[] = [
  { key: "h", href: "/", label: "Chat" },
  { key: "t", href: "/talk", label: "Talk" },
  { key: "o", href: "/org", label: "Organization" },
  { key: "k", href: "/kanban", label: "Kanban" },
  { key: "a", href: "/approvals", label: "Approvals" },
  { key: "r", href: "/archive", label: "Archive" },
  { key: "c", href: "/cron", label: "Cron" },
  { key: "l", href: "/limits", label: "Limits" },
  { key: "y", href: "/activity", label: "Activity" },
  { key: "s", href: "/skills", label: "Skills" },
  { key: "d", href: "/command", label: "Command Center" },
  { key: "p", href: "/orchestration", label: "Orchestration" },
  { key: "z", href: "/settings", label: "Settings" },
]

const LEADER_TIMEOUT_MS = 900

function isEditableTarget(el: Element | null): boolean {
  const tag = el?.tagName?.toLowerCase() ?? ""
  return tag === "input" || tag === "textarea" || (el as HTMLElement | null)?.isContentEditable === true
}

/**
 * "g then <key>" navigation: pressing g arms a short window; the next
 * mapped key jumps straight to that surface (see GO_TO_TARGETS). Disabled
 * while typing in a field, while any dialog is open (Radix marks the DOM
 * with role="dialog" — covers the command palette, confirm dialogs, etc.),
 * or when any modifier key is held.
 */
export function useGoToNavigation(enabled = true) {
  const navigate = useNavigate()
  const armed = useRef(false)
  const timeoutRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!enabled) return

    function disarm() {
      armed.current = false
      window.clearTimeout(timeoutRef.current)
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(document.activeElement)) return
      if (document.querySelector('[role="dialog"]')) return

      // Checked before the armed-target lookup so a repeated "g" re-arms
      // (resets the window) instead of being treated as an unmapped target
      // that disarms the sequence.
      if (e.key.toLowerCase() === "g") {
        armed.current = true
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = window.setTimeout(disarm, LEADER_TIMEOUT_MS)
        return
      }

      if (armed.current) {
        const target = GO_TO_TARGETS.find((t) => t.key === e.key.toLowerCase())
        disarm()
        if (target) {
          e.preventDefault()
          navigate(target.href)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.clearTimeout(timeoutRef.current)
    }
  }, [enabled, navigate])
}
