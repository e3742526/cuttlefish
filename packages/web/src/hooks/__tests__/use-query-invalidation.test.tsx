import React from "react"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/query-keys"

let gatewayListener: ((event: string, payload: unknown) => void) | undefined

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    subscribe: (listener: (event: string, payload: unknown) => void) => {
      gatewayListener = listener
      return () => { gatewayListener = undefined }
    },
  }),
}))

import { useQueryInvalidation } from "../use-query-invalidation"

afterEach(() => {
  vi.useRealTimers()
  gatewayListener = undefined
})

describe("useQueryInvalidation", () => {
  it("refreshes the session list when an agent notification arrives", async () => {
    vi.useFakeTimers()
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined)
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    renderHook(() => useQueryInvalidation(), { wrapper })

    act(() => gatewayListener?.("session:notification", { sessionId: "s-1", message: "Agent replied" }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.all })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.detail("s-1") })
  })
})
