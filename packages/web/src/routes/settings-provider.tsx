
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  type CuttlefishSettings,
  DEFAULTS,
  DEFAULT_PORTAL_ICON,
  loadSettings,
  saveSettings,
  hexToAccentFill,
  hexToContrastText,
} from '@/lib/settings'
import { api } from '@/lib/api'

interface SettingsContextValue {
  settings: CuttlefishSettings
  setAccentColor: (color: string | null) => void
  setPortalName: (name: string | null) => void
  setPortalSubtitle: (subtitle: string | null) => void
  setPortalEmoji: (emoji: string | null) => void
  setPortalIcon: (icon: string | null) => void
  setIconBgHidden: (hidden: boolean) => void
  setEmojiOnly: (emojiOnly: boolean) => void
  setOperatorName: (name: string | null) => void
  setLanguage: (language: string) => void
  setNavOrder: (order: string[]) => void
  resetAll: () => void
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: { ...DEFAULTS },
  setAccentColor: () => {},
  setPortalName: () => {},
  setPortalSubtitle: () => {},
  setPortalEmoji: () => {},
  setPortalIcon: () => {},
  setIconBgHidden: () => {},
  setEmojiOnly: () => {},
  setOperatorName: () => {},
  setLanguage: () => {},
  setNavOrder: () => {},
  resetAll: () => {},
})

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  // Initialize with defaults so server and client render the same HTML.
  // Hydrate from localStorage after mount to avoid hydration mismatch.
  const [settings, setSettings] = useState<CuttlefishSettings>({ ...DEFAULTS })

  // Hydrate from localStorage first, then always sync portalName/operatorName
  // from backend config (source of truth). This ensures the correct COO name
  // shows up even if localStorage has stale values from a previous onboarding.
  useEffect(() => {
    const local = loadSettings()
    setSettings(local)

    api.getOnboarding()
      .then((data) => {
        if (data.portalName || data.operatorName) {
          const merged = {
            ...local,
            ...(data.portalName && { portalName: data.portalName }),
            ...(data.operatorName && { operatorName: data.operatorName }),
          }
          setSettings(merged)
          saveSettings(merged)
        }
      })
      .catch(() => {
        // Best-effort — localStorage values are fine
      })
  }, [])

  // Apply accent color CSS variables when settings change
  useEffect(() => {
    const el = document.documentElement.style
    if (settings.accentColor) {
      el.setProperty('--accent', settings.accentColor)
      el.setProperty('--accent-fill', hexToAccentFill(settings.accentColor))
      el.setProperty('--accent-contrast', hexToContrastText(settings.accentColor))
    } else {
      el.removeProperty('--accent')
      el.removeProperty('--accent-fill')
      el.removeProperty('--accent-contrast')
    }
  }, [settings.accentColor])

  const update = useCallback((updater: (prev: CuttlefishSettings) => CuttlefishSettings) => {
    setSettings((prev) => {
      const next = updater(prev)
      saveSettings(next)
      return next
    })
  }, [])

  const setAccentColor = useCallback(
    (color: string | null) => {
      update((prev) => ({ ...prev, accentColor: color }))
    },
    [update],
  )

  const setPortalName = useCallback(
    (name: string | null) => {
      update((prev) => ({ ...prev, portalName: name || null }))
    },
    [update],
  )

  const setPortalSubtitle = useCallback(
    (subtitle: string | null) => {
      update((prev) => ({ ...prev, portalSubtitle: subtitle || null }))
    },
    [update],
  )

  const setPortalEmoji = useCallback(
    (emoji: string | null) => {
      update((prev) => ({ ...prev, portalEmoji: emoji || null }))
    },
    [update],
  )

  const setPortalIcon = useCallback(
    (icon: string | null) => {
      update((prev) => ({ ...prev, portalIcon: icon }))
    },
    [update],
  )

  const setIconBgHidden = useCallback(
    (hidden: boolean) => {
      update((prev) => ({ ...prev, iconBgHidden: hidden }))
    },
    [update],
  )

  const setEmojiOnly = useCallback(
    (emojiOnly: boolean) => {
      update((prev) => ({ ...prev, emojiOnly }))
    },
    [update],
  )

  const setOperatorName = useCallback(
    (name: string | null) => {
      update((prev) => ({ ...prev, operatorName: name || null }))
    },
    [update],
  )

  const setLanguage = useCallback(
    (language: string) => {
      update((prev) => ({ ...prev, language: language || "English" }))
    },
    [update],
  )

  const setNavOrder = useCallback(
    (order: string[]) => {
      update((prev) => ({ ...prev, navOrder: order }))
    },
    [update],
  )

  const resetAll = useCallback(() => {
    update(() => ({
      accentColor: null,
      portalName: null,
      portalSubtitle: null,
      portalEmoji: null,
      portalIcon: DEFAULT_PORTAL_ICON,
      iconBgHidden: false,
      emojiOnly: false,
      operatorName: null,
      language: "English",
      employeeOverrides: {},
      navOrder: [],
    }))
  }, [update])

  return (
    <SettingsContext.Provider
      value={{
        settings,
        setAccentColor,
        setPortalName,
        setPortalSubtitle,
        setPortalEmoji,
        setPortalIcon,
        setIconBgHidden,
        setEmojiOnly,
        setOperatorName,
        setLanguage,
        setNavOrder,
        resetAll,
      }}
    >
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)

/** Sets document.title from the portal name setting. One-time write per change —
 *  no MutationObserver (it raced with Next.js metadata / breadcrumb-context). */
export function DocumentTitle() {
  const { settings } = useSettings()

  useEffect(() => {
    const name = settings.portalName || 'Cuttlefish'
    const desired = `${name} - AI Gateway`
    if (document.title !== desired) {
      document.title = desired
    }
  }, [settings.portalName])

  return null
}
