import type { SortState } from "@/components/data-view"

export const ORCHESTRATION_TABS = [
  "Overview",
  "Workers",
  "Queue",
  "Holds",
  "Continuations",
  "Dual-lane",
  "Recovery",
  "Worktrees",
  "Telemetry",
] as const

export type OrchestrationTab = typeof ORCHESTRATION_TABS[number]

export interface WorkersViewUrlState {
  search: string
  sort: SortState | null
  hiddenColumns: string[]
  selectedWorkerId: string | null
}

const TAB_PARAM = "tab"
const SEARCH_PARAM = "workersSearch"
const SORT_PARAM = "workersSort"
const DIRECTION_PARAM = "workersDirection"
const COLUMNS_PARAM = "workersColumns"
const SELECTED_WORKER_PARAM = "worker"

function stringsFromList(value: string | null): string[] {
  if (!value) return []
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))]
}

function isOrchestrationTab(value: string | null): value is OrchestrationTab {
  return Boolean(value && ORCHESTRATION_TABS.includes(value as OrchestrationTab))
}

export function readOrchestrationTab(search = window.location.search): OrchestrationTab {
  const tab = new URLSearchParams(search).get(TAB_PARAM)
  return isOrchestrationTab(tab) ? tab : "Overview"
}

export function readWorkersViewUrlState(search = window.location.search): WorkersViewUrlState {
  const params = new URLSearchParams(search)
  const sortKey = params.get(SORT_PARAM)
  const direction = params.get(DIRECTION_PARAM)
  return {
    search: params.get(SEARCH_PARAM) ?? "",
    sort: sortKey && (direction === "asc" || direction === "desc")
      ? { key: sortKey, direction }
      : null,
    hiddenColumns: stringsFromList(params.get(COLUMNS_PARAM)),
    selectedWorkerId: params.get(SELECTED_WORKER_PARAM) || null,
  }
}

function setOrDelete(params: URLSearchParams, key: string, value: string | null | undefined) {
  if (value) params.set(key, value)
  else params.delete(key)
}

/**
 * Produces the query string for a shareable orchestration view while retaining
 * unrelated route parameters. The caller owns history writes so typing in a
 * filter can use replaceState rather than create a history entry per keypress.
 */
export function buildOrchestrationViewSearch(
  currentSearch: string,
  options: { tab?: OrchestrationTab; workers?: WorkersViewUrlState },
): string {
  const params = new URLSearchParams(currentSearch)
  if (options.tab) setOrDelete(params, TAB_PARAM, options.tab === "Overview" ? null : options.tab)

  if (options.workers) {
    const { search, sort, hiddenColumns, selectedWorkerId } = options.workers
    setOrDelete(params, SEARCH_PARAM, search.trim() || null)
    setOrDelete(params, SORT_PARAM, sort?.key)
    setOrDelete(params, DIRECTION_PARAM, sort?.direction)
    setOrDelete(params, COLUMNS_PARAM, hiddenColumns.length ? hiddenColumns.join(",") : null)
    setOrDelete(params, SELECTED_WORKER_PARAM, selectedWorkerId)
  }

  return params.toString()
}

export function replaceOrchestrationViewUrl(options: { tab?: OrchestrationTab; workers?: WorkersViewUrlState }) {
  const search = buildOrchestrationViewSearch(window.location.search, options)
  const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`
  window.history.replaceState(window.history.state, "", url)
}
