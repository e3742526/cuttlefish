export interface ExportColumn<T> {
  key: string
  label: string
  value: (row: T) => string | number | boolean | null | undefined
}

function escapeCsvCell(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value)
  // Neutralize CSV/Excel formula injection: a leading =, +, -, or @ can be
  // interpreted as a formula (or, on older Excel, a DDE command) when the
  // file is opened in a spreadsheet app. Prefixing with a single quote marks
  // the cell as text without changing its visible content (OWASP mitigation).
  const safe = /^[=+\-@]/.test(str.trimStart()) ? `'${str}` : str
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`
  return safe
}

function download(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * Exports `rows` (the already-filtered set currently on screen — this
 * intentionally never reaches past what the caller passes in, so it can
 * never silently export more than what's visible) as CSV, labeled with the
 * export timestamp so a downloaded file is traceable to when it was taken.
 */
export function exportRowsAsCsv<T>(rows: T[], columns: ExportColumn<T>[], filenamePrefix: string) {
  const header = columns.map((c) => escapeCsvCell(c.label)).join(",")
  const lines = rows.map((row) => columns.map((c) => escapeCsvCell(c.value(row))).join(","))
  const csv = [header, ...lines].join("\n")
  download(`${filenamePrefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`, csv, "text/csv")
}

export function exportRowsAsJson<T>(rows: T[], columns: ExportColumn<T>[], filenamePrefix: string) {
  const data = rows.map((row) =>
    Object.fromEntries(columns.map((c) => [c.key, c.value(row)])),
  )
  download(
    `${filenamePrefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
    JSON.stringify(data, null, 2),
    "application/json",
  )
}
