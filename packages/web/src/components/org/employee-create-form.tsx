import { useEffect, useState } from "react"
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
    model: "sonnet",
  })
  const { settings } = useSettings()
  const [departments, setDepartments] = useState<string[]>([])
  const [employeeNames, setEmployeeNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getOrg().then((org) => {
      setDepartments(org.departments)
      setEmployeeNames(buildSupervisorOptions(org.employees, {
        portalName: settings.portalName,
      }))
    }).catch(() => {})
  }, [settings.portalName])

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
        <Field label="Level">
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

        <Field label="Department" hint={departments.length ? `Known: ${departments.join(", ")}` : undefined}>
          <input
            className={inputCls}
            value={department}
            aria-label="Department"
            onChange={(e) => setDepartment(e.target.value)}
            aria-invalid={departmentInvalid}
            placeholder="platform"
          />
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

      <Field label="Persona / instructions">
        <Textarea
          rows={10}
          value={persona}
          aria-label="Persona / instructions"
          onChange={(e) => setPersona(e.target.value)}
          aria-invalid={personaInvalid}
        />
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
        <Button onClick={() => void save()} disabled={!canSave}>
          {saving ? "Creating…" : "Create agent"}
        </Button>
      </div>
    </div>
  )
}
