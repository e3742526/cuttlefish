import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@/components/chat/model-selector-row", () => ({
  ModelSelectorRow: () => null,
}))

vi.mock("@/components/org/employee-fallback-model-select", () => ({
  EmployeeFallbackModelSelect: ({
    valueEngine,
    value,
    onEngineChange,
    onChange,
  }: {
    valueEngine?: string
    value: string
    onEngineChange: (next: string) => void
    onChange: (next: string) => void
  }) => (
    <>
      <select aria-label="Fallback engine" value={valueEngine} onChange={(e) => onEngineChange(e.target.value)}>
        <option value="claude">Claude</option>
        <option value="antigravity">Antigravity</option>
      </select>
      <select aria-label="Fallback model" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">None</option>
        <option value="claude-sonnet-4-6">Sonnet 4.6</option>
        <option value="Gemini 3.5 Flash (Medium)">Gemini 3.5 Flash Medium</option>
      </select>
    </>
  ),
}))
vi.mock("@/components/ui/select", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  const SelectContext = React.createContext<{
    disabled?: boolean
    onValueChange: (value: string) => void
    value?: string
  }>({ onValueChange: () => {} })

  return {
    Select: ({
      children,
      disabled,
      onValueChange,
      value,
    }: {
      children: React.ReactNode
      disabled?: boolean
      onValueChange: (value: string) => void
      value?: string
    }) => (
      <SelectContext.Provider value={{ disabled, onValueChange, value }}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ children: _children, ...props }: React.HTMLAttributes<HTMLInputElement>) => {
      const ctx = React.useContext(SelectContext)
      return (
        <input
          {...props}
          role="combobox"
          value={ctx.value ?? ""}
          disabled={ctx.disabled}
          onChange={(event) => ctx.onValueChange(event.currentTarget.value)}
        />
      )
    },
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const ctx = React.useContext(SelectContext)
      return (
        <button type="button" role="option" onClick={() => ctx.onValueChange(value)}>
          {children}
        </button>
      )
    },
  }
})

vi.mock("@/components/org/reports-to-field", async () => {
  const actual = await vi.importActual<typeof import("@/components/org/reports-to-field")>("@/components/org/reports-to-field")
  return {
    ...actual,
    ReportsToField: ({
      onChange,
    }: {
      onChange: (next: string[]) => void
    }) => (
      <button type="button" aria-label="Add matrix supervisors" onClick={() => onChange(["lead-a", "lead-b"])}>
        Add matrix supervisors
      </button>
    ),
  }
})

const createEmployee = vi.fn()
const getOrg = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    createEmployee: (...a: unknown[]) => createEmployee(...a),
    getOrg: (...a: unknown[]) => getOrg(...a),
  },
}))

import { EmployeeCreateForm } from "./employee-create-form"

const createBtn = () => screen.getByRole("button", { name: /Create agent|Creating/ }) as HTMLButtonElement
async function chooseSelect(label: string, option: string) {
  expect(screen.getByRole("combobox", { name: label })).toBeTruthy()
  fireEvent.click(await screen.findByRole("option", { name: option }))
}

beforeEach(() => {
  createEmployee.mockReset()
  getOrg.mockReset()
  getOrg.mockResolvedValue({
    departments: ["platform"],
    employees: [
      { name: "cuttlefish", department: "" },
      { name: "lead-a", department: "platform" },
      { name: "lead-b", department: "platform" },
    ],
  })
})

describe("EmployeeCreateForm", () => {
  it("disables create until required fields are present", async () => {
    render(<EmployeeCreateForm onCancel={() => {}} onCreated={() => {}} />)
    expect(createBtn().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Platform Lead" } })
    await chooseSelect("Department", "platform")
    fireEvent.change(screen.getByLabelText("Persona / instructions"), { target: { value: "Lead platform work." } })

    expect(createBtn().disabled).toBe(false)
  })

  it("creates an agent and returns the created employee", async () => {
    const onCreated = vi.fn()
    createEmployee.mockResolvedValue({
      status: "ok",
      employee: {
        name: "platform-lead",
        displayName: "Platform Lead",
        department: "platform",
        rank: "manager",
        engine: "claude",
        model: "sonnet",
        persona: "Lead platform work.",
      },
    })

    render(<EmployeeCreateForm onCancel={() => {}} onCreated={onCreated} />)

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Platform Lead" } })
    await chooseSelect("Department", "platform")
    fireEvent.change(screen.getByLabelText("Persona / instructions"), { target: { value: "Lead platform work." } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1))
    expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({
      name: "platform-lead",
      department: "platform",
      persona: "Lead platform work.",
    }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  it("creates an agent with ordered matrix supervisors", async () => {
    createEmployee.mockResolvedValue({
      status: "ok",
      employee: {
        name: "platform-lead",
        displayName: "Platform Lead",
        department: "platform",
        rank: "manager",
        engine: "claude",
        model: "sonnet",
        persona: "Lead platform work.",
        reportsTo: ["lead-a", "lead-b"],
      },
    })

    render(<EmployeeCreateForm onCancel={() => {}} onCreated={() => {}} />)

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Platform Lead" } })
    fireEvent.change(screen.getByLabelText("Persona / instructions"), { target: { value: "Lead platform work." } })

    fireEvent.click(screen.getByRole("button", { name: "Add matrix supervisors" }))
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Department" }) as HTMLInputElement).value).toBe("platform"),
    )

    fireEvent.click(createBtn())

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1))
    expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({
      department: "platform",
      reportsTo: ["lead-a", "lead-b"],
    }))
  })

  it("allows creating a custom department", async () => {
    createEmployee.mockResolvedValue({
      status: "ok",
      employee: {
        name: "security-reviewer",
        displayName: "Security Reviewer",
        department: "security",
        rank: "employee",
        engine: "claude",
        model: "sonnet",
        persona: "Review security.",
      },
    })

    render(<EmployeeCreateForm onCancel={() => {}} onCreated={() => {}} />)

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Security Reviewer" } })
    await chooseSelect("Department", "New department…")
    fireEvent.change(screen.getByLabelText("New department name"), { target: { value: "security" } })
    fireEvent.change(screen.getByLabelText("Persona / instructions"), { target: { value: "Review security." } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({
      department: "security",
    })))
  })

  it("creates an agent with a cross-provider fallback target", async () => {
    createEmployee.mockResolvedValue({
      status: "ok",
      employee: {
        name: "platform-lead",
        displayName: "Platform Lead",
        department: "platform",
        rank: "manager",
        engine: "claude",
        model: "sonnet",
        persona: "Lead platform work.",
        modelPolicy: { fallback_chain: [{ engine: "antigravity", model: "Gemini 3.5 Flash (Medium)" }] },
      },
    })

    render(<EmployeeCreateForm onCancel={() => {}} onCreated={() => {}} />)

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Platform Lead" } })
    await chooseSelect("Department", "platform")
    fireEvent.change(screen.getByLabelText("Persona / instructions"), { target: { value: "Lead platform work." } })
    fireEvent.change(screen.getByRole("combobox", { name: "Fallback engine" }), {
      target: { value: "antigravity" },
    })
    fireEvent.change(screen.getByRole("combobox", { name: "Fallback model" }), {
      target: { value: "Gemini 3.5 Flash (Medium)" },
    })
    fireEvent.click(createBtn())

    await waitFor(() => expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({
      fallbackEngine: "antigravity",
      fallbackModel: "Gemini 3.5 Flash (Medium)",
    })))
  })
})
