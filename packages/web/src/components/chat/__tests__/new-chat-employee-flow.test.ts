import { describe, it, expect } from 'vitest'

/**
 * Tests the logic for building session creation params based on employee selection.
 * This is the pure function extracted from ChatPane's handleSend.
 */
import { buildNewSessionParams, resolveNewSessionSelector, shouldPersistNewSessionSelector } from '../new-chat-helpers'

describe('buildNewSessionParams', () => {
  it('creates session without employee field when COO is selected (null)', () => {
    const params = buildNewSessionParams({
      message: 'Hello',
      selectedEmployee: null,
    })
    expect(params).toEqual({
      source: 'web',
      prompt: 'Hello',
    })
    expect(params).not.toHaveProperty('employee')
  })

  it('includes employee field when an employee is selected', () => {
    const params = buildNewSessionParams({
      message: 'Fix the bug',
      selectedEmployee: 'lead-developer',
    })
    expect(params).toEqual({
      source: 'web',
      prompt: 'Fix the bug',
      employee: 'lead-developer',
    })
  })

  it('includes attachments when provided', () => {
    const params = buildNewSessionParams({
      message: 'Check this',
      selectedEmployee: 'content-lead',
      attachmentIds: ['file-1', 'file-2'],
    })
    expect(params).toEqual({
      source: 'web',
      prompt: 'Check this',
      employee: 'content-lead',
      attachments: ['file-1', 'file-2'],
    })
  })

  it('does not include attachments key when none provided', () => {
    const params = buildNewSessionParams({
      message: 'Hello',
      selectedEmployee: null,
    })
    expect(params).not.toHaveProperty('attachments')
  })

  it('includes engine/model/effortLevel when provided (new-chat selector)', () => {
    const params = buildNewSessionParams({
      message: 'hi',
      selectedEmployee: null,
      engine: 'codex',
      model: 'gpt-5.5',
      effortLevel: 'xhigh',
    })
    expect(params).toMatchObject({ engine: 'codex', model: 'gpt-5.5', effortLevel: 'xhigh' })
  })

  it('includes workspaceProfile when a product workspace is selected', () => {
    const params = buildNewSessionParams({
      message: 'ship it',
      selectedEmployee: 'platform-lead',
      workspaceProfile: 'billing',
    })
    expect(params).toMatchObject({ workspaceProfile: 'billing', employee: 'platform-lead' })
  })

  it('omits engine/model/effortLevel keys when not provided', () => {
    const params = buildNewSessionParams({ message: 'hi', selectedEmployee: null })
    expect(params).not.toHaveProperty('engine')
    expect(params).not.toHaveProperty('model')
    expect(params).not.toHaveProperty('effortLevel')
  })

  it('uses current selectedEmployee value, not stale initial value', () => {
    // Simulates the scenario where user first sees null (COO default),
    // then selects an employee before sending. The params must reflect
    // the CURRENT selection, not the initial null.
    const initial = buildNewSessionParams({
      message: 'Hello',
      selectedEmployee: null,
    })
    expect(initial).not.toHaveProperty('employee')

    // User selects lead-developer, then sends
    const afterSelection = buildNewSessionParams({
      message: 'Hello',
      selectedEmployee: 'lead-developer',
    })
    expect(afterSelection.employee).toBe('lead-developer')

    // User switches to content-lead, then sends
    const afterSwitch = buildNewSessionParams({
      message: 'Hello',
      selectedEmployee: 'content-lead',
    })
    expect(afterSwitch.employee).toBe('content-lead')
  })
})

describe('resolveNewSessionSelector', () => {
  it('uses selected employee engine, model, and effort defaults when the selector has not been manually changed', () => {
    const selector = resolveNewSessionSelector({
      selectedEmployee: {
        name: 'research-lead',
        engine: 'grok',
        model: 'grok-build',
        effortLevel: 'xhigh',
      },
      storedSelector: { engine: 'claude', model: 'opus', effortLevel: 'medium' },
      currentSelector: { engine: 'claude', model: 'opus', effortLevel: 'medium' },
      manuallyChanged: false,
    })

    expect(selector).toEqual({
      engine: 'grok',
      model: 'grok-build',
      effortLevel: 'xhigh',
    })
  })

  it('preserves the operator-selected engine, model, and effort after choosing an employee', () => {
    const selector = resolveNewSessionSelector({
      selectedEmployee: {
        name: 'writer',
        engine: 'claude',
        model: 'opus',
        effortLevel: 'high',
      },
      storedSelector: { engine: 'claude', model: 'opus', effortLevel: 'medium' },
      currentSelector: { engine: 'codex', model: 'gpt-5.5', effortLevel: 'xhigh' },
      manuallyChanged: true,
    })

    expect(selector).toEqual({
      engine: 'codex',
      model: 'gpt-5.5',
      effortLevel: 'xhigh',
    })
  })

  it('falls back to the stored selector for a direct COO chat', () => {
    expect(resolveNewSessionSelector({
      selectedEmployee: null,
      storedSelector: { engine: 'codex', model: 'gpt-5.5', effortLevel: 'high' },
      currentSelector: { engine: 'claude', model: 'opus' },
      manuallyChanged: false,
    })).toEqual({ engine: 'codex', model: 'gpt-5.5', effortLevel: 'high' })
  })
})

describe('shouldPersistNewSessionSelector', () => {
  it('persists direct-chat selectors and manual operator selections', () => {
    expect(shouldPersistNewSessionSelector({ selectedEmployee: null, manuallyChanged: false })).toBe(true)
    expect(shouldPersistNewSessionSelector({ selectedEmployee: 'writer', manuallyChanged: true })).toBe(true)
  })

  it('does not persist employee defaults as the next direct-chat selector', () => {
    expect(shouldPersistNewSessionSelector({ selectedEmployee: 'writer', manuallyChanged: false })).toBe(false)
  })
})
