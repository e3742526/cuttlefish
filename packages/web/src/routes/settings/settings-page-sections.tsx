import { Check, RotateCcw, Trash2 } from "lucide-react"
import { EmojiPicker } from "@/components/ui/emoji-picker"
import { RemoteAccessPanel } from "@/components/auth/remote-access-panel"
import { THEMES } from "@/lib/themes"
import type { ThemeId } from "@/lib/themes"
import { api } from "@/lib/api"
import type { AuthState, PairedDevice, PairingCode } from "@/lib/auth"
import { ACCENT_PRESETS } from "./settings-constants"
import { Section } from "./settings-fields"
import { DEFAULT_PORTAL_ICON } from "@/lib/settings"

const LANGUAGE_OPTIONS = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Russian",
  "Chinese",
  "Japanese",
  "Korean",
  "Arabic",
  "Hindi",
  "Bulgarian",
]

interface AppearanceSectionProps {
  accentColor: string | null | undefined
  customHex: string
  setAccentColor: (value: string | null) => void
  setCustomHex: (value: string) => void
  theme: ThemeId
  setTheme: (theme: ThemeId) => void
}

export function AppearanceSection({
  accentColor,
  customHex,
  setAccentColor,
  setCustomHex,
  theme,
  setTheme,
}: AppearanceSectionProps) {
  return (
    <Section title="Appearance">
      <div className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] mb-[var(--space-2)]">
        Theme
      </div>
      <div className="grid grid-cols-3 gap-[var(--space-2)] mb-[var(--space-4)]">
        {THEMES.map((t) => {
          const isActive = theme === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className="flex flex-col items-center gap-[var(--space-1)] px-[var(--space-2)] py-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] cursor-pointer transition-all duration-150 ease-[var(--ease-smooth)]"
              style={{
                border: isActive
                  ? "2px solid var(--accent)"
                  : "2px solid var(--separator)",
              }}
            >
              <span className="text-[24px]">{t.emoji}</span>
              <span
                className="text-[length:var(--text-caption2)]"
                style={{
                  fontWeight: isActive
                    ? "var(--weight-semibold)"
                    : "var(--weight-medium)",
                  color: isActive
                    ? "var(--accent)"
                    : "var(--text-secondary)",
                }}
              >
                {t.label}
              </span>
            </button>
          )
        })}
      </div>

      <div className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] mb-[var(--space-2)]">
        Accent Color
      </div>
      <div className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-3)]">
        {ACCENT_PRESETS.map((preset) => {
          const isActive = accentColor === preset.value
          return (
            <button
              key={preset.value}
              onClick={() => setAccentColor(preset.value)}
              aria-label={preset.label}
              title={preset.label}
              className="w-[32px] h-[32px] rounded-full cursor-pointer transition-all duration-100 ease-[var(--ease-smooth)] flex items-center justify-center"
              style={{
                background: preset.value,
                border: isActive
                  ? "2px solid var(--text-primary)"
                  : "2px solid transparent",
                outline: isActive
                  ? `2px solid ${preset.value}`
                  : "none",
                outlineOffset: 2,
              }}
            >
              {isActive && <Check size={14} color="#fff" strokeWidth={3} />}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-[var(--space-3)]">
        <label className="flex items-center gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] cursor-pointer">
          Custom:
          <input
            type="color"
            value={accentColor ?? "#3B82F6"}
            onChange={(e) => setAccentColor(e.target.value)}
            className="w-[28px] h-[28px] border-none rounded-full cursor-pointer bg-transparent p-0"
          />
        </label>
        <input
          type="text"
          placeholder="#3B82F6"
          value={customHex}
          onChange={(e) => {
            setCustomHex(e.target.value)
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
              setAccentColor(e.target.value)
            }
          }}
          className="apple-input w-[90px] px-[8px] py-[4px] text-[length:var(--text-caption1)] bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] text-[var(--text-primary)] font-mono"
        />
        {accentColor && (
          <button
            onClick={() => setAccentColor(null)}
            className="text-[length:var(--text-footnote)] text-[var(--system-blue)] bg-none border-none cursor-pointer p-0 inline-flex items-center gap-[4px]"
          >
            <RotateCcw size={12} />
            Reset
          </button>
        )}
      </div>
    </Section>
  )
}

interface CooEmojiSectionProps {
  operatorName: string | null | undefined
  portalEmoji: string | null | undefined
  showEmojiPicker: boolean
  setPortalEmoji: (value: string | null) => void
  setShowEmojiPicker: (value: boolean) => void
}

export function CooEmojiSection({
  operatorName,
  portalEmoji,
  showEmojiPicker,
  setPortalEmoji,
  setShowEmojiPicker,
}: CooEmojiSectionProps) {
  return (
    <Section title="COO Emoji">
      <div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
          Choose an emoji for the COO shown in the sidebar.
        </div>
        <div className="relative flex items-center gap-[var(--space-4)]">
          <button
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="text-4xl cursor-pointer bg-transparent border-none p-0"
          >
            {portalEmoji ? (
              portalEmoji
            ) : (
              <img src={DEFAULT_PORTAL_ICON} alt="" className="size-10 object-contain" draggable={false} />
            )}
          </button>
          <div>
            <div className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {operatorName || "Jimbo"}
            </div>
            <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              Click emoji to change
            </div>
          </div>
          {showEmojiPicker && (
            <EmojiPicker
              current={portalEmoji ?? ""}
              onSelect={(emoji) => {
                setPortalEmoji(emoji)
                setShowEmojiPicker(false)
              }}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}
        </div>
      </div>
    </Section>
  )
}

interface BrandingSectionProps {
  emojiValue: string
  languageValue: string
  nameValue: string
  operatorNameValue: string
  setEmojiValue: (value: string) => void
  setLanguage: (value: string) => void
  setLanguageValue: (value: string) => void
  setNameValue: (value: string) => void
  setOperatorName: (value: string | null) => void
  setOperatorNameValue: (value: string) => void
  setPortalEmoji: (value: string | null) => void
  setPortalName: (value: string | null) => void
  setPortalSubtitle: (value: string | null) => void
  setSubtitleValue: (value: string) => void
  subtitleValue: string
}

export function BrandingSection({
  emojiValue,
  languageValue,
  nameValue,
  operatorNameValue,
  setEmojiValue,
  setLanguage,
  setLanguageValue,
  setNameValue,
  setOperatorName,
  setOperatorNameValue,
  setPortalEmoji,
  setPortalName,
  setPortalSubtitle,
  setSubtitleValue,
  subtitleValue,
}: BrandingSectionProps) {
  return (
    <Section title="Branding">
      <div className="flex flex-col gap-[var(--space-3)]">
        <div>
          <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
            Portal Name
          </label>
          <input
            type="text"
            className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
            placeholder="Cuttlefish"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={() => {
              setPortalName(nameValue || null)
              api.completeOnboarding({ portalName: nameValue || undefined }).catch(() => {})
            }}
          />
        </div>

        <div>
          <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
            Portal Subtitle
          </label>
          <input
            type="text"
            className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
            placeholder="Command Centre"
            value={subtitleValue}
            onChange={(e) => setSubtitleValue(e.target.value)}
            onBlur={() => setPortalSubtitle(subtitleValue || null)}
          />
        </div>

        <div>
          <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
            Operator Name
          </label>
          <input
            type="text"
            className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
            placeholder="Your Name"
            value={operatorNameValue}
            onChange={(e) => setOperatorNameValue(e.target.value)}
            onBlur={() => {
              setOperatorName(operatorNameValue || null)
              api.completeOnboarding({ operatorName: operatorNameValue || undefined }).catch(() => {})
            }}
          />
        </div>

        <div>
          <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
            Portal Emoji
          </label>
          <input
            type="text"
            className="apple-input w-[80px] text-center text-[length:var(--text-title2)] px-[8px] py-[6px] bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)]"
            placeholder="Optional"
            value={emojiValue}
            onChange={(e) => setEmojiValue(e.target.value)}
            onBlur={() => setPortalEmoji(emojiValue || null)}
          />
        </div>

        <div>
          <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
            Language
          </label>
          <select
            value={languageValue}
            onChange={(e) => setLanguageValue(e.target.value)}
            onBlur={() => {
              setLanguage(languageValue || "English")
              api.completeOnboarding({ language: languageValue || undefined }).catch(() => {})
            }}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)] cursor-pointer"
          >
            {LANGUAGE_OPTIONS.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Section>
  )
}

interface PairingSectionProps {
  authState: Partial<AuthState> | null
  createPairingCode: () => Promise<PairingCode>
  devices: PairedDevice[]
  logout: () => Promise<void>
  unpairDevice: (deviceId: string) => Promise<void>
}

export function PairingSection(props: PairingSectionProps) {
  return (
    <Section title="Pairing">
      <RemoteAccessPanel
        authState={props.authState}
        devices={props.devices}
        onCreatePairingCode={props.createPairingCode}
        onLogout={props.logout}
        onUnpairDevice={props.unpairDevice}
      />
    </Section>
  )
}

interface ResetSectionProps {
  resetAll: () => void
  navOrderCustomized?: boolean
  resetNavOrder?: () => void
}

export function ResetSection({ resetAll, navOrderCustomized, resetNavOrder }: ResetSectionProps) {
  return (
    <Section title="Reset">
      <div className="flex items-center justify-center gap-[var(--space-3)] flex-wrap">
        {navOrderCustomized && resetNavOrder && (
          <button
            onClick={resetNavOrder}
            className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--separator)] cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-all duration-150 ease-[var(--ease-spring)] inline-flex items-center gap-[var(--space-2)]"
          >
            <RotateCcw size={14} />
            Reset Nav Order
          </button>
        )}
        <button
          onClick={() => {
            localStorage.removeItem("cuttlefish-onboarded")
            window.location.reload()
          }}
          className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-all duration-150 ease-[var(--ease-spring)] inline-flex items-center gap-[var(--space-2)]"
        >
          <RotateCcw size={14} />
          Re-run Onboarding Wizard
        </button>
        <button
          onClick={() => {
            if (window.confirm("Reset all settings to defaults?")) {
              localStorage.removeItem("cuttlefish-settings")
              localStorage.removeItem("cuttlefish-theme")
              resetAll()
              window.location.reload()
            }
          }}
          className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--system-red)] text-white border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-all duration-150 ease-[var(--ease-spring)] inline-flex items-center gap-[var(--space-2)]"
        >
          <Trash2 size={14} />
          Reset All Settings
        </button>
      </div>
    </Section>
  )
}
