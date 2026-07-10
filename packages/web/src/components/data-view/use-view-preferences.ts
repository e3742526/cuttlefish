import { useCallback, useEffect, useState } from "react"

export type Density = "comfortable" | "compact"

export interface SavedView<TFilters = Record<string, unknown>> {
  id: string
  name: string
  filters: TFilters
  sort: { key: string; direction: "asc" | "desc" } | null
  hiddenColumns: string[]
}

export interface ViewPreferences<TFilters = Record<string, unknown>> {
  density: Density
  hiddenColumns: string[]
  savedViews: SavedView<TFilters>[]
  pinnedViewId: string | null
}

const DEFAULT_PREFERENCES: ViewPreferences<never> = {
  density: "comfortable",
  hiddenColumns: [],
  savedViews: [],
  pinnedViewId: null,
}

// Namespaced under the fleetview.prefs.v1 root the plan specifies (Section
// 7.4) — one localStorage entry per DataView surface, so surfaces can't
// clobber each other's column/density/saved-view state.
function storageKey(surfaceKey: string): string {
  return `fleetview.prefs.v1:dataview.${surfaceKey}`
}

function readPreferences<TFilters>(surfaceKey: string): ViewPreferences<TFilters> {
  try {
    const raw = localStorage.getItem(storageKey(surfaceKey))
    if (!raw) return { ...DEFAULT_PREFERENCES }
    const parsed = JSON.parse(raw) as Partial<ViewPreferences<TFilters>>
    return {
      density: parsed.density === "compact" ? "compact" : "comfortable",
      hiddenColumns: Array.isArray(parsed.hiddenColumns) ? parsed.hiddenColumns : [],
      savedViews: Array.isArray(parsed.savedViews) ? parsed.savedViews : [],
      pinnedViewId: typeof parsed.pinnedViewId === "string" ? parsed.pinnedViewId : null,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

/**
 * Persisted, per-surface view state for a DataView table: density, hidden
 * columns, and saved (named) filter/sort/column presets. Reset-to-defaults
 * is just `set(defaults)`. Syncs across tabs via the `storage` event, so a
 * density/column change in one tab doesn't leave a sibling tab stale (see
 * docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 7.4).
 */
export function useViewPreferences<TFilters = Record<string, unknown>>(surfaceKey: string) {
  const [preferences, setPreferences] = useState<ViewPreferences<TFilters>>(() =>
    readPreferences<TFilters>(surfaceKey),
  )

  useEffect(() => {
    setPreferences(readPreferences<TFilters>(surfaceKey))
  }, [surfaceKey])

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== storageKey(surfaceKey)) return
      setPreferences(readPreferences<TFilters>(surfaceKey))
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [surfaceKey])

  const persist = useCallback(
    (next: ViewPreferences<TFilters>) => {
      setPreferences(next)
      try {
        localStorage.setItem(storageKey(surfaceKey), JSON.stringify(next))
      } catch {
        // Storage can be full or unavailable (private browsing) — the in-memory
        // state above still applies for this tab; persistence is best-effort.
      }
    },
    [surfaceKey],
  )

  const setDensity = useCallback(
    (density: Density) => persist({ ...preferences, density }),
    [persist, preferences],
  )

  const setHiddenColumns = useCallback(
    (hiddenColumns: string[]) => persist({ ...preferences, hiddenColumns }),
    [persist, preferences],
  )

  const saveView = useCallback(
    (view: Omit<SavedView<TFilters>, "id">) => {
      const id = `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      persist({ ...preferences, savedViews: [...preferences.savedViews, { ...view, id }] })
      return id
    },
    [persist, preferences],
  )

  const deleteView = useCallback(
    (id: string) => {
      persist({
        ...preferences,
        savedViews: preferences.savedViews.filter((v) => v.id !== id),
        pinnedViewId: preferences.pinnedViewId === id ? null : preferences.pinnedViewId,
      })
    },
    [persist, preferences],
  )

  const pinView = useCallback(
    (id: string | null) => persist({ ...preferences, pinnedViewId: id }),
    [persist, preferences],
  )

  const resetToDefaults = useCallback(() => persist({ ...DEFAULT_PREFERENCES }), [persist])

  return {
    preferences,
    setDensity,
    setHiddenColumns,
    saveView,
    deleteView,
    pinView,
    resetToDefaults,
  }
}
