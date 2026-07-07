import { useMemo } from "react"
import { useModelRegistry, effortLevelsFor } from "@/hooks/use-model-registry"
import {
  MAX_ROLE_FALLBACK_CHAIN,
  type RoleExecutionPolicy,
  type RoleFallbackTarget,
} from "@/lib/api-org"

const INHERIT = "__inherit__"
const NONE = "__none__"

const inputCls =
  "w-full rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"

const smallBtnCls =
  "rounded-[var(--radius-sm,6px)] border border-[var(--separator)] bg-[var(--fill-quaternary)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"

const labelCls =
  "text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]"

/** True when a chain row is a defer-to-external-agent entry. */
function isEmployeeTarget(t: RoleFallbackTarget): boolean {
  return typeof t.employee === "string" && t.employee.length > 0
}

/**
 * Per-role sub-agent configuration: which agent (engine/model/effort) runs the
 * role, plus an ordered failover chain of backup agents or external-employee
 * deferrals. Fully controlled — parent owns the RoleExecutionPolicy value.
 */
export function RoleAgentConfig({
  roleLabel,
  value,
  onChange,
  inheritedEngine,
  inheritedModel,
  employeeOptions,
  hint,
}: {
  roleLabel: string
  value: RoleExecutionPolicy
  onChange: (next: RoleExecutionPolicy) => void
  /** The employee's primary engine/model — what "Inherit" resolves to. */
  inheritedEngine: string
  inheritedModel: string
  /** Org employees offered as defer-to-external-agent targets (self excluded). */
  employeeOptions: string[]
  hint?: string
}) {
  const { data: registry, isLoading } = useModelRegistry()
  const engineOptions = useMemo(
    () => Object.values(registry?.engines ?? {}).filter((entry) => entry.available),
    [registry?.engines],
  )

  const override = value.override ?? {}
  const chain = value.fallbackChain ?? []
  const effectiveEngine = override.engine || inheritedEngine
  const effectiveModel = override.model || inheritedModel
  const effortLevels = effortLevelsFor(registry, effectiveEngine, effectiveModel)

  function patchOverride(patch: Partial<NonNullable<RoleExecutionPolicy["override"]>>) {
    const next = { ...override, ...patch }
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, v]) => typeof v === "string" && v.length > 0))
    onChange({ ...value, override: Object.keys(cleaned).length > 0 ? cleaned : undefined })
  }

  function setChain(nextChain: RoleFallbackTarget[]) {
    onChange({ ...value, fallbackChain: nextChain.length > 0 ? nextChain : undefined })
  }

  function patchTarget(index: number, target: RoleFallbackTarget) {
    setChain(chain.map((t, i) => (i === index ? target : t)))
  }

  function moveTarget(index: number, delta: -1 | 1) {
    const next = [...chain]
    const swap = index + delta
    if (swap < 0 || swap >= next.length) return
    ;[next[index], next[swap]] = [next[swap], next[index]]
    setChain(next)
  }

  function addTarget() {
    if (chain.length >= MAX_ROLE_FALLBACK_CHAIN) return
    const firstEngine = engineOptions[0]?.name ?? ""
    const firstModel = firstEngine ? registry?.engines[firstEngine]?.defaultModel ?? "" : ""
    setChain([...chain, { engine: firstEngine, model: firstModel }])
  }

  const modelsFor = (engine: string) => registry?.engines[engine]?.models ?? []

  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <span className={labelCls}>{roleLabel} agent</span>
      {hint && <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">{hint}</span>}

      <div className="grid grid-cols-3 gap-[var(--space-2)]">
        <select
          className={inputCls}
          aria-label={`${roleLabel} engine`}
          disabled={isLoading}
          value={override.engine ?? INHERIT}
          onChange={(e) => {
            const engine = e.target.value === INHERIT ? undefined : e.target.value
            // Engine change invalidates the model override — reset to the new engine's default.
            patchOverride({
              engine,
              model: engine ? registry?.engines[engine]?.defaultModel ?? undefined : undefined,
              effortLevel: undefined,
            })
          }}
        >
          <option value={INHERIT}>Inherit ({inheritedEngine})</option>
          {engineOptions.map((option) => (
            <option key={option.name} value={option.name}>{option.name}</option>
          ))}
        </select>
        <select
          className={inputCls}
          aria-label={`${roleLabel} model`}
          disabled={isLoading}
          value={override.model ?? INHERIT}
          onChange={(e) => patchOverride({ model: e.target.value === INHERIT ? undefined : e.target.value, effortLevel: undefined })}
        >
          <option value={INHERIT}>
            {override.engine ? `Default (${registry?.engines[override.engine]?.defaultModel ?? "engine default"})` : `Inherit (${inheritedModel})`}
          </option>
          {override.model && !modelsFor(effectiveEngine).some((m) => m.id === override.model) && (
            <option value={override.model}>{override.model} (unavailable)</option>
          )}
          {modelsFor(effectiveEngine).map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <select
          className={inputCls}
          aria-label={`${roleLabel} effort`}
          disabled={isLoading || effortLevels.length === 0}
          value={override.effortLevel ?? INHERIT}
          onChange={(e) => patchOverride({ effortLevel: e.target.value === INHERIT ? undefined : e.target.value })}
        >
          <option value={INHERIT}>Default effort</option>
          {effortLevels.map((level) => (
            <option key={level} value={level}>{level}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-[var(--space-1)]">
        <span className={labelCls}>{roleLabel} failover</span>
        <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
          Tried in order when the {roleLabel.toLowerCase()} agent is unavailable or fails. Duplicates and unavailable engines are skipped automatically at run time.
        </span>
        {chain.map((target, index) => {
          const kind = isEmployeeTarget(target) ? "employee" : "agent"
          return (
            <div key={index} className="flex items-center gap-[var(--space-2)]">
              <span className="w-4 shrink-0 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">{index + 1}.</span>
              <select
                className={`${inputCls} max-w-[130px]`}
                aria-label={`${roleLabel} failover ${index + 1} type`}
                value={kind}
                onChange={(e) => {
                  if (e.target.value === "employee") {
                    patchTarget(index, { employee: employeeOptions[0] ?? "" })
                  } else {
                    const firstEngine = engineOptions[0]?.name ?? ""
                    patchTarget(index, { engine: firstEngine, model: registry?.engines[firstEngine]?.defaultModel ?? "" })
                  }
                }}
              >
                <option value="agent">Backup agent</option>
                <option value="employee" disabled={employeeOptions.length === 0}>Defer to employee</option>
              </select>
              {kind === "employee" ? (
                <select
                  className={inputCls}
                  aria-label={`${roleLabel} failover ${index + 1} employee`}
                  value={target.employee ?? NONE}
                  onChange={(e) => patchTarget(index, { employee: e.target.value === NONE ? "" : e.target.value })}
                >
                  {target.employee && !employeeOptions.includes(target.employee) && (
                    <option value={target.employee}>{target.employee} (unknown)</option>
                  )}
                  {employeeOptions.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              ) : (
                <>
                  <select
                    className={inputCls}
                    aria-label={`${roleLabel} failover ${index + 1} engine`}
                    disabled={isLoading}
                    value={target.engine ?? ""}
                    onChange={(e) => {
                      const engine = e.target.value
                      patchTarget(index, { engine, model: registry?.engines[engine]?.defaultModel ?? "", effortLevel: target.effortLevel })
                    }}
                  >
                    {target.engine && !engineOptions.some((o) => o.name === target.engine) && (
                      <option value={target.engine}>{target.engine} (unavailable)</option>
                    )}
                    {engineOptions.map((option) => (
                      <option key={option.name} value={option.name}>{option.name}</option>
                    ))}
                  </select>
                  <select
                    className={inputCls}
                    aria-label={`${roleLabel} failover ${index + 1} model`}
                    disabled={isLoading || !target.engine}
                    value={target.model ?? ""}
                    onChange={(e) => patchTarget(index, { ...target, model: e.target.value })}
                  >
                    {target.model && !modelsFor(target.engine ?? "").some((m) => m.id === target.model) && (
                      <option value={target.model}>{target.model} (unavailable)</option>
                    )}
                    {modelsFor(target.engine ?? "").map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </>
              )}
              <button type="button" className={smallBtnCls} aria-label={`Move ${roleLabel} failover ${index + 1} up`} disabled={index === 0} onClick={() => moveTarget(index, -1)}>↑</button>
              <button type="button" className={smallBtnCls} aria-label={`Move ${roleLabel} failover ${index + 1} down`} disabled={index === chain.length - 1} onClick={() => moveTarget(index, 1)}>↓</button>
              <button type="button" className={smallBtnCls} aria-label={`Remove ${roleLabel} failover ${index + 1}`} onClick={() => setChain(chain.filter((_, i) => i !== index))}>✕</button>
            </div>
          )
        })}
        <div>
          <button
            type="button"
            className={smallBtnCls}
            disabled={isLoading || chain.length >= MAX_ROLE_FALLBACK_CHAIN}
            onClick={addTarget}
          >
            + Add failover target{chain.length >= MAX_ROLE_FALLBACK_CHAIN ? ` (max ${MAX_ROLE_FALLBACK_CHAIN})` : ""}
          </button>
        </div>
      </div>
    </div>
  )
}
