import type React from "react"
import { RotateCcw, Trash2 } from "lucide-react"
import { api } from "@/lib/api"
import { useToast } from "@/components/ui/toast"
import type { Config } from "./settings-constants"

interface SectionProps {
  title: string
  children: React.ReactNode
}

interface FieldRowProps {
  label: string
  children: React.ReactNode
}

interface SettingsInputProps {
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
}

interface SettingsSelectProps {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}

interface ToggleSwitchProps {
  checked: boolean
  onChange: (value: boolean) => void
}

type ConnectorInstance = NonNullable<NonNullable<Config["connectors"]>["instances"]>[number]

export interface SettingsConnectorsSectionProps {
  config: Config
  updateConfig: (path: string[], value: unknown) => void
  waQr: string | null
  waStatus: string
  employees: Array<{ name: string; displayName: string }>
  Section: React.ComponentType<SectionProps>
  FieldRow: React.ComponentType<FieldRowProps>
  SettingsInput: React.ComponentType<SettingsInputProps>
  SettingsSelect: React.ComponentType<SettingsSelectProps>
  ToggleSwitch: React.ComponentType<ToggleSwitchProps>
}

function updateInstanceAt(
  instances: ConnectorInstance[],
  idx: number,
  patch: Partial<ConnectorInstance>,
): ConnectorInstance[] {
  const next = [...instances]
  next[idx] = { ...next[idx], ...patch }
  return next
}

