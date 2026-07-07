import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Employee } from "@/lib/api"
import { emojiForName } from "@/lib/emoji-pool"

// ModelSelectorRow has its own tests + needs the model registry; stub it here so
// this test focuses on the editor's own behavior (validation, diffing, save).
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
      <select
        aria-label="Fallback engine"
        value={valueEngine}
        onChange={(e) => onEngineChange(e.target.value)}
      >
        <option value="claude">Claude</option>
        <option value="antigravity">Antigravity</option>
      </select>
      <select
        aria-label="Fallback model"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">None</option>
        <option value="claude-sonnet-4-6">Sonnet 4.6</option>
        <option value="Gemini 3.5 Flash (Medium)">Gemini 3.5 Flash Medium</option>
      </select>
    </>
  ),
}))
// RoleAgentConfig has its own tests + needs the model registry; stub it with a
// button that injects a fixed policy so this test can exercise the roles diff.
vi.mock("@/components/org/role-agent-config", () => ({
  RoleAgentConfig: ({
    roleLabel,
    onChange,
  }: {
    roleLabel: string
    onChange: (next: unknown) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange({
          override: { model: "claude-haiku-4-5" },
          fallbackChain: [{ engine: "codex", model: "gpt-5.5" }, { employee: "review-lead" }],
        })
      }
    >
      Set {roleLabel} test policy
    </button>
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

const updateEmployee = vi.fn()
const deleteEmployee = vi.fn()
const getOrg = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    updateEmployee: (...a: unknown[]) => updateEmployee(...a),
    deleteEmployee: (...a: unknown[]) => deleteEmployee(...a),
    getOrg: (...a: unknown[]) => getOrg(...a),
  },
}))

import { EmployeeEditor } from "./employee-editor"

const EMP: Employee = {
  name: "content-writer",
  displayName: "Content Writer",
  department: "content",
  rank: "employee",
  engine: "claude",
  model: "sonnet",
  persona: "You write blog posts.",
}

const saveBtn = () => screen.getByRole("button", { name: /^(Save|Saving)/ }) as HTMLButtonElement
async function chooseSelect(label: string, option: string) {
  expect(screen.getByRole("combobox", { name: label })).toBeTruthy()
  fireEvent.click(await screen.findByRole("option", { name: option }))
}

beforeEach(() => {
  updateEmployee.mockReset()
  deleteEmployee.mockReset()
  getOrg.mockReset()
  getOrg.mockResolvedValue({
    departments: ["content", "engineering"],
    employees: [
      { name: "content-lead", department: "content" },
      { name: "review-lead", department: "engineering" },
    ],
  })
})

