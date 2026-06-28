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

beforeEach(() => {
  createEmployee.mockReset()
  getOrg.mockReset()
  getOrg.mockResolvedValue({
    departments: ["platform"],
    employees: [{ name: "cuttlefish" }, { name: "lead-a" }, { name: "lead-b" }],
  })
})

describe("EmployeeCreateForm", () => {
  it("disables create until required fields are present", () => {
    render(<EmployeeCreateForm onCancel={() => {}} onCreated={() => {}} />)
    expect(createBtn().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Platform Lead" } })
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "platform" } })
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
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "platform" } })
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
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "platform" } })
    fireEvent.change(screen.getByLabelText("Persona / instructions"), { target: { value: "Lead platform work." } })

    fireEvent.click(screen.getByRole("button", { name: "Add matrix supervisors" }))

    fireEvent.click(createBtn())

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1))
    expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({
      reportsTo: ["lead-a", "lead-b"],
    }))
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
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "platform" } })
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
