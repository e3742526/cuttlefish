import { useMemo, useRef, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Density } from "./use-view-preferences"

export interface SortState {
  key: string
  direction: "asc" | "desc"
}

export interface DataTableColumn<T> {
  key: string
  label: string
  render: (row: T) => ReactNode
  /** Omit for a non-sortable column. */
  sortValue?: (row: T) => string | number
  align?: "left" | "right" | "center"
  /** CSS width, e.g. "140px". Omit for a flexible (1fr) column. */
  width?: string
  /** Columns marked required are always shown regardless of `hiddenColumns`. */
  required?: boolean
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  getRowKey: (row: T) => string
  hiddenColumns?: string[]
  density?: Density
  sort?: SortState | null
  onSortChange?: (sort: SortState | null) => void
  onRowClick?: (row: T) => void
  rowClassName?: (row: T) => string | undefined
  emptyState?: ReactNode
  className?: string
  /** Rows beyond this count are virtualized. Default 50. */
  virtualizeThreshold?: number
}

const ROW_HEIGHT: Record<Density, number> = {
  comfortable: 44,
  compact: 32,
}

function alignClass(align: DataTableColumn<unknown>["align"]): string {
  if (align === "right") return "text-right"
  if (align === "center") return "text-center"
  return "text-left"
}

/**
 * Generic, virtualized, sortable, column-configurable table — the shared
 * body of the Queue/Table page template (see
 * docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 5.2 and
 * 11). Sorting, density, and column visibility are all controlled by the
 * caller (typically via useViewPreferences) so state lives with the surface,
 * not the table.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  hiddenColumns = [],
  density = "comfortable",
  sort = null,
  onSortChange,
  onRowClick,
  rowClassName,
  emptyState,
  className,
  virtualizeThreshold = 50,
}: DataTableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const hidden = new Set(hiddenColumns)
  const visibleColumns = columns.filter((c) => c.required || !hidden.has(c.key))

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const column = columns.find((c) => c.key === sort.key)
    if (!column?.sortValue) return rows
    const sortValue = column.sortValue
    const sign = sort.direction === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = sortValue(a)
      const bv = sortValue(b)
      if (av < bv) return -1 * sign
      if (av > bv) return 1 * sign
      return 0
    })
  }, [rows, sort, columns])

  const shouldVirtualize = sortedRows.length > virtualizeThreshold
  const rowHeight = ROW_HEIGHT[density]
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? sortedRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    enabled: shouldVirtualize,
  })

  function toggleSort(column: DataTableColumn<T>) {
    if (!column.sortValue || !onSortChange) return
    if (sort?.key !== column.key) {
      onSortChange({ key: column.key, direction: "asc" })
    } else if (sort.direction === "asc") {
      onSortChange({ key: column.key, direction: "desc" })
    } else {
      onSortChange(null)
    }
  }

  if (sortedRows.length === 0 && emptyState) {
    return <>{emptyState}</>
  }

  const gridTemplate = visibleColumns.map((c) => c.width ?? "1fr").join(" ")

  const headerRow = (
    <div
      role="row"
      className="sticky top-0 z-[1] grid items-center gap-[var(--space-3)] border-b border-[var(--separator)] bg-[var(--material-regular)] px-[var(--space-3)] text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]"
      style={{ gridTemplateColumns: gridTemplate, height: rowHeight }}
    >
      {visibleColumns.map((column) => (
        <div key={column.key} role="columnheader" className={alignClass(column.align)}>
          {column.sortValue ? (
            <button
              type="button"
              onClick={() => toggleSort(column)}
              className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
            >
              {column.label}
              {sort?.key === column.key ? (
                sort.direction === "asc" ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )
              ) : (
                <ChevronsUpDown className="size-3 opacity-40" />
              )}
            </button>
          ) : (
            column.label
          )}
        </div>
      ))}
    </div>
  )

  function renderRow(row: T) {
    const key = getRowKey(row)
    return (
      <div
        key={key}
        role="row"
        tabIndex={onRowClick ? 0 : undefined}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
        onKeyDown={
          onRowClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onRowClick(row)
                }
              }
            : undefined
        }
        className={cn(
          "grid items-center gap-[var(--space-3)] border-b border-[var(--separator)] px-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-primary)]",
          onRowClick && "cursor-pointer hover:bg-[var(--fill-secondary)]",
          rowClassName?.(row),
        )}
        style={{ gridTemplateColumns: gridTemplate, height: rowHeight }}
      >
        {visibleColumns.map((column) => (
          <div key={column.key} className={cn("min-w-0 truncate", alignClass(column.align))}>
            {column.render(row)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      role="table"
      className={cn("overflow-hidden rounded-[var(--radius-md)] border border-[var(--separator)]", className)}
    >
      {headerRow}
      <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto">
        {shouldVirtualize ? (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {renderRow(sortedRows[item.index])}
              </div>
            ))}
          </div>
        ) : (
          sortedRows.map((row) => renderRow(row))
        )}
      </div>
    </div>
  )
}
