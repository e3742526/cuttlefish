import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, type ReactElement } from "react"
import type { EnginesResponse } from "@/lib/api"
import type { RoleExecutionPolicy } from "@/lib/api-org"

const REGISTRY: EnginesResponse = {
  default: "claude",
  engines: {
    claude: {
      name: "claude",
      available: true,
      defaultModel: "claude-opus-4-8",
      effortMechanism: "claude-flag",
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "claude-haiku-4-5", label: "Haiku 4.5", supportsEffort: false, effortLevels: [] },
      ],
    },
    codex: {
      name: "codex",
      available: true,
      defaultModel: "gpt-5.5",
      effortMechanism: "codex-config",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
  },
}

vi.mock("@/hooks/use-model-registry", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/use-model-registry")>()
  return { ...actual, useModelRegistry: () => ({ data: REGISTRY, isLoading: false }) }
})

import { RoleAgentConfig } from "./role-agent-config"

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

/** Stateful harness so select changes round-trip like in the real editor. */
function Harness({ initial, onValue }: { initial?: RoleExecutionPolicy; onValue?: (v: RoleExecutionPolicy) => void }) {
  const [value, setValue] = useState<RoleExecutionPolicy>(initial ?? {})
  return (
    <RoleAgentConfig
      roleLabel="Reviewer"
      value={value}
      onChange={(next) => {
        setValue(next)
        onValue?.(next)
      }}
      inheritedEngine="claude"
      inheritedModel="claude-opus-4-8"
      employeeOptions={["sec-reviewer", "cheap-checker"]}
    />
  )
}

describe("RoleAgentConfig", () => {
  it("defaults to inheriting the employee's engine and model", () => {
    renderWithClient(<Harness />)
    const engine = screen.getByRole("combobox", { name: "Reviewer engine" }) as HTMLSelectElement
    const model = screen.getByRole("combobox", { name: "Reviewer model" }) as HTMLSelectElement
    expect(engine.options[engine.selectedIndex].textContent).toBe("Inherit (claude)")
    expect(model.options[model.selectedIndex].textContent).toBe("Inherit (claude-opus-4-8)")
  })

  it("emits an override with the engine default model when a different engine is picked", () => {
    let last: RoleExecutionPolicy = {}
    renderWithClient(<Harness onValue={(v) => (last = v)} />)
    fireEvent.change(screen.getByRole("combobox", { name: "Reviewer engine" }), { target: { value: "codex" } })
    expect(last.override).toEqual({ engine: "codex", model: "gpt-5.5" })
  })

  it("supports a model-only override (cheaper model on the inherited engine)", () => {
    let last: RoleExecutionPolicy = {}
    renderWithClient(<Harness onValue={(v) => (last = v)} />)
    fireEvent.change(screen.getByRole("combobox", { name: "Reviewer model" }), { target: { value: "claude-haiku-4-5" } })
    expect(last.override).toEqual({ model: "claude-haiku-4-5" })
  })

  it("adds a backup-agent failover target with the first engine's default model", () => {
    let last: RoleExecutionPolicy = {}
    renderWithClient(<Harness onValue={(v) => (last = v)} />)
    fireEvent.click(screen.getByRole("button", { name: /Add failover target/ }))
    expect(last.fallbackChain).toEqual([{ engine: "claude", model: "claude-opus-4-8" }])
  })

  it("switches a failover row to a defer-to-employee target", () => {
    let last: RoleExecutionPolicy = {}
    renderWithClient(<Harness initial={{ fallbackChain: [{ engine: "codex", model: "gpt-5.5" }] }} onValue={(v) => (last = v)} />)
    fireEvent.change(screen.getByRole("combobox", { name: "Reviewer failover 1 type" }), { target: { value: "employee" } })
    expect(last.fallbackChain).toEqual([{ employee: "sec-reviewer" }])
  })

  it("reorders failover targets deterministically with the move buttons", () => {
    let last: RoleExecutionPolicy = {}
    renderWithClient(
      <Harness
        initial={{ fallbackChain: [{ engine: "codex", model: "gpt-5.5" }, { employee: "sec-reviewer" }] }}
        onValue={(v) => (last = v)}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Move Reviewer failover 2 up" }))
    expect(last.fallbackChain).toEqual([{ employee: "sec-reviewer" }, { engine: "codex", model: "gpt-5.5" }])
  })

  it("removes a failover target", () => {
    let last: RoleExecutionPolicy = { fallbackChain: [] }
    renderWithClient(
      <Harness
        initial={{ fallbackChain: [{ engine: "codex", model: "gpt-5.5" }, { employee: "sec-reviewer" }] }}
        onValue={(v) => (last = v)}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer failover 1" }))
    expect(last.fallbackChain).toEqual([{ employee: "sec-reviewer" }])
  })

  it("caps the chain at the maximum and disables the add button", () => {
    const chain = Array.from({ length: 5 }, () => ({ engine: "codex", model: "gpt-5.5" }))
    renderWithClient(<Harness initial={{ fallbackChain: chain }} />)
    const addButton = screen.getByRole("button", { name: /Add failover target \(max 5\)/ }) as HTMLButtonElement
    expect(addButton.disabled).toBe(true)
  })

  it("keeps an unknown saved employee target visible instead of silently dropping it", () => {
    renderWithClient(<Harness initial={{ fallbackChain: [{ employee: "ghost" }] }} />)
    const select = screen.getByRole("combobox", { name: "Reviewer failover 1 employee" }) as HTMLSelectElement
    expect(select.options[select.selectedIndex].textContent).toBe("ghost (unknown)")
  })
})
