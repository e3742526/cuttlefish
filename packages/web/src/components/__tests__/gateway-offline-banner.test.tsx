import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { GatewayOfflineBanner } from "../gateway-offline-banner"

const disconnectedMock = vi.fn<() => boolean>(() => false)

vi.mock("@/hooks/use-connection-status", () => ({
  useDisconnected: () => disconnectedMock(),
}))

describe("GatewayOfflineBanner", () => {
  it("renders nothing while connected", () => {
    disconnectedMock.mockReturnValue(false)
    render(<GatewayOfflineBanner />)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("renders a persistent alert when disconnected", () => {
    disconnectedMock.mockReturnValue(true)
    render(<GatewayOfflineBanner />)
    expect(screen.getByRole("alert").textContent).toContain("Can't reach the Cuttlefish gateway")
  })
})
