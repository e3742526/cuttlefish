import { describe, it, expect } from 'vitest'
import {
  engineList,
  findModel,
  effortLevelsFor,
  defaultEffort,
  clampEffort,
} from '../use-model-registry'
import type { EnginesResponse } from '@/lib/api'

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
    codex: {
      name: 'codex', available: true, defaultModel: 'gpt-5.5', effortMechanism: 'codex-config',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh'] }],
    },
    antigravity: {
      name: 'antigravity', available: true, defaultModel: 'gemini-3-flash-preview', effortMechanism: 'none',
      models: [{ id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', supportsEffort: false, effortLevels: [] }],
    },
  },
}

describe('engineList', () => {
  it('returns engine entries as an array', () => {
    expect(engineList(REG).map((e) => e.name).sort()).toEqual(['antigravity', 'claude', 'codex'])
  })
  it('handles undefined registry', () => {
    expect(engineList(undefined)).toEqual([])
  })
})

describe('findModel', () => {
  it('finds a model by id', () => {
    expect(findModel(REG, 'claude', 'claude-sonnet-5')?.label).toBe('Sonnet 5')
  })
  it('falls back to the engine default model when id is unknown/absent', () => {
    expect(findModel(REG, 'claude', undefined)?.id).toBe('opus')
    expect(findModel(REG, 'claude', 'nope')?.id).toBe('opus')
  })
})

describe('effortLevelsFor', () => {
  it('returns the model effort levels', () => {
    expect(effortLevelsFor(REG, 'codex', 'gpt-5.5')).toContain('xhigh')
  })
  it('returns [] for an effort-less model (antigravity)', () => {
    expect(effortLevelsFor(REG, 'antigravity', 'gemini-3-flash-preview')).toEqual([])
  })
})

describe('defaultEffort', () => {
  it('prefers medium', () => expect(defaultEffort(['low', 'medium', 'high'])).toBe('medium'))
  it('uses the first when no medium', () => expect(defaultEffort(['low', 'xhigh'])).toBe('low'))
  it('undefined for empty', () => expect(defaultEffort([])).toBeUndefined())
})

describe('clampEffort', () => {
  it('keeps a still-valid current level', () => expect(clampEffort(['low', 'medium', 'high'], 'high')).toBe('high'))
  it('replaces an invalid level with the default', () => expect(clampEffort(['low', 'medium', 'high'], 'xhigh')).toBe('medium'))
  it('undefined when the new model has no effort', () => expect(clampEffort([], 'high')).toBeUndefined())
})
