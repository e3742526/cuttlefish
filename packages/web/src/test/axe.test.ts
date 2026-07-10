import { describe, it, expect } from "vitest"
import { runAxe } from "./axe"

describe("axe-core jsdom smoke", () => {
  it("flags a real violation (image with no alt text)", async () => {
    document.body.innerHTML = '<img src="x.png" />'
    const violations = await runAxe(document.body)
    expect(violations.some((v) => v.id === "image-alt")).toBe(true)
  })

  it("passes clean markup", async () => {
    document.body.innerHTML = '<main aria-label="Test"><h1>Hello</h1></main>'
    const violations = await runAxe(document.body)
    expect(violations).toEqual([])
  })
})
