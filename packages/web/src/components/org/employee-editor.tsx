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
import { EmployeeFallbackModelSelect } from "@/components/org/employee-fallback-model-select"
import { RoleAgentConfig } from "@/components/org/role-agent-config"
import { normalizeRoles } from "@/lib/role-policy"
import type { RoleExecutionPolicy } from "@/lib/api-org"
import { ReportsToField, normalizeReportsTo, serializeReportsTo } from "@/components/org/reports-to-field"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { EmojiPicker } from "@/components/ui/emoji-picker"
import { canonicalIcon, iconPatchFromPickerValue } from "@/lib/employee-icon"
import { useSettings } from "@/routes/settings-provider"
import { buildSupervisorOptions } from "@/components/org/supervisor-options"

const LEVEL_OPTIONS = [
  { value: "manager", label: "Manager" },
  { value: "senior", label: "Senior" },
  { value: "employee", label: "Junior" },
] as const

const EXECUTION_TIER_OPTIONS = [
  { value: "solo", label: "Solo" },
  { value: "mid_pair", label: "Review profile" },
] as const

const REVIEWER_LOSS_POLICY_OPTIONS = [
  { value: "replace_then_degrade", label: "Failover chain, then continue solo" },
  { value: "replace_then_block", label: "Failover chain, then block" },
  { value: "degrade", label: "Continue solo (skip review)" },
  { value: "block", label: "Block the run" },
] as const

const REVIEWER_TOOL_PROFILE_OPTIONS = [
  { value: "read_only", label: "Read only" },
  { value: "read_plus_inspect", label: "Read + inspect" },
  { value: "patch_suggestions", label: "Patch suggestions" },
] as const

function fallbackModelOf(employee: Employee): string {
  return employee.modelPolicy?.fallback_chain?.[0]?.model ?? ""
}

