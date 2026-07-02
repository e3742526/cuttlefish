import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { EnginesResponse } from '@/lib/api'

// ModelSelectorRow calls useQueryClient() (for refreshModels), so renders must
// be wrapped in a QueryClientProvider — otherwise the hook throws on mount.
function renderRow(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

// jsdom lacks several DOM APIs Radix (and the in-place panel transition) rely on.
// matchMedia → reduced-motion = true, so panels swap instantly (no rAF needed).
beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
})

const REG: EnginesResponse = {
  default: 'claude',
  engines: {
    claude: {
      name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag',
      models: [
        { id: 'opus', label: 'Opus 4.8', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
        { id: 'claude-sonnet-5', label: 'Sonnet 5', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
      ],
    },
    antigravity: {
      name: 'antigravity', available: true, defaultModel: 'gemini-3-flash-preview', effortMechanism: 'none',
      models: [{ id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', supportsEffort: false, effortLevels: [] }],
    },
    codex: {
      name: 'codex', available: true, defaultModel: 'gpt-5.5', effortMechanism: 'codex-config',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh'], contextWindow: 258400 }],
    },
  },
}

// Mock only the query hook; keep the real pure helpers.
vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: REG, isLoading: false }) }
})

import { ModelSelectorRow } from '../model-selector-row'
import type { SelectorValue } from '../model-selector-row'

/** Controlled harness so onChange propagates back into `value` (the real wiring). */
function Harness({
  initial,
  onChange,
  mode = 'new',
}: {
  initial: SelectorValue
  onChange?: (v: SelectorValue) => void
  mode?: 'new' | 'existing'
}) {
  const [val, setVal] = useState<SelectorValue>(initial)
  return (
    <ModelSelectorRow
      mode={mode}
      value={val}
      onChange={(v) => {
        setVal(v)
        onChange?.(v)
      }}
    />
  )
}

function openMenu() {
  const chip = screen.getByRole('button', { name: /model and effort/i })
  fireEvent.keyDown(chip, { key: 'Enter' })
}

describe('ModelSelectorRow chip', () => {
  it('renders a single chip trigger labelled with the model + effort', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={() => {}} />)
    const chip = screen.getByRole('button', { name: /model and effort/i })
    expect(chip).toBeTruthy()
    // Model label is always visible on the chip surface (effort is responsive).
    expect(screen.getByText('Opus 4.8')).toBeTruthy()
    expect(chip.getAttribute('aria-label')).toContain('Opus 4.8')
    expect(chip.getAttribute('aria-label')).toContain('High')
  })

  it('reflects the selected model on the chip', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'claude-sonnet-5', effortLevel: 'medium' }} onChange={() => {}} />)
    expect(screen.getByText('Sonnet 5')).toBeTruthy()
  })

  it('omits effort from the chip label for effort-less engines (antigravity)', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'antigravity', model: 'gemini-3-flash-preview' }} onChange={() => {}} />)
    const chip = screen.getByRole('button', { name: /model and effort/i })
    expect(chip.getAttribute('aria-label')).toBe('Model and effort: Gemini 3 Flash')
  })

  it('renders nothing extra (one trigger) — engine/model/effort all live in one dropdown', () => {
    renderRow(<ModelSelectorRow mode="existing" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />)
    // The old inline Engine/Model/Effort buttons are gone; just the chip remains.
    expect(screen.queryByRole('button', { name: 'Engine' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('ModelSelectorRow in-place engine panel', () => {
  it('"Switch engine…" transitions the SAME surface to the engine panel (no second menu)', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()

    // Main panel: model list is visible, engine "Back" control is not.
    expect(await screen.findByRole('menuitemradio', { name: /opus 4\.8/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^back$/i })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: /switch engine/i }))

    // Engine panel: every engine listed + a Back control — all within ONE menu.
    expect(await screen.findByRole('menuitem', { name: /^back$/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /antigravity/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /codex/i })).toBeTruthy()
    // Exactly one menu surface — proves it isn't a nested/second menu.
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    // The model radio list is no longer mounted while on the engine panel.
    expect(screen.queryByRole('menuitemradio', { name: /opus 4\.8/i })).toBeNull()
  })

  it('Back returns to the model/effort panel', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^back$/i }))

    // Back on the main panel: model list returns, engine list/Back gone.
    expect(await screen.findByRole('menuitemradio', { name: /opus 4\.8/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^back$/i })).toBeNull()
  })

  it('selecting an engine auto-returns to main, reflects the new engine models, and fires onChange', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={onChange} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /codex/i }))

    // onChange fired with the new engine + its default model (cascade preserved).
    expect(onChange).toHaveBeenCalledWith({ engine: 'codex', model: 'gpt-5.5', effortLevel: 'medium' })
    // Auto-returned to the main panel (Back gone) now showing codex's model
    // (the menu is modal while open, so the chip itself isn't queryable here).
    expect(await screen.findByRole('menuitemradio', { name: /gpt-5\.5/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^back$/i })).toBeNull()
  })

  it('effort selection callback still fires (engine/model preserved)', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={onChange} />)
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'low' }))
    expect(onChange).toHaveBeenCalledWith({ engine: 'claude', model: 'opus', effortLevel: 'low' })
  })

  it('model selection callback still fires (effort clamped to a valid level)', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={onChange} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /sonnet 5/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ engine: 'claude', model: 'claude-sonnet-5' }))
  })

  it('existing-chat keeps the engine locked (no Switch engine affordance)', async () => {
    const onNewChat = vi.fn()
    renderRow(
      <ModelSelectorRow
        mode="existing"
        value={{ engine: 'claude', model: 'opus', effortLevel: 'high' }}
        onChange={() => {}}
        onNewChat={onNewChat}
      />,
    )
    openMenu()
    // No engine panel entry; instead the locked "start a new chat" affordance.
    expect(screen.queryByRole('menuitem', { name: /^switch engine/i })).toBeNull()
    expect(await screen.findByRole('menuitem', { name: /start a new chat to switch engine/i })).toBeTruthy()
  })
})
