import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { exportRowsAsCsv, exportRowsAsJson, type ExportColumn } from "../export-rows"

interface Row {
  name: string
  note: string
  count: number
}

const COLUMNS: ExportColumn<Row>[] = [
  { key: "name", label: "Name", value: (r) => r.name },
  { key: "note", label: "Note", value: (r) => r.note },
  { key: "count", label: "Count", value: (r) => r.count },
]

const ROWS: Row[] = [
  { name: "Alpha", note: 'has a "quote", and a comma', count: 3 },
  { name: "Bravo", note: "plain", count: 5 },
]

describe("exportRowsAsCsv / exportRowsAsJson", () => {
  let createdBlobs: Blob[]
  let clickSpy: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    createdBlobs = []
    clickSpy = vi.fn<() => void>()
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      createdBlobs.push(blob as Blob)
      return "blob:mock"
    })
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const realCreateElement = document.createElement.bind(document)
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreateElement(tag)
      if (tag === "a") el.click = clickSpy
      return el
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("produces a CSV with a header row and escapes quotes/commas", async () => {
    exportRowsAsCsv(ROWS, COLUMNS, "test-export")
    expect(clickSpy).toHaveBeenCalledOnce()
    const text = await createdBlobs[0].text()
    const lines = text.split("\n")
    expect(lines[0]).toBe("Name,Note,Count")
    expect(lines[1]).toBe('Alpha,"has a ""quote"", and a comma",3')
    expect(lines[2]).toBe("Bravo,plain,5")
  })

  it("quotes a cell containing a bare carriage return (no accompanying \\n)", async () => {
    exportRowsAsCsv([{ name: "Windows", note: "line one\rline two", count: 1 }], COLUMNS, "test-export")
    const text = await createdBlobs[0].text()
    expect(text).toContain('"line one\rline two"')
  })

  it("produces JSON keyed by column key", async () => {
    exportRowsAsJson(ROWS, COLUMNS, "test-export")
    expect(clickSpy).toHaveBeenCalledOnce()
    const text = await createdBlobs[0].text()
    const parsed = JSON.parse(text)
    expect(parsed).toEqual([
      { name: "Alpha", note: 'has a "quote", and a comma', count: 3 },
      { name: "Bravo", note: "plain", count: 5 },
    ])
  })

  it("exports nothing more than the rows passed in", async () => {
    exportRowsAsCsv([ROWS[0]], COLUMNS, "test-export")
    const text = await createdBlobs[0].text()
    expect(text.split("\n")).toHaveLength(2) // header + 1 row
  })

  it("neutralizes a leading = to prevent formula injection", async () => {
    exportRowsAsCsv([{ name: "Mallory", note: "=SUM(A1:A10)", count: 1 }], COLUMNS, "test-export")
    const text = await createdBlobs[0].text()
    expect(text.split("\n")[1]).toBe("Mallory,'=SUM(A1:A10),1")
  })

  it.each(["+", "-", "@"])("neutralizes a leading %s to prevent formula injection", async (prefix) => {
    exportRowsAsCsv([{ name: "Mallory", note: `${prefix}cmd|'/c calc'!A1`, count: 1 }], COLUMNS, "test-export")
    const text = await createdBlobs[0].text()
    expect(text.split("\n")[1]).toBe(`Mallory,'${prefix}cmd|'/c calc'!A1,1`)
  })

  it("leaves normal text and numeric cells unaffected", async () => {
    exportRowsAsCsv([{ name: "hello", note: "plain", count: 42 }], COLUMNS, "test-export")
    const text = await createdBlobs[0].text()
    expect(text.split("\n")[1]).toBe("hello,plain,42")
  })

  it("applies formula-injection neutralization together with comma/quote escaping", async () => {
    exportRowsAsCsv(
      [{ name: "Mallory", note: '=HYPERLINK("http://evil","x"), oops', count: 1 }],
      COLUMNS,
      "test-export",
    )
    const text = await createdBlobs[0].text()
    expect(text.split("\n")[1]).toBe('Mallory,"\'=HYPERLINK(""http://evil"",""x""), oops",1')
  })
})
