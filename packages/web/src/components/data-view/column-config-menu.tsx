import { Columns3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

export interface ColumnConfigOption {
  key: string
  label: string
  /** Columns marked required can't be hidden (e.g. the primary identifying column). */
  required?: boolean
}

interface ColumnConfigMenuProps {
  columns: ColumnConfigOption[]
  hiddenColumns: string[]
  onChange: (hiddenColumns: string[]) => void
}

export function ColumnConfigMenu({ columns, hiddenColumns, onChange }: ColumnConfigMenuProps) {
  const hidden = new Set(hiddenColumns)

  function toggle(key: string, visible: boolean) {
    const next = new Set(hidden)
    if (visible) next.delete(key)
    else next.add(key)
    onChange([...next])
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Configure columns">
          <Columns3 className="size-3.5" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.key}
            checked={!hidden.has(column.key)}
            disabled={column.required}
            onCheckedChange={(checked) => toggle(column.key, checked === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
