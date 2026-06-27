import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Employee } from "@/lib/api"

// ModelSelectorRow has its own tests + needs the model registry; stub it here so
// this test focuses on the editor's own behavior (validation, diffing, save).
vi.mock("@/components/chat/model-selector-row", () => ({
  ModelSelectorRow: () => null,
}))

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

beforeEach(() => {
  updateEmployee.mockReset()
  deleteEmployee.mockReset()
  getOrg.mockReset()
  getOrg.mockResolvedValue({
    departments: ["content"],
    employees: [{ name: "content-lead" }, { name: "review-lead" }],
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
