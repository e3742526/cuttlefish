import { describe, it, expect, vi } from "vitest"
import { render, screen, within, fireEvent } from "@testing-library/react"
import { DataTable, type DataTableColumn } from "../data-table"

interface Row {
  id: string
  name: string
  score: number
}

const COLUMNS: DataTableColumn<Row>[] = [
  { key: "id", label: "ID", render: (r) => r.id, sortValue: (r) => r.id, required: true },
  { key: "name", label: "Name", render: (r) => r.name, sortValue: (r) => r.name },
  { key: "score", label: "Score", render: (r) => r.score, sortValue: (r) => r.score, align: "right" },
]

const ROWS: Row[] = [
  { id: "b", name: "Bravo", score: 2 },
  { id: "a", name: "Alpha", score: 3 },
  { id: "c", name: "Charlie", score: 1 },
]

describe("DataTable", () => {
  it("renders every row and column", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} />)
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.getByText("Bravo")).toBeTruthy()
    expect(screen.getByText("Charlie")).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: /Name/ })).toBeTruthy()
  })

  it("renders the empty state instead of a table when there are no rows", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(r) => r.id}
        emptyState={<div data-testid="empty">Nothing here</div>}
      />,
    )
    expect(screen.getByTestId("empty")).toBeTruthy()
    expect(screen.queryByRole("table")).toBeNull()
  })

  it("sorts ascending, then descending, then clears on repeated header clicks", () => {
    const onSortChange = vi.fn()
    const { rerender } = render(
      <DataTable columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} sort={null} onSortChange={onSortChange} />,
    )
    const header = screen.getByRole("button", { name: /Name/ })
    header.click()
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", direction: "asc" })

    rerender(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(r) => r.id}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={onSortChange}
      />,
    )
    screen.getByRole("button", { name: /Name/ }).click()
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", direction: "desc" })

    rerender(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(r) => r.id}
        sort={{ key: "name", direction: "desc" }}
        onSortChange={onSortChange}
      />,
    )
    screen.getByRole("button", { name: /Name/ }).click()
    expect(onSortChange).toHaveBeenLastCalledWith(null)
  })

  it("actually reorders rows when a sort is applied", () => {
    render(
      <DataTable columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} sort={{ key: "name", direction: "asc" }} />,
    )
    const table = screen.getByRole("table")
    const rowTexts = within(table)
      .getAllByRole("row")
      .slice(1) // drop the header row
      .map((row) => row.textContent)
    expect(rowTexts).toEqual(["Alpha", "Bravo", "Charlie"].map((n) => expect.stringContaining(n)))
  })

  it("hides columns listed in hiddenColumns but never a required column", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} hiddenColumns={["name", "id"]} />)
    expect(screen.queryByRole("columnheader", { name: /Name/ })).toBeNull()
    expect(screen.getByRole("columnheader", { name: "ID" })).toBeTruthy()
  })

  it("calls onRowClick with the clicked row", () => {
    const onRowClick = vi.fn()
    render(<DataTable columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} onRowClick={onRowClick} />)
    const row = screen.getByText("Alpha").closest('[role="row"]')
    expect(row).toBeTruthy()
    fireEvent.click(row!)
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1])
  })

  it("renders without crashing when the row count exceeds the virtualization threshold", () => {
    const manyRows: Row[] = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}`, score: i }))
    render(<DataTable columns={COLUMNS} rows={manyRows} getRowKey={(r) => r.id} virtualizeThreshold={50} />)
    expect(screen.getByRole("table")).toBeTruthy()
  })

  it("sorts nullish sortValue results to the end regardless of direction", () => {
    interface NullableRow {
      id: string
      value: number | null
    }
    const columns: DataTableColumn<NullableRow>[] = [
      { key: "id", label: "ID", render: (r) => r.id, required: true },
      { key: "value", label: "Value", render: (r) => String(r.value), sortValue: (r) => r.value },
    ]
    const rows: NullableRow[] = [
      { id: "has-2", value: 2 },
      { id: "null", value: null },
      { id: "has-1", value: 1 },
    ]

    const { rerender } = render(
      <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} sort={{ key: "value", direction: "asc" }} />,
    )
    let ids = within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent)
    expect(ids?.at(-1)).toContain("null")

    rerender(
      <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} sort={{ key: "value", direction: "desc" }} />,
    )
    ids = within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent)
    expect(ids?.at(-1)).toContain("null")
  })
})