function fallbackEngineOf(employee: Employee): string {
  return employee.modelPolicy?.fallback_chain?.[0]?.engine ?? employee.engine
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

const DEPARTMENT_NONE = "__department_none__"
const DEPARTMENT_CUSTOM = "__department_custom__"

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
  const [departmentMode, setDepartmentMode] = useState<"select" | "custom">("select")
  const [departmentTouched, setDepartmentTouched] = useState(false)
  const [rank, setRank] = useState<Employee["rank"]>(employee.rank)
  const [reportsTo, setReportsTo] = useState(() => normalizeReportsTo(employee.reportsTo))
  const [persona, setPersona] = useState(employee.persona || "")
  const [alwaysNotify, setAlwaysNotify] = useState(employee.alwaysNotify ?? true)
  const [cliFlags, setCliFlags] = useState((employee.cliFlags ?? []).join(" "))
  const [fallbackEngine, setFallbackEngine] = useState(fallbackEngineOf(employee))
  const [fallbackModel, setFallbackModel] = useState(fallbackModelOf(employee))
  // Canonical icon: an ocean avatar id ("kind:id") or a plain emoji, "" for none.
  const [icon, setIcon] = useState(canonicalIcon(employee))
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [selector, setSelector] = useState<SelectorValue>({
    engine: employee.engine,
    model: employee.model,
    effortLevel: employee.effortLevel,
  })
  const { settings } = useSettings()

  // Department + reportsTo option lists come from the live org.
  const [departments, setDepartments] = useState<string[]>([])
  const [employeeNames, setEmployeeNames] = useState<string[]>([])
  const [orgEmployees, setOrgEmployees] = useState<Employee[]>([])
  const [executionTier, setExecutionTier] = useState<"solo" | "mid_pair">(
    (employee.execution?.tier ?? "solo") as "solo" | "mid_pair",
  )
  const [reviewerLossPolicy, setReviewerLossPolicy] = useState<string>(
    employee.execution?.reviewerLossPolicy ?? "replace_then_degrade",
  )
  const [reviewerToolProfile, setReviewerToolProfile] = useState<string>(
    employee.execution?.reviewerToolProfile ?? "read_only",
  )
  const [maxInternalPasses, setMaxInternalPasses] = useState<string>(
    String(employee.execution?.maxInternalPasses ?? 1),
  )
  const [maxChildSessions, setMaxChildSessions] = useState<string>(
    String(employee.execution?.maxChildSessions ?? 3),
  )
  const [maxWallClockMs, setMaxWallClockMs] = useState<string>(
    String(employee.execution?.maxWallClockMs ?? 300000),
  )
  const [implementerRole, setImplementerRole] = useState<RoleExecutionPolicy>(
    employee.execution?.roles?.implementer ?? {},
  )
  const [reviewerRole, setReviewerRole] = useState<RoleExecutionPolicy>(
    employee.execution?.roles?.reviewer ?? {},
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    api.getOrg().then((o) => {
      setDepartments(o.departments)
      setOrgEmployees(o.employees)
      setEmployeeNames(buildSupervisorOptions(o.employees, {
        portalName: settings.portalName,
        excludeName: employee.name,
      }))
    }).catch(() => {})
  }, [employee.name, settings.portalName])

  const employeeByName = useMemo(() => {
    const map = new Map<string, Employee>()
    for (const entry of orgEmployees) map.set(entry.name, entry)
    return map
  }, [orgEmployees])

  // Org employees offered as defer-to-external-agent failover targets.
  const externalAgentOptions = useMemo(
    () => orgEmployees.map((e) => e.name).filter((n) => n !== employee.name).sort((a, b) => a.localeCompare(b)),
    [orgEmployees, employee.name],
  )

  const departmentOptions = useMemo(() => {
    const names = new Set<string>()
    for (const name of departments) {
      const trimmed = name.trim()
      if (trimmed) names.add(trimmed)
    }
    const original = (employee.department || "").trim()
    if (original) names.add(original)
    if (departmentMode !== "custom") {
      const selected = department.trim()
      if (selected) names.add(selected)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [departments, employee.department, department, departmentMode])

  const originalPrimarySupervisor = useMemo(() => normalizeReportsTo(employee.reportsTo)[0] ?? "", [employee.reportsTo])
  const primarySupervisor = reportsTo[0] ?? ""

  useEffect(() => {
    if (departmentTouched || primarySupervisor === originalPrimarySupervisor) return
    const supervisorDepartment = employeeByName.get(primarySupervisor)?.department?.trim()
    if (!supervisorDepartment || supervisorDepartment === department) return
    setDepartment(supervisorDepartment)
    setDepartmentMode("select")
  }, [department, departmentTouched, employeeByName, originalPrimarySupervisor, primarySupervisor])

  useEffect(() => {
    if (!department || departments.length === 0 || departments.includes(department)) return
    setDepartmentMode("custom")
  }, [department, departments])

  function chooseDepartment(next: string) {
    setDepartmentTouched(true)
    if (next === DEPARTMENT_NONE) {
      setDepartment("")
      setDepartmentMode("select")
      return
    }
    if (next === DEPARTMENT_CUSTOM) {
      setDepartmentMode("custom")
      if (departmentOptions.includes(department)) setDepartment("")
      return
    }
    setDepartment(next)
    setDepartmentMode("select")
  }

  function typeCustomDepartment(next: string) {
    setDepartmentTouched(true)
    setDepartment(next)
    setDepartmentMode("custom")
  }

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
    if (reportsTo.join("\n") !== origReports.join("\n")) {
      p.reportsTo = reportsTo.length === 0 ? [] : serializeReportsTo(reportsTo)
    }
    if (persona !== employee.persona) p.persona = persona
    if (alwaysNotify !== (employee.alwaysNotify ?? true)) p.alwaysNotify = alwaysNotify
    const flags = cliFlags.split(/\s+/).filter(Boolean)
    if (flags.join(" ") !== (employee.cliFlags ?? []).join(" ")) p.cliFlags = flags
    if (fallbackEngine !== fallbackEngineOf(employee)) p.fallbackEngine = fallbackEngine.trim() || null
    if (fallbackModel !== fallbackModelOf(employee)) p.fallbackModel = fallbackModel.trim() || null
    if (selector.engine !== employee.engine) p.engine = selector.engine
    if (selector.model !== employee.model) p.model = selector.model
    if (selector.effortLevel !== employee.effortLevel) p.effortLevel = selector.effortLevel
    // Icon: send both fields so the backend XOR-normalizes (one canonical icon).
    if (icon !== canonicalIcon(employee)) {
      const { avatar, emoji } = iconPatchFromPickerValue(icon)
      p.avatar = avatar
      p.emoji = emoji
    }
    // Execution config: diff against current stored config
    const origTier = employee.execution?.tier ?? "solo"
    const origLossPolicy = employee.execution?.reviewerLossPolicy ?? "replace_then_degrade"
    const origToolProfile = employee.execution?.reviewerToolProfile ?? "read_only"
    const origMaxPasses = String(employee.execution?.maxInternalPasses ?? 1)
    const origMaxChildren = String(employee.execution?.maxChildSessions ?? 3)
    const origMaxMs = String(employee.execution?.maxWallClockMs ?? 300000)
    const roles = normalizeRoles(implementerRole, reviewerRole)
    const origRoles = normalizeRoles(employee.execution?.roles?.implementer, employee.execution?.roles?.reviewer)
    const execChanged =
      executionTier !== origTier ||
      (executionTier === "mid_pair" && (
        reviewerLossPolicy !== origLossPolicy ||
        reviewerToolProfile !== origToolProfile ||
        maxInternalPasses !== origMaxPasses ||
        maxChildSessions !== origMaxChildren ||
        maxWallClockMs !== origMaxMs ||
        JSON.stringify(roles) !== JSON.stringify(origRoles)
      ))
    if (execChanged) {
      p.execution = {
        tier: executionTier,
        ...(executionTier === "mid_pair" ? {
          reviewerLossPolicy: reviewerLossPolicy as import("@/lib/api-org").ReviewerLossPolicy,
          reviewerToolProfile: reviewerToolProfile as import("@/lib/api-org").ReviewerToolProfile,
          maxInternalPasses: parseInt(maxInternalPasses, 10) || 1,
          maxChildSessions: parseInt(maxChildSessions, 10) || 3,
          maxWallClockMs: parseInt(maxWallClockMs, 10) || 300000,
          ...(roles ? { roles } : {}),
        } : {}),
      }
    }
    return p
  }, [displayName, department, rank, reportsTo, persona, alwaysNotify, cliFlags, fallbackEngine, fallbackModel, selector, icon, employee, executionTier, reviewerLossPolicy, reviewerToolProfile, maxInternalPasses, maxChildSessions, maxWallClockMs, implementerRole, reviewerRole])

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
        <div className="flex items-center gap-[var(--space-3)]">
          <div className="relative">
            <EmployeeAvatar
              name={employee.name}
              avatar={iconPatchFromPickerValue(icon).avatar}
              emoji={iconPatchFromPickerValue(icon).emoji}
              size={36}
              onClick={() => setShowIconPicker((v) => !v)}
            />
            {showIconPicker && (
              <EmojiPicker
                current={icon}
                onSelect={(value) => {
                  setIcon(value)
                  setShowIconPicker(false)
                }}
                onClose={() => setShowIconPicker(false)}
              />
            )}
          </div>
          <h2 className="text-[length:var(--text-headline)] font-[var(--weight-bold)] text-[var(--text-primary)] m-0">
            Edit employee
          </h2>
        </div>
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
      <Field label="Rank">
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
          <Select
            value={departmentMode === "custom" ? DEPARTMENT_CUSTOM : department || DEPARTMENT_NONE}
            onValueChange={chooseDepartment}
          >
            <SelectTrigger aria-label="Department">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEPARTMENT_NONE}>Unassigned</SelectItem>
              {departmentOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
              <SelectItem value={DEPARTMENT_CUSTOM}>New department…</SelectItem>
            </SelectContent>
          </Select>
          {departmentMode === "custom" && (
            <input
              className={inputCls}
              value={department}
              onChange={(event) => typeCustomDepartment(event.target.value)}
              placeholder="New department name"
              aria-label="New department name"
            />
          )}
          <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
            Pick an existing department, choose Unassigned, or create a new department.
          </span>
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

      <Field label="Execution profile" hint="Review profile stores reviewer settings for gateways that enable multi-role execution. Solo remains the normal runtime path.">
        <Select value={executionTier} onValueChange={(v) => setExecutionTier(v as "solo" | "mid_pair")}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXECUTION_TIER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {executionTier === "mid_pair" && (
          <div className="mt-[var(--space-2)] flex flex-col gap-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-quaternary)] p-[var(--space-3)]">
            <div className="grid grid-cols-2 gap-[var(--space-3)]">
              <div className="flex flex-col gap-[var(--space-1)]">
                <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                  Reviewer loss policy
                </label>
                <Select value={reviewerLossPolicy} onValueChange={setReviewerLossPolicy}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEWER_LOSS_POLICY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-[var(--space-1)]">
                <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                  Reviewer tool access
                </label>
                <Select value={reviewerToolProfile} onValueChange={setReviewerToolProfile}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEWER_TOOL_PROFILE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-[var(--space-2)]">
              <div className="flex flex-col gap-[var(--space-1)]">
                <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                  Max passes
                </label>
                <input type="number" min={1} max={10} className={inputCls} value={maxInternalPasses} onChange={(e) => setMaxInternalPasses(e.target.value)} />
              </div>
              <div className="flex flex-col gap-[var(--space-1)]">
                <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                  Max child sessions
                </label>
                <input type="number" min={1} max={20} className={inputCls} value={maxChildSessions} onChange={(e) => setMaxChildSessions(e.target.value)} />
              </div>
              <div className="flex flex-col gap-[var(--space-1)]">
                <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                  Timeout (ms)
                </label>
                <input type="number" min={10000} step={10000} className={inputCls} value={maxWallClockMs} onChange={(e) => setMaxWallClockMs(e.target.value)} />
              </div>
            </div>
            <div className="border-t border-[var(--separator)] pt-[var(--space-3)]">
              <RoleAgentConfig
                roleLabel="Implementer"
                value={implementerRole}
                onChange={setImplementerRole}
                inheritedEngine={selector.engine ?? employee.engine}
                inheritedModel={selector.model ?? employee.model}
                employeeOptions={externalAgentOptions}
                hint="Runs the implementation and revision passes. Pick a cheaper engine/model here to route simple work to a lower tier."
              />
            </div>
            <div className="border-t border-[var(--separator)] pt-[var(--space-3)]">
              <RoleAgentConfig
                roleLabel="Reviewer"
                value={reviewerRole}
                onChange={setReviewerRole}
                inheritedEngine={selector.engine ?? employee.engine}
                inheritedModel={selector.model ?? employee.model}
                employeeOptions={externalAgentOptions}
                hint="Reviews implementer output. When the reviewer is lost, the failover chain below is walked in order under the reviewer loss policy."
              />
            </div>
          </div>
        )}
      </Field>

      <Field label="Engine · Model · Effort" hint="Applies to new sessions for this employee.">
        <div className="rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)]">
          <ModelSelectorRow mode="new" value={selector} onChange={setSelector} />
        </div>
      </Field>

      <Field label="Fallback model" hint="Optional cross-provider backup target for model fallback.">
        <EmployeeFallbackModelSelect
          engine={selector.engine}
          primaryModel={selector.model}
          valueEngine={fallbackEngine}
          value={fallbackModel}
          onEngineChange={setFallbackEngine}
          onChange={setFallbackModel}
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
