import { test, expect } from '@playwright/test'

// Drives the REAL built app: drag a nav-rail icon and confirm it reorders and
// the order survives a reload. Native HTML5 drag must be fired via dispatchEvent
// with a shared DataTransfer — Playwright's dragTo() does NOT fire native drag
// events. Target the running gateway (NAV_E2E_URL overrides; default :8888).
const BASE = process.env.NAV_E2E_URL ?? 'http://localhost:8888'

function railLabels(page: import('@playwright/test').Page) {
  return page.$$eval('nav[aria-label="Primary"] a[aria-label]', (els) =>
    els.map((el) => el.getAttribute('aria-label')),
  )
}

test('nav rail icon reorders via native drag-and-drop and persists across reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }) // ≥ lg so the rail renders
  await page.goto(BASE)
  await page.waitForSelector('nav[aria-label="Primary"] a[aria-label="Settings"]', { timeout: 15_000 })

  const before = await railLabels(page)
  expect(before.indexOf('Settings')).toBeGreaterThan(before.indexOf('Organization'))

  // Fire dragstart on Settings, dragover (top half → insert before) + drop on
  // Organization, all sharing one DataTransfer in the page context.
  await page.evaluate(() => {
    const q = (label: string) =>
      document.querySelector(`nav[aria-label="Primary"] a[aria-label="${label}"]`) as HTMLElement
    const settings = q('Settings')
    const org = q('Organization')
    const dt = new DataTransfer()
    const fire = (el: HTMLElement, type: string, clientY: number) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, clientY })
      Object.defineProperty(ev, 'dataTransfer', { value: dt })
      el.dispatchEvent(ev)
    }
    const rect = org.getBoundingClientRect()
    fire(settings, 'dragstart', 0)
    fire(org, 'dragover', rect.top + 2) // top half → insert before Organization
    fire(org, 'drop', rect.top + 2)
  })

  await expect.poll(async () => {
    const labels = await railLabels(page)
    return labels.indexOf('Settings') < labels.indexOf('Organization')
  }).toBe(true)

  // Reload — the custom order is read back from localStorage.
  await page.reload()
  await page.waitForSelector('nav[aria-label="Primary"] a[aria-label="Settings"]')
  const after = await railLabels(page)
  expect(after.indexOf('Settings')).toBeLessThan(after.indexOf('Organization'))
})
