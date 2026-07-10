import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { exportRowsAsCsv, exportRowsAsJson, type ExportColumn } from "./export-rows"

interface ExportMenuProps<T> {
  rows: T[]
  columns: ExportColumn<T>[]
  filenamePrefix: string
}

/**
 * Exports exactly `rows` — the caller's already-filtered set — never a
 * larger unfiltered dataset. The row count is shown in the menu so what
 * you're about to download is never a surprise.
 */
export function ExportMenu<T>({ rows, columns, filenamePrefix }: ExportMenuProps<T>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Export">
          <Download className="size-3.5" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {rows.length} row{rows.length === 1 ? "" : "s"} (current filters)
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => exportRowsAsCsv(rows, columns, filenamePrefix)}>
          Export as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => exportRowsAsJson(rows, columns, filenamePrefix)}>
          Export as JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