describe("EmployeeEditor", () => {
  it("disables Save when pristine and when persona is emptied", () => {
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)
    expect(saveBtn().disabled).toBe(true) // pristine

    const persona = screen.getByDisplayValue("You write blog posts.")
    fireEvent.change(persona, { target: { value: "   " } })
    expect(saveBtn().disabled).toBe(true)
    expect(screen.getByText("Persona cannot be empty.")).toBeTruthy()
  })

  it("describes non-solo execution as profile configuration", () => {
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)

    expect(screen.getByText("Execution profile")).toBeTruthy()
    expect(screen.getByText("Review profile")).toBeTruthy()
    expect(screen.queryByText("Built-in review")).toBeNull()
    expect(screen.getByText(/Solo remains the normal runtime path/i)).toBeTruthy()
  })

  it("sends per-role sub-agent overrides and failover chain in execution.roles", async () => {
    updateEmployee.mockResolvedValue({ status: "ok", employee: EMP })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole("option", { name: "Review profile" }))
    fireEvent.click(screen.getByRole("button", { name: "Set Reviewer test policy" }))
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1))
    const patch = updateEmployee.mock.calls[0][1] as { execution?: { tier?: string; roles?: unknown } }
    expect(patch.execution?.tier).toBe("mid_pair")
    expect(patch.execution?.roles).toEqual({
      reviewer: {
        override: { model: "claude-haiku-4-5" },
        fallbackChain: [{ engine: "codex", model: "gpt-5.5" }, { employee: "review-lead" }],
      },
    })
  })

  it("keeps Save disabled when a mid_pair employee's roles are unchanged", () => {
    const emp: Employee = {
      ...EMP,
      execution: {
        tier: "mid_pair",
        roles: { reviewer: { fallbackChain: [{ engine: "codex", model: "gpt-5.5" }] } },
      },
    }
    render(<EmployeeEditor employee={emp} onCancel={() => {}} onSaved={() => {}} />)
    expect(saveBtn().disabled).toBe(true) // pristine — normalization must not create phantom diffs
  })

  it("sends only the changed fields and calls onSaved on success", async () => {
    const onSaved = vi.fn()
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, persona: "New persona." } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByDisplayValue("You write blog posts."), { target: { value: "New persona." } })
    expect(saveBtn().disabled).toBe(false)
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1))
    expect(updateEmployee).toHaveBeenCalledWith("content-writer", { persona: "New persona." })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...EMP, persona: "New persona." }))
  })

  it("sends fallbackModel when the fallback selection changes", async () => {
    const onSaved = vi.fn()
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, modelPolicy: { fallback_chain: [{ engine: "claude", model: "claude-sonnet-4-6" }] } } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByRole("combobox", { name: "Fallback model" }), {
      target: { value: "claude-sonnet-4-6" },
    })
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("content-writer", {
      fallbackModel: "claude-sonnet-4-6",
    }))
  })

  it("sends an empty department when the department field is cleared", async () => {
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, department: "" } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)

    await chooseSelect("Department", "Unassigned")
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("content-writer", {
      department: "",
    }))
  })

  it("allows creating a new department name from the editor", async () => {
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, department: "security" } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)

    await chooseSelect("Department", "New department…")
    fireEvent.change(screen.getByLabelText("New department name"), { target: { value: "security" } })
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("content-writer", {
      department: "security",
    }))
  })

  it("prepopulates the department from the newly assigned primary supervisor", async () => {
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, department: "engineering", reportsTo: "review-lead" } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)

    await chooseSelect("Add supervisor", "review-lead")
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("content-writer", {
      department: "engineering",
      reportsTo: "review-lead",
    }))
  })

  it("sends fallbackEngine together with a cross-provider fallback model", async () => {
    updateEmployee.mockResolvedValue({
      status: "ok",
      employee: {
        ...EMP,
        modelPolicy: { fallback_chain: [{ engine: "antigravity", model: "Gemini 3.5 Flash (Medium)" }] },
      },
    })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)

    fireEvent.change(screen.getByRole("combobox", { name: "Fallback engine" }), {
      target: { value: "antigravity" },
    })
    fireEvent.change(screen.getByRole("combobox", { name: "Fallback model" }), {
      target: { value: "Gemini 3.5 Flash (Medium)" },
    })
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("content-writer", {
      fallbackEngine: "antigravity",
      fallbackModel: "Gemini 3.5 Flash (Medium)",
    }))
  })

  it("sends the chosen ocean avatar (and clears emoji) when the icon changes", async () => {
    const onSaved = vi.fn()
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, avatar: "nautical:anchor" } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={onSaved} />)

    // The header avatar opens the icon picker; "content-writer" has no icon yet,
    // so it renders its deterministic fallback emoji.
    fireEvent.click(screen.getByText(emojiForName("content-writer")))
    fireEvent.click(screen.getByRole("button", { name: "Anchor" }))
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("content-writer", {
      avatar: "nautical:anchor",
      emoji: "",
    }))
  })

  it("keeps the form open and shows the error on a failed save", async () => {
    const onSaved = vi.fn()
    updateEmployee.mockRejectedValue(new Error("rank must be one of ..."))
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByDisplayValue("You write blog posts."), { target: { value: "Changed." } })
    fireEvent.click(saveBtn())

    await waitFor(() => expect(screen.getByText("rank must be one of ...")).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
    expect(saveBtn()).toBeTruthy() // still open
  })

  it("preserves ordered reportsTo arrays when the reporting order changes", async () => {
    const onSaved = vi.fn()
    const employee: Employee = {
      ...EMP,
      reportsTo: ["content-lead", "review-lead"],
    }
    updateEmployee.mockResolvedValue({
      status: "ok",
      employee: { ...employee, reportsTo: ["review-lead", "content-lead"] },
    })

    render(<EmployeeEditor employee={employee} onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole("button", { name: "Move review-lead up" }))
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1))
    expect(updateEmployee).toHaveBeenCalledWith("content-writer", {
      reportsTo: ["review-lead", "content-lead"],
    })
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ ...employee, reportsTo: ["review-lead", "content-lead"] }),
    )
  })

  it("sends an explicit empty reportsTo array when the last supervisor is removed", async () => {
    const employee: Employee = {
      ...EMP,
      reportsTo: "content-lead",
    }
    updateEmployee.mockResolvedValue({
      status: "ok",
      employee: { ...EMP, reportsTo: undefined },
    })

    render(<EmployeeEditor employee={employee} onCancel={() => {}} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole("button", { name: "Remove content-lead" }))
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("content-writer", {
      reportsTo: [],
    }))
  })

  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn()
    render(<EmployeeEditor employee={EMP} onCancel={onCancel} onSaved={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("hides the Delete button when onDeleted is not provided", () => {
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
  })

  it("requires a two-step confirmation and can be undone before deleting", () => {
    const onDeleted = vi.fn()
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} onDeleted={onDeleted} />)

    // Step 1: reveal confirmation; no API call yet.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(screen.getByRole("button", { name: "Confirm Deletion" })).toBeTruthy()
    expect(deleteEmployee).not.toHaveBeenCalled()

    // Undo returns to the initial state.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy()
    expect(deleteEmployee).not.toHaveBeenCalled()
  })

  it("deletes and calls onDeleted after confirmation", async () => {
    const onDeleted = vi.fn()
    deleteEmployee.mockResolvedValue({ status: "ok" })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} onDeleted={onDeleted} />)

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm Deletion" }))

    await waitFor(() => expect(deleteEmployee).toHaveBeenCalledWith("content-writer"))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(EMP))
  })

  it("surfaces the error and stays open on a failed delete", async () => {
    const onDeleted = vi.fn()
    deleteEmployee.mockRejectedValue(new Error("cannot delete a manager with reports"))
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} onDeleted={onDeleted} />)

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm Deletion" }))

    await waitFor(() => expect(screen.getByText("cannot delete a manager with reports")).toBeTruthy())
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy() // back to step 1
  })
})