export function SettingsConnectorsSection({
  config,
  updateConfig,
  waQr,
  waStatus,
  employees,
  Section,
  FieldRow,
  SettingsInput,
  SettingsSelect,
  ToggleSwitch,
}: SettingsConnectorsSectionProps) {
  const { pushToast } = useToast()
  const instances = config.connectors?.instances || []

  return (
    <Section title="Connectors">
      <div
        className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
      >
        Slack
      </div>
      <FieldRow label="App Token">
        <SettingsInput
          type="password"
          value={config.connectors?.slack?.appToken ?? ""}
          onChange={(v) => updateConfig(["connectors", "slack", "appToken"], v)}
          placeholder="xapp-..."
        />
      </FieldRow>
      <FieldRow label="Bot Token">
        <SettingsInput
          type="password"
          value={config.connectors?.slack?.botToken ?? ""}
          onChange={(v) => updateConfig(["connectors", "slack", "botToken"], v)}
          placeholder="xoxb-..."
        />
      </FieldRow>
      <FieldRow label="Share Session in Channel">
        <ToggleSwitch
          checked={config.connectors?.slack?.shareSessionInChannel ?? false}
          onChange={(v) => updateConfig(["connectors", "slack", "shareSessionInChannel"], v)}
        />
      </FieldRow>
      <FieldRow label="Allowed Users">
        <SettingsInput
          value={Array.isArray(config.connectors?.slack?.allowFrom)
            ? config.connectors?.slack?.allowFrom?.join(", ")
            : config.connectors?.slack?.allowFrom ?? ""}
          onChange={(v) =>
            updateConfig(
              ["connectors", "slack", "allowFrom"],
              v.trim() ? v.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
            )
          }
          placeholder="U123, U456"
        />
      </FieldRow>
      <FieldRow label="Ignore Old Messages on Boot">
        <ToggleSwitch
          checked={config.connectors?.slack?.ignoreOldMessagesOnBoot ?? true}
          onChange={(v) => updateConfig(["connectors", "slack", "ignoreOldMessagesOnBoot"], v)}
        />
      </FieldRow>

      <div
        className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
      />
      <div
        className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mt-[var(--space-4)] mb-[var(--space-2)]"
      >
        WhatsApp
      </div>
      <div
        className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]"
      >
        On first start, scan the QR code below with your WhatsApp app to connect. Credentials are cached for subsequent runs.
      </div>
      <FieldRow label="Auth Directory">
        <SettingsInput
          value={config.connectors?.whatsapp?.authDir ?? ""}
          onChange={(v) => updateConfig(["connectors", "whatsapp", "authDir"], v.trim() || undefined)}
          placeholder="Default: ~/.cuttlefish/.whatsapp-auth"
        />
      </FieldRow>
      <FieldRow label="Allow From">
        <SettingsInput
          value={Array.isArray(config.connectors?.whatsapp?.allowFrom)
            ? config.connectors?.whatsapp?.allowFrom?.join(", ")
            : ""}
          onChange={(v) =>
            updateConfig(
              ["connectors", "whatsapp", "allowFrom"],
              v.trim() ? v.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
            )
          }
          placeholder="447700900000@s.whatsapp.net, ... (optional)"
        />
      </FieldRow>

      {waQr && (
        <div
          className="mt-[var(--space-3)] flex flex-col items-center gap-[var(--space-2)]"
        >
          <div
            className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-secondary)]"
          >
            Scan with WhatsApp to connect
          </div>
          <img
            src={waQr}
            alt="WhatsApp QR Code"
            className="h-[200px] w-[200px] max-w-full rounded-[var(--radius-md)] border border-[var(--separator)] bg-white p-[8px]"
          />
          <div
            className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
          >
            Open WhatsApp → Linked Devices → Link a Device
          </div>
        </div>
      )}
      {config.connectors?.whatsapp && waStatus === "ok" && (
        <div
          className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--system-green)] font-semibold"
        >
          ✓ Connected
        </div>
      )}

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />
      <div className="flex items-center justify-between mb-[var(--space-2)]">
        <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
          Connector Instances
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <button
            className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors flex items-center gap-1"
            onClick={async () => {
              try {
                const result = await api.reloadConnectors()
                const parts: string[] = []
                if (result.stopped.length) parts.push(`Stopped: ${result.stopped.join(", ")}`)
                if (result.started.length) parts.push(`Started: ${result.started.join(", ")}`)
                if (result.errors.length) parts.push(`Errors: ${result.errors.join(", ")}`)
                pushToast({
                  title: "Connector reload finished",
                  description: parts.length ? parts.join(" ") : "No connector instances to reload.",
                  tone: result.errors.length ? "error" : "success",
                })
              } catch {
                pushToast({
                  tone: "error",
                  title: "Failed to reload connectors",
                })
              }
            }}
          >
            <RotateCcw size={12} />
            Reload
          </button>
          <button
            className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--accent)] hover:opacity-80 transition-opacity"
            onClick={() => {
              const next = [...instances]
              const id = `slack-${next.length + 1}`
              next.push({ id, type: "slack" })
              updateConfig(["connectors", "instances"], next)
            }}
          >
            + Add Instance
          </button>
        </div>
      </div>
      <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
        Add multiple connector instances of the same type, each bound to a specific employee.
      </div>
      {instances.map((instance, idx) => (
        <div
          key={`connector-instance-${idx}`}
          className="mb-[var(--space-4)] p-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--bg-secondary)]"
        >
          <div className="flex items-center justify-between mb-[var(--space-2)]">
            <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {instance.id || `Instance ${idx + 1}`}
            </div>
            <button
              className="text-[var(--system-red)] hover:opacity-80 transition-opacity p-[var(--space-1)]"
              onClick={() => {
                const next = [...instances]
                next.splice(idx, 1)
                updateConfig(["connectors", "instances"], next.length > 0 ? next : undefined)
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <FieldRow label="Instance ID">
            <SettingsInput
              value={instance.id ?? ""}
              onChange={(v) => updateConfig(["connectors", "instances"], updateInstanceAt(instances, idx, { id: v }))}
              placeholder="e.g. slack-ops"
            />
          </FieldRow>
          <FieldRow label="Type">
            <SettingsSelect
              value={instance.type ?? "slack"}
              onChange={(v) =>
                updateConfig(["connectors", "instances"], updateInstanceAt(instances, idx, { type: v as ConnectorInstance["type"] }))
              }
              options={[
                { value: "slack", label: "Slack" },
                { value: "whatsapp", label: "WhatsApp" },
              ]}
            />
          </FieldRow>
          <FieldRow label="Employee">
            <SettingsSelect
              value={instance.employee ?? ""}
              onChange={(v) =>
                updateConfig(["connectors", "instances"], updateInstanceAt(instances, idx, { employee: v || undefined }))
              }
              options={[
                { value: "", label: "Default (COO)" },
                ...employees.map((e) => ({ value: e.name, label: e.displayName })),
              ]}
            />
          </FieldRow>
          {instance.type === "slack" && (
            <>
              <FieldRow label="App Token">
                <SettingsInput
                  type="password"
                  value={instance.appToken ?? ""}
                  onChange={(v) => updateConfig(["connectors", "instances"], updateInstanceAt(instances, idx, { appToken: v }))}
                  placeholder="xapp-..."
                />
              </FieldRow>
              <FieldRow label="Bot Token">
                <SettingsInput
                  type="password"
                  value={instance.botToken ?? ""}
                  onChange={(v) => updateConfig(["connectors", "instances"], updateInstanceAt(instances, idx, { botToken: v }))}
                  placeholder="xoxb-..."
                />
              </FieldRow>
              <FieldRow label="Allow From">
                <SettingsInput
                  value={Array.isArray(instance.allowFrom) ? instance.allowFrom.join(", ") : instance.allowFrom ?? ""}
                  onChange={(v) =>
                    updateConfig(
                      ["connectors", "instances"],
                      updateInstanceAt(instances, idx, {
                        allowFrom: v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
                      }),
                    )
                  }
                  placeholder="U123, U456"
                />
              </FieldRow>
            </>
          )}
          {instance.type === "whatsapp" && (
            <>
              <FieldRow label="Auth Directory">
                <SettingsInput
                  value={instance.authDir ?? ""}
                  onChange={(v) => updateConfig(["connectors", "instances"], updateInstanceAt(instances, idx, { authDir: v.trim() || undefined }))}
                  placeholder="Default: ~/.cuttlefish/.whatsapp-auth"
                />
              </FieldRow>
              <FieldRow label="Allow From">
                <SettingsInput
                  value={Array.isArray(instance.allowFrom) ? instance.allowFrom.join(", ") : ""}
                  onChange={(v) =>
                    updateConfig(
                      ["connectors", "instances"],
                      updateInstanceAt(instances, idx, {
                        allowFrom: v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
                      }),
                    )
                  }
                  placeholder="Phone JIDs, comma-separated"
                />
              </FieldRow>
            </>
          )}
        </div>
      ))}

      <div
        className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
      />

      <div
        className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
      >
        Web UI
      </div>
      <div
        className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
      >
        Web conversations use queued one-shot resume flow for both engines.
      </div>
    </Section>
  )
}
