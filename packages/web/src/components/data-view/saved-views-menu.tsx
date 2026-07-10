import { Bookmark, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { SavedView, SortState } from "."

interface SavedViewsMenuProps<TFilters> {
  savedViews: SavedView<TFilters>[]
  pinnedViewId: string | null
  currentFilters: TFilters
  currentSort: SortState | null
  currentHiddenColumns: string[]
  onApply: (view: SavedView<TFilters>) => void
  onSave: (view: Omit<SavedView<TFilters>, "id">) => void
  onDelete: (id: string) => void
}

/**
 * Named, saveable presets of a DataView's current filter + sort + column
 * state (see docs/plans/2026-07-10-fleetview-ux-implementation-plan.md,
 * Section 11 — saved views). Naming uses a plain prompt() rather than a
 * dedicated dialog, consistent with other lightweight naming flows in this
 * app (e.g. orchestration's hold-creation prompts).
 */
export function SavedViewsMenu<TFilters>({
  savedViews,
  pinnedViewId,
  currentFilters,
  currentSort,
  currentHiddenColumns,
  onApply,
  onSave,
  onDelete,
}: SavedViewsMenuProps<TFilters>) {
  function saveCurrentView() {
    const name = window.prompt("Name this view")?.trim()
    if (!name) return
    onSave({ name, filters: currentFilters, sort: currentSort, hiddenColumns: currentHiddenColumns })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Saved views">
          <Bookmark className="size-3.5" />
          Views
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Saved views</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {savedViews.length === 0 ? (
          <div className="px-2 py-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            No saved views yet.
          </div>
        ) : (
          savedViews.map((view) => (
            <DropdownMenuItem
              key={view.id}
              onSelect={() => onApply(view)}
              className="flex items-center justify-between gap-2"
            >
              <span className={cn("truncate", pinnedViewId === view.id && "font-semibold")}>{view.name}</span>
              <button
                type="button"
                aria-label={`Delete view "${view.name}"`}
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(view.id)
                }}
                className="shrink-0 rounded-sm p-0.5 text-[var(--text-tertiary)] hover:text-[var(--system-red)]"
              >
                <X className="size-3" />
              </button>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={saveCurrentView}>
          <Plus className="size-3.5" />
          Save current view…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
