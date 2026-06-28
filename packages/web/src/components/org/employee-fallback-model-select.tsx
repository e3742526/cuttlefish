import { useMemo } from "react"
import { useModelRegistry } from "@/hooks/use-model-registry"

const NONE = "__none__"

const inputCls =
  "w-full rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"

export function EmployeeFallbackModelSelect({
  engine,
  primaryModel,
  value,
  onChange,
}: {
  engine?: string
  primaryModel?: string
  value: string
  onChange: (next: string) => void
}) {
  const { data: registry, isLoading } = useModelRegistry()
  const engineEntry = engine ? registry?.engines[engine] : undefined

  const options = useMemo(() => {
    const models = engineEntry?.models ?? []
    return models.map((model) => ({
      value: model.id,
      label: model.id === primaryModel ? `${model.label} (primary)` : model.label,
    }))
  }, [engineEntry?.models, primaryModel])

  const hasSelectedValue = value.trim().length > 0
  const selectedKnown = options.some((option) => option.value === value)
  const selectedValue = hasSelectedValue ? value : NONE

  return (
    <select
      className={inputCls}
      aria-label="Fallback model"
      disabled={isLoading || !engineEntry}
      value={selectedKnown ? selectedValue : hasSelectedValue ? value : NONE}
      onChange={(e) => onChange(e.target.value === NONE ? "" : e.target.value)}
    >
      <option value={NONE}>
        {isLoading ? "Loading available models…" : "None"}
      </option>
      {!isLoading && !engineEntry && hasSelectedValue && (
        <option value={value}>{value} (current)</option>
      )}
      {!isLoading && !!engineEntry && !selectedKnown && hasSelectedValue && (
        <option value={value}>{value} (unavailable)</option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
