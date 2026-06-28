import { useEffect, useState } from "react"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { useModelRegistry } from "@/hooks/use-model-registry"
import { api } from "@/lib/api"
import { useAuth } from "@/routes/auth-provider"
import { useTheme } from "@/routes/providers"
import { useSettings } from "@/routes/settings-provider"
import { SettingsConnectorsSection } from "./settings-connectors-section"
import type { Config } from "./settings-constants"
import {
  AppearanceSection,
  BrandingSection,
  CooEmojiSection,
  PairingSection,
  ResetSection,
} from "./settings-page-sections"
import {
  BoardWorkerSection,
  ConfigActions,
  ConfigFeedback,
  ConfigLoadState,
  CronSection,
  EmailSettingsSection,
  EngineConfigurationSection,
  GatewayWorkspacesSection,
  LoggingSection,
  OrchestrationSection,
  RecoveryFallbacksSection,
} from "./settings-config-sections"
import { FieldRow, Section, SettingsInput, SettingsSelect, ToggleSwitch } from "./settings-fields"
import { SttSettingsSection } from "./stt-section"

type FeedbackState = {
  type: "success" | "error"
  message: string
} | null

export default function SettingsPage() {
  useBreadcrumbs([{ label: "Settings" }])
  const {
    settings,
    setAccentColor,
    setPortalName,
    setPortalSubtitle,
    setOperatorName,
    setPortalEmoji,
    setLanguage,
    setNavOrder,
    resetAll,
  } = useSettings()
  const { theme, setTheme } = useTheme()
  const auth = useAuth()

  const [nameValue, setNameValue] = useState(settings.portalName ?? "")
  const [subtitleValue, setSubtitleValue] = useState(settings.portalSubtitle ?? "")
  const [operatorNameValue, setOperatorNameValue] = useState(settings.operatorName ?? "")
  const [emojiValue, setEmojiValue] = useState(settings.portalEmoji ?? "")
  const [languageValue, setLanguageValue] = useState(settings.language ?? "English")
  const [customHex, setCustomHex] = useState(settings.accentColor ?? "")
  const [showCooEmojiPicker, setShowCooEmojiPicker] = useState(false)

  const { data: modelRegistry } = useModelRegistry()
  const modelOptions = (engine: string, fallback: Array<{ value: string; label: string }>) => {
    const models = modelRegistry?.engines?.[engine]?.models ?? []
    return models.length ? models.map((m) => ({ value: m.id, label: m.label })) : fallback
  }
  const effortOptions = (engine: string, fallback: Array<{ value: string; label: string }>) => {
    const levels = Array.from(new Set((modelRegistry?.engines?.[engine]?.models ?? []).flatMap((m) => m.effortLevels)))
    return levels.length
      ? [{ value: "default", label: "Default" }, ...levels.map((l) => ({ value: l, label: l.charAt(0).toUpperCase() + l.slice(1) }))]
      : fallback
  }

  const [config, setConfig] = useState<Config>({})
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>(null)
  const [waQr, setWaQr] = useState<string | null>(null)
  const [waStatus, setWaStatus] = useState("unknown")
  const [employees, setEmployees] = useState<Array<{ name: string; displayName: string }>>([])

  useEffect(() => {
    api.getOrg().then((org: any) => {
      if (org?.employees) {
        setEmployees(org.employees.map((e: any) => (
          typeof e === "string"
            ? { name: e, displayName: e }
            : { name: e.name, displayName: e.displayName || e.name }
        )))
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    setNameValue(settings.portalName ?? "")
    setSubtitleValue(settings.portalSubtitle ?? "")
    setOperatorNameValue(settings.operatorName ?? "")
    setEmojiValue(settings.portalEmoji ?? "")
    setLanguageValue(settings.language ?? "English")
    setCustomHex(settings.accentColor ?? "")
  }, [
    settings.portalName,
    settings.portalSubtitle,
    settings.operatorName,
    settings.portalEmoji,
    settings.language,
    settings.accentColor,
  ])

  function loadConfig() {
    setConfigLoading(true)
    api.getConfig()
      .then((data) => {
        setConfig(data as Config)
        setConfigError(null)
      })
      .catch((err) => setConfigError(err.message))
      .finally(() => setConfigLoading(false))
  }

  useEffect(() => {
    loadConfig()
  }, [])

  useEffect(() => {
    if (!config.connectors?.whatsapp) return

    let cancelled = false

    async function checkQr() {
      try {
        const statusRes = await fetch("/api/status")
        const status = await statusRes.json()
        const connStatus = status?.connectors?.whatsapp?.status
        if (!cancelled) setWaStatus(connStatus ?? "unknown")

        if (connStatus === "qr_pending") {
          const qrRes = await fetch("/api/connectors/whatsapp/qr")
          const data = await qrRes.json()
          if (!cancelled) setWaQr(data.qr)
        } else if (!cancelled) {
          setWaQr(null)
        }
      } catch {
        // non-fatal
      }
    }

    void checkQr()
    const interval = setInterval(() => {
      void checkQr()
    }, 10000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [config.connectors?.whatsapp])

  function updateConfig(path: string[], value: unknown) {
    setConfig((prev) => {
      const next = structuredClone(prev)
      let obj: Record<string, unknown> = next as Record<string, unknown>
      for (let i = 0; i < path.length - 1; i++) {
        if (!obj[path[i]] || typeof obj[path[i]] !== "object") {
          obj[path[i]] = {}
        }
        obj = obj[path[i]] as Record<string, unknown>
      }
      obj[path[path.length - 1]] = value
      return next
    })
  }

  function updateNumberConfig(path: string[], value: string) {
    const trimmed = value.trim()
    updateConfig(path, trimmed ? Number(trimmed) : undefined)
  }

  function handleSave() {
    setSaving(true)
    setFeedback(null)
    api.updateConfig(config as Record<string, unknown>)
      .then(() => setFeedback({ type: "success", message: "Settings saved successfully" }))
      .catch((err) => {
        setFeedback({
          type: "error",
          message: `Failed to save: ${err.message}`,
        })
      })
      .finally(() => setSaving(false))
  }

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto bg-[var(--bg)]">
        <div className="max-w-[640px] mx-auto px-[var(--space-4)] py-[var(--space-6)] pb-[var(--space-12)]">
          <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-6)]">
            Settings
          </h1>

          <AppearanceSection
            accentColor={settings.accentColor}
            customHex={customHex}
            setAccentColor={setAccentColor}
            setCustomHex={setCustomHex}
            theme={theme}
            setTheme={setTheme}
          />
          <CooEmojiSection
            operatorName={settings.operatorName}
            portalEmoji={settings.portalEmoji}
            showEmojiPicker={showCooEmojiPicker}
            setPortalEmoji={setPortalEmoji}
            setShowEmojiPicker={setShowCooEmojiPicker}
          />
          <BrandingSection
            emojiValue={emojiValue}
            languageValue={languageValue}
            nameValue={nameValue}
            operatorNameValue={operatorNameValue}
            setEmojiValue={setEmojiValue}
            setLanguage={setLanguage}
            setLanguageValue={setLanguageValue}
            setNameValue={setNameValue}
            setOperatorName={setOperatorName}
            setOperatorNameValue={setOperatorNameValue}
            setPortalEmoji={setPortalEmoji}
            setPortalName={setPortalName}
            setPortalSubtitle={setPortalSubtitle}
            setSubtitleValue={setSubtitleValue}
            subtitleValue={subtitleValue}
          />
          <PairingSection
            authState={auth.authState}
            createPairingCode={auth.createPairingCode}
            devices={auth.devices}
            logout={auth.logout}
            unpairDevice={auth.unpairDevice}
          />

          <ConfigFeedback feedback={feedback} />
          <ConfigLoadState configError={configError} configLoading={configLoading} />

          {!configLoading && !configError && (
            <>
              <GatewayWorkspacesSection
                config={config}
                updateConfig={updateConfig}
                updateNumberConfig={updateNumberConfig}
              />
              <EmailSettingsSection
                config={config}
                updateConfig={updateConfig}
                updateNumberConfig={updateNumberConfig}
              />
              <EngineConfigurationSection
                config={config}
                effortOptions={effortOptions}
                modelOptions={modelOptions}
                updateConfig={updateConfig}
                updateNumberConfig={updateNumberConfig}
              />
              <RecoveryFallbacksSection
                config={config}
                updateConfig={updateConfig}
                updateNumberConfig={updateNumberConfig}
              />
              <BoardWorkerSection
                config={config}
                updateConfig={updateConfig}
                updateNumberConfig={updateNumberConfig}
              />
              <OrchestrationSection
                config={config}
                updateConfig={updateConfig}
                updateNumberConfig={updateNumberConfig}
              />
              <SettingsConnectorsSection
                config={config}
                updateConfig={updateConfig}
                waQr={waQr}
                waStatus={waStatus}
                employees={employees}
                Section={Section}
                FieldRow={FieldRow}
                SettingsInput={SettingsInput}
                SettingsSelect={SettingsSelect}
                ToggleSwitch={ToggleSwitch}
              />
              <CronSection
                config={config}
                updateConfig={updateConfig}
                updateNumberConfig={updateNumberConfig}
              />
              <LoggingSection
                config={config}
                updateConfig={updateConfig}
                updateNumberConfig={updateNumberConfig}
              />
              <SttSettingsSection />
              <ConfigActions
                loadConfig={loadConfig}
                saving={saving}
                onSave={handleSave}
              />
            </>
          )}

          <ResetSection
            resetAll={resetAll}
            navOrderCustomized={settings.navOrder.length > 0}
            resetNavOrder={() => setNavOrder([])}
          />
        </div>
      </div>
    </PageLayout>
  )
}
