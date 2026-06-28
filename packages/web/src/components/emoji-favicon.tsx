
import { useEffect } from "react"
import { useSettings } from "@/routes/settings-provider"
import { DEFAULT_PORTAL_ICON } from "@/lib/settings"

export function EmojiFavicon() {
  const { settings } = useSettings()
  const emoji = settings.portalEmoji

  useEffect(() => {
    const plainEmoji = emoji && !emoji.includes(":") ? emoji : null
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
    if (!link) {
      link = document.createElement("link")
      link.rel = "icon"
      document.head.appendChild(link)
    }

    if (!plainEmoji) {
      link.type = "image/svg+xml"
      link.href = DEFAULT_PORTAL_ICON
      return
    }

    const canvas = document.createElement("canvas")
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.font = "52px serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(plainEmoji, 32, 36)

    const url = canvas.toDataURL("image/png")
    link.type = "image/png"
    link.href = url
  }, [emoji])

  return null
}
