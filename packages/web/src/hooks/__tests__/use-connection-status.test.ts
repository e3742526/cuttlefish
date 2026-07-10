import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useDisconnected } from "../use-connection-status"

const gatewayState = { connected: true }

vi.mock("../use-gateway", () => ({
  useGateway: () => gatewayState,
}))

describe("useDisconnected", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    gatewayState.connected = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("is false while connected", () => {
    const { result } = renderHook(() => useDisconnected())
    expect(result.current).toBe(false)
  })

  it("stays false during the grace period after disconnecting", () => {
    gatewayState.connected = false
    const { result, rerender } = renderHook(() => useDisconnected(1500))
    rerender()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(false)
  })

  it("flips true once disconnected past the grace period", () => {
    gatewayState.connected = false
    const { result, rerender } = renderHook(() => useDisconnected(1500))
    rerender()
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(result.current).toBe(true)
  })

  it("resets to false immediately once reconnected", () => {
    gatewayState.connected = false
    const { result, rerender } = renderHook(() => useDisconnected(1500))
    rerender()
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(result.current).toBe(true)

    gatewayState.connected = true
    rerender()
    expect(result.current).toBe(false)
  })

  it("respects a custom grace period", () => {
    gatewayState.connected = false
    const { result, rerender } = renderHook(() => useDisconnected(500))
    rerender()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current).toBe(true)
  })
})
