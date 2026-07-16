import { useState } from "react"
import { describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { EmailSettingsSection } from "./settings-config-sections"
import type { Config } from "./settings-constants"

function setAtPath(config: Config, path: string[], value: unknown): Config {
  const next = structuredClone(config)
  let obj: Record<string, unknown> = next as Record<string, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!obj[path[index]] || typeof obj[path[index]] !== "object") obj[path[index]] = {}
    obj = obj[path[index]] as Record<string, unknown>
  }
  obj[path[path.length - 1]] = value
  return next
}

function Harness() {
  const [config, setConfig] = useState<Config>({ email: { inboxes: [] } })
  return (
    <EmailSettingsSection
      config={config}
      updateConfig={(path, value) => setConfig((prev) => setAtPath(prev, path, value))}
      updateNumberConfig={(path, value) => setConfig((prev) => setAtPath(prev, path, value.trim() ? Number(value) : undefined))}
    />
  )
}

describe("EmailSettingsSection", () => {
  it("keeps the inbox ID input focused while its editable value changes", () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: /add inbox/i }))
    const inboxIdInput = screen.getByDisplayValue("inbox-1")
    inboxIdInput.focus()

    for (const value of ["c", "cu", "cut", "cutt"]) {
      fireEvent.change(inboxIdInput, { target: { value } })
      expect(screen.getByDisplayValue(value)).toBe(inboxIdInput)
      expect(document.activeElement).toBe(inboxIdInput)
    }
  })

  it("adds and removes inboxes while enforcing the three-inbox cap", () => {
    render(<Harness />)

    const addButton = screen.getByRole("button", { name: /add inbox/i })
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)

    expect(screen.getAllByDisplayValue(/Inbox \d/)).toHaveLength(3)
    expect((addButton as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getAllByRole("button", { name: /remove/i })[0])

    expect(screen.getAllByDisplayValue(/Inbox \d/)).toHaveLength(2)
    expect((addButton as HTMLButtonElement).disabled).toBe(false)
  })
})
