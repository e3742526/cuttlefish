import { Loader2, RotateCcw, Save } from "lucide-react"
import { formatFallbackChain, formatLineList, parseFallbackChain, parseLineList } from "./settings-config"
import type { Config } from "./settings-constants"
import { FieldHint, FieldRow, Section, SettingsInput, SettingsSelect, SettingsTextarea, ToggleSwitch } from "./settings-fields"

type Option = { value: string; label: string }

interface SharedConfigProps {
  config: Config
  updateConfig: (path: string[], value: unknown) => void
  updateNumberConfig: (path: string[], value: string) => void
}

interface RegistryProps {
  modelOptions: (engine: string, fallback: Option[]) => Option[]
  effortOptions: (engine: string, fallback: Option[]) => Option[]
}

type EmailInbox = NonNullable<NonNullable<Config["email"]>["inboxes"]>[number]

function nextInboxId(inboxes: EmailInbox[]): string {
  const taken = new Set(inboxes.map((inbox) => inbox.id).filter((id): id is string => typeof id === "string" && id.length > 0))
  for (let index = 1; index <= 3; index += 1) {
    const candidate = `inbox-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `inbox-${inboxes.length + 1}`
}

function createInboxDraft(inboxes: EmailInbox[]): EmailInbox {
  return {
    id: nextInboxId(inboxes),
    label: `Inbox ${inboxes.length + 1}`,
    address: "",
    username: "",
    password: "",
    imapHost: "",
    imapPort: 993,
    useTls: true,
    folder: "INBOX",
    autoIngest: true,
    unreadOnly: true,
    maxMessagesPerPoll: 10,
  }
}

export function ConfigFeedback({
  feedback,
}: {
  feedback: { type: "success" | "error"; message: string } | null
}) {
  if (!feedback) return null
  return (
    <div
      className="mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] text-[length:var(--text-footnote)]"
      style={{
        background:
          feedback.type === "success"
            ? "rgba(34,197,94,0.1)"
            : "rgba(239,68,68,0.1)",
        border: `1px solid ${
          feedback.type === "success"
            ? "rgba(34,197,94,0.3)"
            : "rgba(239,68,68,0.3)"
        }`,
        color:
          feedback.type === "success"
            ? "var(--system-green)"
            : "var(--system-red)",
      }}
    >
      {feedback.message}
    </div>
  )
}

export function ConfigLoadState({
  configError,
  configLoading,
}: {
  configError: string | null
  configLoading: boolean
}) {
  if (configLoading) {
    return (
      <div className="text-center p-[var(--space-8)] text-[var(--text-tertiary)] text-[length:var(--text-footnote)]">
        <Loader2
          size={20}
          className="mx-auto mb-[var(--space-2)] animate-spin"
        />
        Loading gateway config...
      </div>
    )
  }

  if (!configError) return null

  return (
    <div
      className="mb-[var(--space-6)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] text-[length:var(--text-footnote)] text-[var(--system-red)]"
      style={{
        background: "rgba(239,68,68,0.1)",
        border: "1px solid rgba(239,68,68,0.3)",
      }}
    >
      Failed to load config: {configError}
    </div>
  )
}

export function GatewayWorkspacesSection({
  config,
  updateConfig,
  updateNumberConfig,
}: SharedConfigProps) {
  return (
    <Section title="Gateway & Workspaces">
      <FieldRow label="Port">
        <SettingsInput
          type="number"
          value={String(config.gateway?.port ?? "")}
          onChange={(v) => updateNumberConfig(["gateway", "port"], v)}
          placeholder="8888"
        />
      </FieldRow>
      <FieldRow label="Host">
        <SettingsInput
          value={config.gateway?.host ?? ""}
          onChange={(v) => updateConfig(["gateway", "host"], v)}
          placeholder="127.0.0.1"
        />
      </FieldRow>
      <FieldRow label="Default Engine">
        <SettingsSelect
          value={config.engines?.default ?? "claude"}
          onChange={(v) => updateConfig(["engines", "default"], v)}
          options={[
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
            { value: "grok", label: "Grok" },
            { value: "ollama", label: "Ollama" },
            { value: "kilo", label: "Kilo" },
            { value: "aider", label: "Aider" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Default Working Dir">
        <SettingsInput
          value={config.workspaces?.defaultCwd ?? ""}
          onChange={(v) => updateConfig(["workspaces", "defaultCwd"], v.trim() || undefined)}
          placeholder="~/.cuttlefish"
        />
      </FieldRow>
      <FieldRow label="Workspace Roots">
        <SettingsTextarea
          value={formatLineList(config.workspaces?.roots)}
          onChange={(v) => updateConfig(["workspaces", "roots"], parseLineList(v))}
          placeholder={"/path/to/project-a\n/path/to/project-b"}
          rows={4}
        />
      </FieldRow>
      <FieldHint>
        One allowed root per line. Session working directories must resolve inside one of these roots when this list is set.
      </FieldHint>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Turn Stall Watchdog
      </div>
      <FieldRow label="Inactivity (ms)">
        <SettingsInput
          type="number"
          value={String(config.gateway?.turnStallInactivityMs ?? "")}
          onChange={(v) => updateNumberConfig(["gateway", "turnStallInactivityMs"], v)}
          placeholder="180000"
        />
      </FieldRow>
      <FieldRow label="Hard Ceiling (ms)">
        <SettingsInput
          type="number"
          value={String(config.gateway?.turnStallCeilingMs ?? "")}
          onChange={(v) => updateNumberConfig(["gateway", "turnStallCeilingMs"], v)}
          placeholder="2700000"
        />
      </FieldRow>
      <FieldRow label="Same-Engine Retries">
        <SettingsInput
          type="number"
          value={String(config.gateway?.turnStallRetries ?? "")}
          onChange={(v) => updateNumberConfig(["gateway", "turnStallRetries"], v)}
          placeholder="1"
        />
      </FieldRow>
      <FieldHint>
        These watchdog settings control when a quiet turn is treated as stalled and whether Cuttlefish retries once before escalating.
      </FieldHint>
    </Section>
  )
}

export function EmailSettingsSection({
  config,
  updateConfig,
  updateNumberConfig,
}: SharedConfigProps) {
  const inboxes = config.email?.inboxes ?? []

  function updateInbox(index: number, patch: Partial<EmailInbox>) {
    const next = inboxes.map((inbox, currentIndex) => (
      currentIndex === index ? { ...inbox, ...patch } : inbox
    ))
    updateConfig(["email", "inboxes"], next)
  }

  function removeInbox(index: number) {
    const next = inboxes.filter((_, currentIndex) => currentIndex !== index)
    updateConfig(["email", "inboxes"], next.length > 0 ? next : undefined)
  }

  function addInbox() {
    if (inboxes.length >= 3) return
    updateConfig(["email", "inboxes"], [...inboxes, createInboxDraft(inboxes)])
  }

  return (
    <Section title="Email Inboxes">
      <FieldRow label="Enabled">
        <ToggleSwitch
          checked={config.email?.enabled ?? false}
          onChange={(v) => updateConfig(["email", "enabled"], v)}
        />
      </FieldRow>
      <FieldRow label="Poll Interval (s)">
        <SettingsInput
          type="number"
          value={String(config.email?.pollIntervalSeconds ?? "")}
          onChange={(v) => updateNumberConfig(["email", "pollIntervalSeconds"], v)}
          placeholder="60"
        />
      </FieldRow>
      <FieldHint>
        Configure up to 3 IMAP inboxes. New mail can be cached for inspection or auto-ingested into a COO-owned session.
      </FieldHint>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-3)]">
        <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
          Configured inboxes: {inboxes.length}/3
        </div>
        <button
          type="button"
          onClick={addInbox}
          disabled={inboxes.length >= 3}
          className="px-[10px] py-[6px] rounded-[var(--radius-sm)] border border-[var(--separator)] text-[length:var(--text-footnote)] disabled:opacity-50"
        >
          Add inbox
        </button>
      </div>

      {inboxes.map((inbox, index) => (
        <div
          key={inbox.id || `email-inbox-${index}`}
          className="mb-[var(--space-4)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--bg-secondary)] p-[var(--space-3)]"
        >
          <div className="flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-2)]">
            <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {inbox.label?.trim() || inbox.id || `Inbox ${index + 1}`}
            </div>
            <button
              type="button"
              onClick={() => removeInbox(index)}
              className="px-[10px] py-[6px] rounded-[var(--radius-sm)] border border-[var(--separator)] text-[length:var(--text-footnote)]"
            >
              Remove
            </button>
          </div>

          <FieldRow label="Inbox ID">
            <SettingsInput
              value={inbox.id ?? ""}
              onChange={(v) => updateInbox(index, { id: v })}
              placeholder="ops-support"
            />
          </FieldRow>
          <FieldRow label="Label">
            <SettingsInput
              value={inbox.label ?? ""}
              onChange={(v) => updateInbox(index, { label: v })}
              placeholder="Support Inbox"
            />
          </FieldRow>
          <FieldRow label="Email Address">
            <SettingsInput
              value={inbox.address ?? ""}
              onChange={(v) => updateInbox(index, { address: v })}
              placeholder="support@example.com"
            />
          </FieldRow>
          <FieldRow label="Username">
            <SettingsInput
              value={inbox.username ?? ""}
              onChange={(v) => updateInbox(index, { username: v })}
              placeholder="support@example.com"
            />
          </FieldRow>
          <FieldRow label="Password">
            <SettingsInput
              type="password"
              value={inbox.password ?? ""}
              onChange={(v) => updateInbox(index, { password: v })}
              placeholder="app password"
            />
          </FieldRow>
          <FieldRow label="IMAP Host">
            <SettingsInput
              value={inbox.imapHost ?? ""}
              onChange={(v) => updateInbox(index, { imapHost: v })}
              placeholder="imap.gmail.com"
            />
          </FieldRow>
          <FieldRow label="IMAP Port">
            <SettingsInput
              type="number"
              value={String(inbox.imapPort ?? "")}
              onChange={(v) => updateInbox(index, { imapPort: v.trim() ? Number(v) : undefined })}
              placeholder="993"
            />
          </FieldRow>
          <FieldRow label="Folder">
            <SettingsInput
              value={inbox.folder ?? ""}
              onChange={(v) => updateInbox(index, { folder: v })}
              placeholder="INBOX"
            />
          </FieldRow>
          <FieldRow label="Use TLS">
            <ToggleSwitch
              checked={inbox.useTls ?? true}
              onChange={(v) => updateInbox(index, { useTls: v })}
            />
          </FieldRow>
          <FieldRow label="Unread Only">
            <ToggleSwitch
              checked={inbox.unreadOnly ?? true}
              onChange={(v) => updateInbox(index, { unreadOnly: v })}
            />
          </FieldRow>
          <FieldRow label="Auto-Ingest">
            <ToggleSwitch
              checked={inbox.autoIngest ?? true}
              onChange={(v) => updateInbox(index, { autoIngest: v })}
            />
          </FieldRow>
          <FieldRow label="Max Messages/Poll">
            <SettingsInput
              type="number"
              value={String(inbox.maxMessagesPerPoll ?? "")}
              onChange={(v) => updateInbox(index, { maxMessagesPerPoll: v.trim() ? Number(v) : undefined })}
              placeholder="10"
            />
          </FieldRow>
        </div>
      ))}

      {inboxes.length === 0 ? (
        <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
          No inboxes configured yet.
        </div>
      ) : null}
    </Section>
  )
}

export function EngineConfigurationSection({
  config,
  effortOptions,
  modelOptions,
  updateConfig,
}: SharedConfigProps & RegistryProps) {
  return (
    <Section title="Engine Configuration">
      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Claude
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.claude?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "claude", "bin"], v)}
          placeholder="claude"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={config.engines?.claude?.model ?? "opus"}
          onChange={(v) => updateConfig(["engines", "claude", "model"], v)}
          options={modelOptions("claude", [
            { value: "claude-fable-5", label: "Fable 5" },
            { value: "opus", label: "Opus" },
            { value: "sonnet", label: "Sonnet" },
            { value: "haiku", label: "Haiku" },
          ])}
        />
      </FieldRow>
      <FieldRow label="Effort Level">
        <SettingsSelect
          value={config.engines?.claude?.effortLevel ?? "default"}
          onChange={(v) => updateConfig(["engines", "claude", "effortLevel"], v)}
          options={effortOptions("claude", [
            { value: "default", label: "Default" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Codex
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.codex?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "codex", "bin"], v)}
          placeholder="codex"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={config.engines?.codex?.model ?? "gpt-5.5"}
          onChange={(v) => updateConfig(["engines", "codex", "model"], v)}
          options={modelOptions("codex", [
            { value: "gpt-5.5", label: "GPT-5.5" },
            { value: "gpt-5.4", label: "GPT-5.4" },
            { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
            { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
            { value: "gpt-5.2", label: "GPT-5.2" },
            { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
            { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
          ])}
        />
      </FieldRow>
      <FieldRow label="Effort Level">
        <SettingsSelect
          value={config.engines?.codex?.effortLevel ?? "default"}
          onChange={(v) => updateConfig(["engines", "codex", "effortLevel"], v)}
          options={effortOptions("codex", [
            { value: "default", label: "Default" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Grok
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.grok?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "grok", "bin"], v)}
          placeholder="grok"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={config.engines?.grok?.model ?? "grok-build"}
          onChange={(v) => updateConfig(["engines", "grok", "model"], v)}
          options={modelOptions("grok", [
            { value: "grok-build", label: "Grok Build" },
            { value: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Ollama
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.ollama?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "ollama", "bin"], v)}
          placeholder="ollama"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={config.engines?.ollama?.model ?? "gemma4"}
          onChange={(v) => updateConfig(["engines", "ollama", "model"], v)}
          options={modelOptions("ollama", [
            { value: "gemma4", label: "Gemma 4" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Kilo
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.kilo?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "kilo", "bin"], v)}
          placeholder="kilo"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={config.engines?.kilo?.model ?? "default"}
          onChange={(v) => updateConfig(["engines", "kilo", "model"], v)}
          options={modelOptions("kilo", [
            { value: "default", label: "Kilo (auto)" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Aider
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.aider?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "aider", "bin"], v)}
          placeholder="aider"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsInput
          value={config.engines?.aider?.model ?? ""}
          onChange={(v) => updateConfig(["engines", "aider", "model"], v)}
          placeholder="default (auto-detect from API key)"
        />
      </FieldRow>
      <FieldHint>
        Leave the model as "default" to let aider auto-detect from whichever provider
        API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) is set in the gateway's
        environment.
      </FieldHint>
    </Section>
  )
}

export function RecoveryFallbacksSection({
  config,
  updateConfig,
}: SharedConfigProps) {
  return (
    <Section title="Recovery & Fallbacks">
      <FieldRow label="Interrupt on New Message">
        <ToggleSwitch
          checked={config.sessions?.interruptOnNewMessage ?? true}
          onChange={(v) => updateConfig(["sessions", "interruptOnNewMessage"], v)}
        />
      </FieldRow>
      <FieldHint>
        When enabled, sending a new message to a running session will stop the
        current agent and start processing your new message immediately. When
        disabled, messages are queued.
      </FieldHint>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <FieldRow label="Usage Limit Strategy">
        <SettingsSelect
          value={config.sessions?.rateLimitStrategy ?? "fallback"}
          onChange={(v) => updateConfig(["sessions", "rateLimitStrategy"], v)}
          options={[
            { value: "wait", label: "Wait & Auto-Resume" },
            { value: "fallback", label: "Switch to GPT (Codex)" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Fallback Engine">
        <SettingsSelect
          value={config.sessions?.fallbackEngine ?? "codex"}
          onChange={(v) => updateConfig(["sessions", "fallbackEngine"], v)}
          options={[
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
            { value: "antigravity", label: "Antigravity" },
            { value: "grok", label: "Grok" },
            { value: "pi", label: "Pi" },
            { value: "kiro", label: "Kiro" },
            { value: "ollama", label: "Ollama" },
            { value: "kilo", label: "Kilo" },
            { value: "aider", label: "Aider" },
          ]}
        />
      </FieldRow>
      <FieldHint>
        "Wait" pauses the session and continues automatically when Claude resets.
        "Switch" answers immediately using GPT, then returns to Claude once the reset window passes.
      </FieldHint>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Global Model Fallback
      </div>
      <FieldRow label="Enabled">
        <ToggleSwitch
          checked={config.modelFallback?.enabled ?? true}
          onChange={(v) => updateConfig(["modelFallback", "enabled"], v)}
        />
      </FieldRow>
      <FieldRow label="Mode">
        <SettingsSelect
          value={config.modelFallback?.defaultMode ?? "auto"}
          onChange={(v) => updateConfig(["modelFallback", "defaultMode"], v)}
          options={[
            { value: "auto", label: "Auto" },
            { value: "ask_user", label: "Ask User" },
            { value: "never", label: "Never" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Fallback Chain">
        <SettingsTextarea
          value={formatFallbackChain(config.modelFallback?.globalChain)}
          onChange={(v) => updateConfig(["modelFallback", "globalChain"], parseFallbackChain(v))}
          placeholder={"codex | gpt-5.5 | high\nclaude | claude-sonnet-5 | medium | reviewer | balanced backup"}
          rows={4}
        />
      </FieldRow>
      <FieldHint>
        One fallback target per line: <code>engine | model | effort | employee | reason</code>. Later columns are optional.
      </FieldHint>
    </Section>
  )
}

export function BoardWorkerSection({
  config,
  updateConfig,
  updateNumberConfig,
}: SharedConfigProps) {
  return (
    <Section title="Board Worker">
      <FieldRow label="Enabled">
        <ToggleSwitch
          checked={config.boardWorker?.enabled ?? false}
          onChange={(v) => updateConfig(["boardWorker", "enabled"], v)}
        />
      </FieldRow>
      <FieldRow label="Idle Minutes">
        <SettingsInput
          type="number"
          value={String(config.boardWorker?.idleMinutes ?? "")}
          onChange={(v) => updateNumberConfig(["boardWorker", "idleMinutes"], v)}
          placeholder="30"
        />
      </FieldRow>
      <FieldRow label="Timezone">
        <SettingsInput
          value={config.boardWorker?.timezone ?? ""}
          onChange={(v) => updateConfig(["boardWorker", "timezone"], v.trim() || undefined)}
          placeholder="America/New_York"
        />
      </FieldRow>
      <FieldRow label="Min Remaining %">
        <SettingsInput
          type="number"
          value={String(config.boardWorker?.usage?.minRemainingPercent ?? "")}
          onChange={(v) => updateNumberConfig(["boardWorker", "usage", "minRemainingPercent"], v)}
          placeholder="15"
        />
      </FieldRow>
      <FieldRow label="Weekday Window">
        <div className="flex gap-[var(--space-2)]">
          <SettingsInput
            value={config.boardWorker?.schedule?.weekday?.start ?? ""}
            onChange={(v) => updateConfig(["boardWorker", "schedule", "weekday", "start"], v.trim() || undefined)}
            placeholder="22:00"
          />
          <SettingsInput
            value={config.boardWorker?.schedule?.weekday?.end ?? ""}
            onChange={(v) => updateConfig(["boardWorker", "schedule", "weekday", "end"], v.trim() || undefined)}
            placeholder="04:00"
          />
        </div>
      </FieldRow>
      <FieldRow label="Weekend Window">
        <div className="flex gap-[var(--space-2)]">
          <SettingsInput
            value={config.boardWorker?.schedule?.weekend?.start ?? ""}
            onChange={(v) => updateConfig(["boardWorker", "schedule", "weekend", "start"], v.trim() || undefined)}
            placeholder="22:00"
          />
          <SettingsInput
            value={config.boardWorker?.schedule?.weekend?.end ?? ""}
            onChange={(v) => updateConfig(["boardWorker", "schedule", "weekend", "end"], v.trim() || undefined)}
            placeholder="04:00"
          />
        </div>
      </FieldRow>
      <FieldHint>
        The board worker auto-dispatches TODO tickets only when chats are idle, the schedule window is open, and the selected engine still has headroom.
      </FieldHint>
    </Section>
  )
}

export function OrchestrationSection({
  config,
  updateConfig,
  updateNumberConfig,
}: SharedConfigProps) {
  return (
    <Section title="Orchestration">
      <FieldRow label="Enabled">
        <ToggleSwitch
          checked={config.orchestration?.enabled ?? false}
          onChange={(v) => updateConfig(["orchestration", "enabled"], v)}
        />
      </FieldRow>
      <FieldRow label="Config Dir">
        <SettingsInput
          value={config.orchestration?.configDir ?? ""}
          onChange={(v) => updateConfig(["orchestration", "configDir"], v.trim() || undefined)}
          placeholder="~/.cuttlefish/orchestration"
        />
      </FieldRow>
      <FieldRow label="DB Path">
        <SettingsInput
          value={config.orchestration?.dbPath ?? ""}
          onChange={(v) => updateConfig(["orchestration", "dbPath"], v.trim() || undefined)}
          placeholder="~/.cuttlefish/orchestration/orchestration.db"
        />
      </FieldRow>
      <FieldRow label="Worktree Root">
        <SettingsInput
          value={config.orchestration?.worktreeRoot ?? ""}
          onChange={(v) => updateConfig(["orchestration", "worktreeRoot"], v.trim() || undefined)}
          placeholder="~/.cuttlefish/orchestration/worktrees"
        />
      </FieldRow>
      <FieldRow label="Max Worktrees">
        <SettingsInput
          type="number"
          value={String(config.orchestration?.maxWorktrees ?? "")}
          onChange={(v) => updateNumberConfig(["orchestration", "maxWorktrees"], v)}
          placeholder="12"
        />
      </FieldRow>
      <FieldRow label="Same-family Reviewer Fallback">
        <ToggleSwitch
          checked={config.orchestration?.sameFamilyReviewerFallback ?? false}
          onChange={(v) => updateConfig(["orchestration", "sameFamilyReviewerFallback"], v)}
        />
      </FieldRow>
      <FieldRow label="Empirical Routing">
        <ToggleSwitch
          checked={config.orchestration?.empiricalRouting ?? false}
          onChange={(v) => updateConfig(["orchestration", "empiricalRouting"], v)}
        />
      </FieldRow>
      <FieldHint>
        Turn this on to bind the orchestration runtime. The config directory should contain workers, roles, and coordinators definitions.
      </FieldHint>
    </Section>
  )
}

export function CronSection({
  config,
  updateConfig,
}: SharedConfigProps) {
  return (
    <Section title="Cron">
      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Default Delivery
      </div>
      <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
        When a cron job has no delivery configured, results will be sent here.
      </div>
      <FieldRow label="Connector">
        <SettingsSelect
          value={config.cron?.defaultDelivery?.connector ?? ""}
          onChange={(v) => updateConfig(["cron", "defaultDelivery", "connector"], v || undefined)}
          options={[
            { value: "", label: "None (fire & forget)" },
            { value: "web", label: "Web" },
            { value: "slack", label: "Slack" },
          ]}
        />
      </FieldRow>
      {config.cron?.defaultDelivery?.connector && (
        <FieldRow label="Channel">
          <SettingsInput
            value={config.cron?.defaultDelivery?.channel ?? ""}
            onChange={(v) => updateConfig(["cron", "defaultDelivery", "channel"], v)}
            placeholder="#general"
          />
        </FieldRow>
      )}
    </Section>
  )
}

export function LoggingSection({
  config,
  updateConfig,
}: SharedConfigProps) {
  return (
    <Section title="Logging">
      <FieldRow label="Level">
        <SettingsSelect
          value={config.logging?.level ?? "info"}
          onChange={(v) => updateConfig(["logging", "level"], v)}
          options={[
            { value: "debug", label: "Debug" },
            { value: "info", label: "Info" },
            { value: "warn", label: "Warn" },
            { value: "error", label: "Error" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Stdout">
        <ToggleSwitch
          checked={config.logging?.stdout ?? true}
          onChange={(v) => updateConfig(["logging", "stdout"], v)}
        />
      </FieldRow>
      <FieldRow label="File Logging">
        <ToggleSwitch
          checked={config.logging?.file ?? false}
          onChange={(v) => updateConfig(["logging", "file"], v)}
        />
      </FieldRow>
    </Section>
  )
}

export function ConfigActions({
  loadConfig,
  saving,
  onSave,
}: {
  loadConfig: () => void
  saving: boolean
  onSave: () => void
}) {
  return (
    <div className="flex justify-end gap-[var(--space-3)] mb-[var(--space-6)]">
      <button
        onClick={() => loadConfig()}
        className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-medium)] inline-flex items-center gap-[6px]"
      >
        <RotateCcw size={14} />
        Reload
      </button>
      <button
        onClick={onSave}
        disabled={saving}
        className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none text-[length:var(--text-footnote)] font-[var(--weight-semibold)] inline-flex items-center gap-[6px] transition-all duration-150 ease-[var(--ease-smooth)]"
        style={{
          cursor: saving ? "wait" : "pointer",
          opacity: saving ? 0.7 : 1,
        }}
      >
        <Save size={14} />
        {saving ? "Saving..." : "Save Config"}
      </button>
    </div>
  )
}
