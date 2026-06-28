import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactElement } from "react"
import type { EnginesResponse } from "@/lib/api"

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
        { id: "claude-sonnet-4-6", label: "Sonnet 4.6", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
  },
}

vi.mock("@/hooks/use-model-registry", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/use-model-registry")>()
  return { ...actual, useModelRegistry: () => ({ data: REGISTRY, isLoading: false }) }
})

import { EmployeeFallbackModelSelect } from "./employee-fallback-model-select"

function renderSelect(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe("EmployeeFallbackModelSelect", () => {
  it("lists models for the selected engine and marks the primary model", () => {
    renderSelect(
      <EmployeeFallbackModelSelect
        engine="claude"
        primaryModel="claude-opus-4-8"
        value=""
        onChange={() => {}}
      />,
    )

    const select = screen.getByRole("combobox", { name: "Fallback model" })
    const labels = Array.from(select.querySelectorAll("option")).map((option) => option.textContent)
    expect(labels).toContain("None")
    expect(labels).toContain("Opus 4.8 (primary)")
    expect(labels).toContain("Sonnet 4.6")
  })

  it("preserves an unknown saved fallback so it remains visible until changed", () => {
    renderSelect(
      <EmployeeFallbackModelSelect
        engine="claude"
        primaryModel="claude-opus-4-8"
        value="legacy-model"
        onChange={() => {}}
      />,
    )

    expect(screen.getByRole("option", { name: "legacy-model (unavailable)" })).toBeTruthy()
  })

  it("maps the None option back to an empty fallback value", () => {
    const onChange = vi.fn()
    renderSelect(
      <EmployeeFallbackModelSelect
        engine="claude"
        primaryModel="claude-opus-4-8"
        value="claude-sonnet-4-6"
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByRole("combobox", { name: "Fallback model" }), {
      target: { value: "__none__" },
    })
    expect(onChange).toHaveBeenCalledWith("")
  })
})
