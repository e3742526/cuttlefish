import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import type { Employee, EmployeeCreate } from "@/lib/api"
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
import { ReportsToField, serializeReportsTo } from "@/components/org/reports-to-field"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { EmojiPicker } from "@/components/ui/emoji-picker"
import { iconPatchFromPickerValue } from "@/lib/employee-icon"
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
  { value: "replace_then_degrade", label: "Replace, then degrade" },
  { value: "replace_then_block", label: "Replace, then block" },
  { value: "degrade", label: "Degrade to solo" },
  { value: "block", label: "Block" },
] as const

const REVIEWER_TOOL_PROFILE_OPTIONS = [
  { value: "read_only", label: "Read only" },
  { value: "read_plus_inspect", label: "Read + inspect" },
  { value: "patch_suggestions", label: "Patch suggestions" },
] as const

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

const DEPARTMENT_PLACEHOLDER = "__department_placeholder__"
const DEPARTMENT_CUSTOM = "__department_custom__"

function suggestSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function EmployeeCreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (employee: Employee) => void
}) {
  const [name, setName] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [department, setDepartment] = useState("")
  const [departmentMode, setDepartmentMode] = useState<"select" | "custom">("select")
  const [departmentTouched, setDepartmentTouched] = useState(false)
  const [rank, setRank] = useState<EmployeeCreate["rank"]>("employee")
  const [reportsTo, setReportsTo] = useState<string[]>([])
  const [persona, setPersona] = useState("")
  const [alwaysNotify, setAlwaysNotify] = useState(true)
  const [cliFlags, setCliFlags] = useState("")
  const [fallbackEngine, setFallbackEngine] = useState("claude")
  const [fallbackModel, setFallbackModel] = useState("")
  // Canonical icon: an ocean avatar id ("kind:id") or a plain emoji, "" for none.
  const [icon, setIcon] = useState("")
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [selector, setSelector] = useState<SelectorValue>({
    engine: "claude",
    model: "claude-sonnet-4-6",
  })
  const { settings } = useSettings()
  const [departments, setDepartments] = useState<string[]>([])
  const [employeeNames, setEmployeeNames] = useState<string[]>([])
  const [orgEmployees, setOrgEmployees] = useState<Employee[]>([])
  const [executionTier, setExecutionTier] = useState<"solo" | "mid_pair">("solo")
  const [reviewerLossPolicy, setReviewerLossPolicy] = useState<string>("replace_then_degrade")
  const [reviewerToolProfile, setReviewerToolProfile] = useState<string>("read_only")
  const [maxInternalPasses, setMaxInternalPasses] = useState<string>("1")
  const [maxChildSessions, setMaxChildSessions] = useState<string>("3")
  const [maxWallClockMs, setMaxWallClockMs] = useState<string>("300000")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getOrg().then((org) => {
      setDepartments(org.departments)
      setOrgEmployees(org.employees)
      setEmployeeNames(buildSupervisorOptions(org.employees, {
        portalName: settings.portalName,
      }))
    }).catch(() => {})
  }, [settings.portalName])

  const employeeByName = useMemo(() => {
    const map = new Map<string, Employee>()
    for (const entry of orgEmployees) map.set(entry.name, entry)
    return map
  }, [orgEmployees])

  const departmentOptions = useMemo(() => {
    const names = new Set<string>()
    for (const name of departments) {
      const trimmed = name.trim()
      if (trimmed) names.add(trimmed)
    }
    if (departmentMode !== "custom") {
      const selected = department.trim()
      if (selected) names.add(selected)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [departments, department, departmentMode])

  const primarySupervisor = reportsTo[0] ?? ""

  useEffect(() => {
    if (departmentTouched || !primarySupervisor) return
    const supervisorDepartment = employeeByName.get(primarySupervisor)?.department?.trim()
    if (!supervisorDepartment || supervisorDepartment === department) return
    setDepartment(supervisorDepartment)
    setDepartmentMode("select")
  }, [department, departmentTouched, employeeByName, primarySupervisor])

  useEffect(() => {
    if (!department || departments.length === 0 || departments.includes(department)) return
    setDepartmentMode("custom")
  }, [department, departments])

  function chooseDepartment(next: string) {
    setDepartmentTouched(true)
    if (next === DEPARTMENT_PLACEHOLDER) return
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

  const nameInvalid = !name.trim() || !/^[a-z0-9][a-z0-9._-]*$/i.test(name.trim())
  const displayNameInvalid = displayName.trim().length === 0
  const departmentInvalid = department.trim().length === 0
  const personaInvalid = persona.trim().length === 0
  const canSave = !saving && !nameInvalid && !displayNameInvalid && !departmentInvalid && !personaInvalid

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const payload: EmployeeCreate = {
        name: name.trim(),
        displayName: displayName.trim(),
        department: department.trim(),
        rank,
        engine: selector.engine || "claude",
        model: selector.model || "",
        effortLevel: selector.effortLevel,
        persona: persona.trim(),
        reportsTo: serializeReportsTo(reportsTo),
        cliFlags: cliFlags.split(/\s+/).filter(Boolean),
        alwaysNotify,
        fallbackEngine: fallbackModel.trim() ? fallbackEngine : null,
        fallbackModel: fallbackModel.trim() || null,
        ...(icon ? iconPatchFromPickerValue(icon) : {}),
        execution: {
          tier: executionTier,
          ...(executionTier === "mid_pair" ? {
            reviewerLossPolicy: reviewerLossPolicy as import("@/lib/api-org").ReviewerLossPolicy,
            reviewerToolProfile: reviewerToolProfile as import("@/lib/api-org").ReviewerToolProfile,
            maxInternalPasses: parseInt(maxInternalPasses, 10) || 1,
            maxChildSessions: parseInt(maxChildSessions, 10) || 3,
            maxWallClockMs: parseInt(maxWallClockMs, 10) || 300000,
          } : {}),
        },
      }
      const res = await api.createEmployee(payload)
      if (res.employee) onCreated(res.employee)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create agent")
      setSaving(false)
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
              name={name}
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
            Add agent
          </h2>
        </div>
      </div>

      <Field label="Display name">
        <input
          className={inputCls}
          value={displayName}
          aria-label="Display name"
          onChange={(e) => {
            const next = e.target.value
            setDisplayName(next)
            if (!name.trim()) setName(suggestSlug(next))
          }}
          aria-invalid={displayNameInvalid}
        />
      </Field>

      <Field label="Agent ID" hint="Used for mentions and routing. Lowercase slug format is safest.">
        <input
          className={inputCls}
          value={name}
          aria-label="Agent ID"
          onChange={(e) => setName(suggestSlug(e.target.value))}
          aria-invalid={nameInvalid}
          placeholder="platform-lead"
        />
        {nameInvalid && (
          <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">
            Use letters, numbers, dots, underscores, or hyphens.
          </span>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-[var(--space-3)]">
        <Field label="Rank">
          <Select value={rank} onValueChange={(value) => setRank(value as EmployeeCreate["rank"])}>
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

        <Field label="Department" hint="Pick an existing department, or create a new one.">
          <Select
            value={departmentMode === "custom" ? DEPARTMENT_CUSTOM : department || DEPARTMENT_PLACEHOLDER}
            onValueChange={chooseDepartment}
          >
            <SelectTrigger aria-label="Department" aria-invalid={departmentInvalid}>
              <SelectValue placeholder="Choose department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEPARTMENT_PLACEHOLDER}>Choose department</SelectItem>
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
              aria-label="New department name"
              onChange={(e) => typeCustomDepartment(e.target.value)}
              aria-invalid={departmentInvalid}
              placeholder="platform"
            />
          )}
        </Field>
      </div>

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
          </div>
        )}
      </Field>

      <Field label="Reports to">
        <ReportsToField
          value={reportsTo}
          options={employeeNames}
          onChange={setReportsTo}
          hint="Primary stays first. Additional entries are secondary matrix links."
        />
      </Field>

      <Field label="Engine · Model · Effort">
        <div className="rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)]">
          <ModelSelectorRow mode="new" value={selector} onChange={setSelector} />
        </div>
      </Field>

      <Field label="Fallback model" hint="Optional cross-provider backup target for fallback handoffs.">
        <EmployeeFallbackModelSelect
          engine={selector.engine}
          primaryModel={selector.model}
          valueEngine={fallbackEngine}
          value={fallbackModel}
          onEngineChange={setFallbackEngine}
          onChange={setFallbackModel}
        />
      </Field>

      <Field
        label="Persona / instructions"
        hint={personaInvalid ? "Persona is required before you can create the agent." : undefined}
      >
        <Textarea
          rows={10}
          value={persona}
          aria-label="Persona / instructions"
          onChange={(e) => setPersona(e.target.value)}
          aria-invalid={personaInvalid}
        />
        {personaInvalid && (
          <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">
            Persona is required.
          </span>
        )}
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

      <div className="flex items-center justify-end gap-[var(--space-2)] sticky bottom-0 pt-[var(--space-2)] bg-[var(--material-regular)]">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button
          onClick={() => void save()}
          disabled={!canSave}
          aria-label={personaInvalid ? "Create agent — persona is required" : saving ? "Creating agent" : "Create agent"}
          title={personaInvalid ? "Persona is required" : undefined}
        >
          {saving ? "Creating…" : "Create agent"}
        </Button>
      </div>
    </div>
  )
}
