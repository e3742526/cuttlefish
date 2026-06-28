import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CooEmojiSection } from "./settings-page-sections"

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: () => <div>picker</div>,
}))

describe("CooEmojiSection", () => {
  it("renders an avatar id as an image preview instead of literal text", () => {
    render(
      <CooEmojiSection
        operatorName="Eric"
        portalEmoji="aquatic:octopus"
        showEmojiPicker={false}
        setPortalEmoji={vi.fn()}
        setShowEmojiPicker={vi.fn()}
      />,
    )

    const img = screen.getByRole("img", { name: "Eric" })
    expect(img.getAttribute("src")).toBe("/avatars/aquatic/64/octopus.png")
    expect(screen.queryByText("aquatic:octopus")).toBeNull()
  })

  it("opens the picker from the avatar button without throwing", () => {
    const setShowEmojiPicker = vi.fn()
    render(
      <CooEmojiSection
        operatorName="Eric"
        portalEmoji="aquatic:octopus"
        showEmojiPicker={false}
        setPortalEmoji={vi.fn()}
        setShowEmojiPicker={setShowEmojiPicker}
      />,
    )

    fireEvent.click(screen.getByRole("button"))
    expect(setShowEmojiPicker).toHaveBeenCalledWith(true)
  })
})
