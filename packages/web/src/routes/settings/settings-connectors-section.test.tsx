import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SettingsConnectorsSection } from "./settings-connectors-section"
import type { Config } from "./settings-constants"

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
    api: {
      ...actual.api,
      reloadConnectors: vi.fn(async () => ({ started: [], stopped: [], errors: [] })),
    },
  }
})

function setAtPath(config: Config, path: string[], value: unknown): Config {
  const next = structuredClone(config)
  let obj: Record<string, unknown> = next as Record<string, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    if (!obj[path[i]] || typeof obj[path[i]] !== "object") obj[path[i]] = {}
    obj = obj[path[i]] as Record<string, unknown>
  }
  obj[path[path.length - 1]] = value
  return next
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label>
      <span>{label}</span>
      {children}
    </label>
  )
}

function SettingsInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function SettingsSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select aria-label={options[0]?.label ?? "select"} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return <button onClick={() => onChange(!checked)}>{checked ? "on" : "off"}</button>
}

function Harness() {
  const [config, setConfig] = useState<Config>({ connectors: {} })
  return (
    <SettingsConnectorsSection
      config={config}
      updateConfig={(path, value) => setConfig((prev) => setAtPath(prev, path, value))}
      waQr={null}
      waStatus="unknown"
      employees={[{ name: "vox", displayName: "Vox" }]}
      Section={Section}
      FieldRow={FieldRow}
      SettingsInput={SettingsInput}
      SettingsSelect={SettingsSelect}
      ToggleSwitch={ToggleSwitch}
    />
  )
}

describe("SettingsConnectorsSection", () => {
  it("keeps the instance ID input focused while its editable value changes", () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: /\+ add instance/i }))
    const instanceIdInput = screen.getByDisplayValue("slack-1")
    instanceIdInput.focus()

    for (const value of ["o", "op", "ops"]) {
      fireEvent.change(instanceIdInput, { target: { value } })
      expect(screen.getByDisplayValue(value)).toBe(instanceIdInput)
      expect(document.activeElement).toBe(instanceIdInput)
    }
  })

  it("adds, edits, switches, and removes connector instances through updateConfig", () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: /\+ add instance/i }))
    expect(screen.getByDisplayValue("slack-1")).toBeTruthy()
    expect(screen.queryByText("Discord")).toBeNull()
    expect(screen.queryByText("Telegram")).toBeNull()
    expect(screen.getByDisplayValue("Slack")).toBeTruthy()

    fireEvent.change(screen.getByDisplayValue("slack-1"), { target: { value: "slack-ops" } })
    expect(screen.getByDisplayValue("slack-ops")).toBeTruthy()

    const selects = screen.getAllByRole("combobox")
    fireEvent.change(selects[0], { target: { value: "whatsapp" } })
    expect(screen.getByDisplayValue("WhatsApp")).toBeTruthy()
    expect(screen.getAllByPlaceholderText("Default: ~/.cuttlefish/.whatsapp-auth")).toHaveLength(2)

    fireEvent.change(selects[0], { target: { value: "slack" } })
    expect(screen.getAllByPlaceholderText("xapp-...")).toHaveLength(2)
    expect(screen.getAllByPlaceholderText("xoxb-...")).toHaveLength(2)

    fireEvent.click(screen.getAllByRole("button").at(-1)!)
    expect(screen.queryByDisplayValue("slack-ops")).toBeNull()
  })
})
