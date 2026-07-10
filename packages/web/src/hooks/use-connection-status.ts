import { useEffect, useState } from "react"
import { useGateway } from "./use-gateway"

const DEFAULT_GRACE_MS = 1500

/**
 * Debounced view of the gateway WebSocket's connection state: true only once
 * `connected` has been continuously false for `graceMs`. Raw `connected` is
 * false for a brief moment on every page load (before the initial handshake
 * completes) and can blip during ordinary network hiccups — without this
 * debounce, disconnected-state UI (StalePill, the app-level offline banner)
 * would flash on nearly every navigation instead of only on a real outage.
 */
export function useDisconnected(graceMs: number = DEFAULT_GRACE_MS): boolean {
  const { connected } = useGateway()
  const [disconnected, setDisconnected] = useState(false)

  useEffect(() => {
    if (connected) {
      setDisconnected(false)
      return
    }
    const id = window.setTimeout(() => setDisconnected(true), graceMs)
    return () => window.clearTimeout(id)
  }, [connected, graceMs])

  return disconnected
}
