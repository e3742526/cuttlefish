import { test, expect } from "@playwright/test"

test("Workers DataView restores a shareable view and opens the keyboard-accessible inspector", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/orchestration?tab=Workers&workersSearch=e2e-worker")

  await expect(page.getByRole("searchbox", { name: "Search workers" })).toHaveValue("e2e-worker")
  const workerRow = page.getByRole("row").filter({ hasText: "e2e-worker" }).first()
  await workerRow.press("Enter")

  const inspector = page.getByRole("complementary", { name: "Worker inspector" })
  await expect(inspector).toContainText("At capacity")
  await expect(inspector).toContainText("e2e-task")
  await expect(inspector).toContainText("e2e-coordinator · implementer")
  await expect(inspector).toContainText("Reserve review capacity")
  expect(new URL(page.url()).searchParams.get("worker")).toBe("e2e-worker")

  await page.getByRole("button", { name: "Close worker inspector" }).click()
  await expect(inspector).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get("worker")).toBeNull()
})

test("Workers DataView inspector remains keyboard-operable in the mobile card layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/orchestration?tab=Workers")

  const workerCard = page.getByRole("listitem").filter({ hasText: "e2e-worker" })
  await workerCard.press("Enter")

  const inspector = page.getByRole("complementary", { name: "Worker inspector" })
  await expect(inspector).toContainText("e2e-worker")
  await expect(inspector).toContainText("At capacity")
  expect(new URL(page.url()).searchParams.get("worker")).toBe("e2e-worker")
})
