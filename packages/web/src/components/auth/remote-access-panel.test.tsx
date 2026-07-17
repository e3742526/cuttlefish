import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RemoteAccessPanel } from "./remote-access-panel"

describe("RemoteAccessPanel", () => {
  it("creates and displays a single-use pairing code", async () => {
    const onCreatePairingCode = vi.fn().mockResolvedValue({
      code: "ABCD-EFGH-JKLM",
      expiresAt: "2026-06-24T10:00:00.000Z",
    })
    render(
      <RemoteAccessPanel
        authState={{ authRequired: true, authenticated: true, canBootstrapLocal: true, networkExposed: true }}
        devices={[]}
        onCreatePairingCode={onCreatePairingCode}
        onLogout={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /create pairing code/i }))

    await waitFor(() => expect(onCreatePairingCode).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("ABCD-EFGH-JKLM")).toBeTruthy()
    expect(screen.getByText(/single-use/i)).toBeTruthy()
  })

  it("can forget the current browser", async () => {
    const onLogout = vi.fn().mockResolvedValue(undefined)
    render(
      <RemoteAccessPanel
        authState={{ authRequired: true, authenticated: true, canBootstrapLocal: false, networkExposed: false }}
        devices={[]}
        onCreatePairingCode={vi.fn()}
        onLogout={onLogout}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /forget this browser/i }))
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const button = screen.getByRole("button", { name: /forget this browser/i }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
  })

  it("disables pairing-code creation outside the paired local dashboard", () => {
    const onCreatePairingCode = vi.fn()
    render(
      <RemoteAccessPanel
        authState={{ authRequired: true, authenticated: true, canBootstrapLocal: false, networkExposed: true }}
        devices={[]}
        onCreatePairingCode={onCreatePairingCode}
        onLogout={() => {}}
      />,
    )

    const button = screen.getByRole("button", { name: /create pairing code/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText(/Create codes from the local Mac dashboard/i)).toBeTruthy()
  })

  it("shows paired browsers with the current browser marked", async () => {
    const onUnpairDevice = vi.fn().mockResolvedValue(undefined)
    render(
      <RemoteAccessPanel
        authState={{ authRequired: true, authenticated: true, canBootstrapLocal: false, networkExposed: true }}
        devices={[
          {
            id: "device-1",
            name: "This Mac",
            kind: "local",
            createdAt: "2026-06-24T10:00:00.000Z",
            lastSeenAt: "2026-06-24T10:10:00.000Z",
            current: true,
          },
          {
            id: "device-2",
            name: "iPhone browser",
            kind: "remote",
            createdAt: "2026-06-24T10:05:00.000Z",
            lastSeenAt: "2026-06-24T10:05:00.000Z",
            current: false,
          },
        ]}
        onCreatePairingCode={vi.fn()}
        onLogout={() => {}}
        onUnpairDevice={onUnpairDevice}
      />,
    )

    expect(screen.getByText(/Paired browsers/i)).toBeTruthy()
    expect(screen.getByText("This Mac")).toBeTruthy()
    expect(screen.getByText("iPhone browser")).toBeTruthy()
    expect(screen.getByText(/Current/i)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /unpair this mac/i })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /unpair iphone browser/i }))
    await waitFor(() => expect(onUnpairDevice).toHaveBeenCalledWith("device-2"))
    await waitFor(() => {
      const button = screen.getByRole("button", { name: /unpair iphone browser/i }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
  })
})
