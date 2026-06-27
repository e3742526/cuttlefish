import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import type { Employee, EmployeeUpdate } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ModelSelectorRow, type SelectorValue } from "@/components/chat/model-selector-row"
import { ReportsToField, normalizeReportsTo, serializeReportsTo } from "@/components/org/reports-to-field"

const LEVEL_OPTIONS = [
  { value: "manager", label: "Manager" },
  { value: "senior", label: "Senior" },
  { value: "employee", label: "Junior" },
] as const
const NONE = "__none__"

function fallbackModelOf(employee: Employee): string {
  return employee.modelPolicy?.fallback_chain?.[0]?.model ?? ""
}

interface FieldProps {
  label: string
  children: React.ReactNode
  hint?: string
}
function Field({ label, children, hint }: FieldProps) {
  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
        {label}
      </label>
      {children}
      {hint && <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">{hint}</span>}
    </div>
  )
}

const inputCls =
  "w-full rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"

export function EmployeeEditor({
  employee,
  onCancel,
  onSaved,
  onDeleted,
}: {
  employee: Employee
  onCancel: () => void
  onSaved: (emp: Employee) => void
  onDeleted?: (emp: Employee) => void
}) {
  const [displayName, setDisplayName] = useState(employee.displayName || employee.name)
  const [department, setDepartment] = useState(employee.department || "")
  const [rank, setRank] = useState<Employee["rank"]>(employee.rank)
  const [reportsTo, setReportsTo] = useState(() => normalizeReportsTo(employee.reportsTo))
  const [persona, setPersona] = useState(employee.persona || "")
  const [alwaysNotify, setAlwaysNotify] = useState(employee.alwaysNotify ?? true)
  const [cliFlags, setCliFlags] = useState((employee.cliFlags ?? []).join(" "))
  const [fallbackModel, setFallbackModel] = useState(fallbackModelOf(employee))
  const [selector, setSelector] = useState<SelectorValue>({
    engine: employee.engine,
    model: employee.model,
    effortLevel: employee.effortLevel,
  })

  // Department + reportsTo option lists come from the live org.
  const [departments, setDepartments] = useState<string[]>([])
  const [employeeNames, setEmployeeNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    api.getOrg().then((o) => {
      setDepartments(o.departments)
      setEmployeeNames(o.employees.map((e) => e.name).filter((n) => n !== employee.name))
    }).catch(() => {})
  }, [employee.name])

  const personaInvalid = persona.trim().length === 0
  const displayNameInvalid = displayName.trim().length === 0
  const canSave = !saving && !personaInvalid && !displayNameInvalid

  // Build a patch of only the changed fields.
  const patch = useMemo<EmployeeUpdate>(() => {
    const p: EmployeeUpdate = {}
    if (displayName !== (employee.displayName || employee.name)) p.displayName = displayName.trim()
    if (department !== (employee.department || "")) p.department = department
    if (rank !== employee.rank) p.rank = rank
    const origReports = normalizeReportsTo(employee.reportsTo)
    if (reportsTo.join("\n") !== origReports.join("\n")) p.reportsTo = serializeReportsTo(reportsTo)
    if (persona !== employee.persona) p.persona = persona
    if (alwaysNotify !== (employee.alwaysNotify ?? true)) p.alwaysNotify = alwaysNotify
    const flags = cliFlags.split(/\s+/).filter(Boolean)
    if (flags.join(" ") !== (employee.cliFlags ?? []).join(" ")) p.cliFlags = flags
    if (fallbackModel !== fallbackModelOf(employee)) p.fallbackModel = fallbackModel.trim() || null
    if (selector.engine !== employee.engine) p.engine = selector.engine
    if (selector.model !== employee.model) p.model = selector.model
    if (selector.effortLevel !== employee.effortLevel) p.effortLevel = selector.effortLevel
    return p
  }, [displayName, department, rank, reportsTo, persona, alwaysNotify, cliFlags, fallbackModel, selector, employee])

  const dirty = Object.keys(patch).length > 0

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.updateEmployee(employee.name, patch)
      if (res.employee) onSaved(res.employee)
      else onSaved({ ...employee, ...patch } as Employee)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save")
      setSaving(false)
    }
  }

  async function remove() {
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      await api.deleteEmployee(employee.name)
      onDeleted?.(employee)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete")
      setDeleting(false)
      setConfirmingDelete(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void save()
    }
  }

  return (
    <div
      className="rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-5)] flex flex-col gap-[var(--space-4)]"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[length:var(--text-headline)] font-[var(--weight-bold)] text-[var(--text-primary)] m-0">
          Edit employee
        </h2>
        <span className="text-[length:var(--text-caption2)] font-[family-name:var(--font-mono)] text-[var(--text-tertiary)]">
          {employee.name}
        </span>
      </div>

      <Field label="Display name">
        <input
          className={inputCls}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          aria-invalid={displayNameInvalid}
        />
        {displayNameInvalid && (
          <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">Required.</span>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-[var(--space-3)]">
      <Field label="Level">
          <Select value={rank} onValueChange={(v) => setRank(v as Employee["rank"])}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Department">
          <Select value={department || NONE} onValueChange={(v) => setDepartment(v === NONE ? "" : v)}>
            <SelectTrigger>
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
              {department && !departments.includes(department) && (
                <SelectItem value={department}>{department}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Reports to">
        <ReportsToField
          value={reportsTo}
          options={employeeNames}
          onChange={setReportsTo}
          hint="Primary stays first. Additional entries are secondary matrix links."
        />
      </Field>

      <Field label="Engine · Model · Effort" hint="Applies to new sessions for this employee.">
        <div className="rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)]">
          <ModelSelectorRow mode="new" value={selector} onChange={setSelector} />
        </div>
      </Field>

      <Field label="Fallback model" hint="Optional same-engine backup model for model fallback.">
        <input
          className={inputCls}
          value={fallbackModel}
          onChange={(e) => setFallbackModel(e.target.value)}
          placeholder="Leave blank to disable"
        />
      </Field>

      <Field label="Persona / instructions">
        <Textarea
          rows={10}
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          aria-invalid={personaInvalid}
        />
        <div className="flex justify-between">
          {personaInvalid ? (
            <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">Persona cannot be empty.</span>
          ) : <span />}
          <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">{persona.length} chars</span>
        </div>
      </Field>

      <Field label="CLI flags" hint="Space-separated, e.g. --chrome">
        <input className={inputCls} value={cliFlags} onChange={(e) => setCliFlags(e.target.value)} />
      </Field>

      <div className="flex items-center justify-between">
        <label className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">Always notify</label>
        <Switch checked={alwaysNotify} onCheckedChange={setAlwaysNotify} />
      </div>

      {error && (
        <div
          className="rounded-[var(--radius-md)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
          style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-[var(--space-2)] sticky bottom-0 pt-[var(--space-2)] bg-[var(--material-regular)]">
        <div className="flex items-center gap-[var(--space-2)]">
          {onDeleted && !confirmingDelete && (
            <Button
              variant="ghost"
              onClick={() => setConfirmingDelete(true)}
              disabled={saving || deleting}
              className="text-[var(--system-red)] hover:text-[var(--system-red)]"
            >
              Delete
            </Button>
          )}
          {onDeleted && confirmingDelete && (
            <>
              <Button
                variant="ghost"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
              >
                Undo
              </Button>
              <Button
                onClick={() => void remove()}
                disabled={deleting}
                className="bg-[var(--system-red)] text-white hover:bg-[var(--system-red)]"
              >
                {deleting ? "Deleting…" : "Confirm Deletion"}
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <Button variant="ghost" onClick={onCancel} disabled={saving || deleting}>Cancel</Button>
          <Button onClick={() => void save()} disabled={!canSave || !dirty || deleting}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  )
}
