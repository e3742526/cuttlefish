import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useChatTabs, tabKey } from '../use-chat-tabs'

describe('useChatTabs', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })

  it('starts with no tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    expect(result.current.tabs).toHaveLength(0)
    expect(result.current.activeTab).toBeNull()
  })

  it('opens a tab and makes it active', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => {
      result.current.openTab({ sessionId: 's1', label: 'Test', status: 'idle', unread: false })
    })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeIndex).toBe(0)
  })

  it('does not duplicate existing tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    const tab = { sessionId: 's1', label: 'Test', status: 'idle' as const, unread: false }
    act(() => result.current.openTab(tab))
    act(() => result.current.openTab(tab))
    expect(result.current.tabs).toHaveLength(1)
  })

  it('preview tab replaces previous preview tab', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false }))
    act(() => result.current.openTab({ sessionId: 's2', label: 'B', status: 'idle', unread: false }))
    // s2 should have replaced s1 since both are unpinned (preview)
    expect(result.current.tabs).toHaveLength(1)
    expect(tabKey(result.current.tabs[0])).toBe('s2')
  })

  it('pinned tabs are not replaced by preview tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.openTab({ sessionId: 's2', label: 'B', status: 'idle', unread: false }))
    expect(result.current.tabs).toHaveLength(2)
    expect(tabKey(result.current.tabs[0])).toBe('s1')
    expect(tabKey(result.current.tabs[1])).toBe('s2')
  })

  it('closes a tab and adjusts active index', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.openTab({ sessionId: 's2', label: 'B', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.closeTab(0))
    expect(result.current.tabs).toHaveLength(1)
    expect(tabKey(result.current.tabs[0])).toBe('s2')
  })

  it('clears the active tab without dropping open tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.openTab({ sessionId: 's2', label: 'B', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.clearActiveTab())
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.activeTab).toBeNull()
    expect(result.current.activeIndex).toBe(-1)
  })

  it('removes the active tab cleanly when the last tab is closed', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false }))
    act(() => result.current.closeTab(0))
    expect(result.current.tabs).toHaveLength(0)
    expect(result.current.activeTab).toBeNull()
    expect(result.current.activeIndex).toBe(-1)
  })

  it('pinTab converts preview tab to pinned', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false }))
    expect(result.current.tabs[0].pinned).toBeFalsy()
    act(() => result.current.pinTab(0))
    expect(result.current.tabs[0].pinned).toBe(true)
  })

  it('moveTab reorders tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.openTab({ sessionId: 's2', label: 'B', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.openTab({ sessionId: 's3', label: 'C', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.moveTab(0, 2))
    expect(result.current.tabs.map(t => tabKey(t))).toEqual(['s2', 's3', 's1'])
  })

  it('migrates persisted child session tabs to one deduplicated project tab', async () => {
    localStorage.setItem('cuttlefish-chat-tabs', JSON.stringify({
      tabs: [
        { kind: 'session', sessionId: 'child-a', label: 'A', status: 'idle', unread: false, pinned: true },
        { kind: 'session', sessionId: 'child-b', label: 'B', status: 'idle', unread: false, pinned: true },
      ],
      activeIndex: 0,
    }))
    const { result } = renderHook(() => useChatTabs())
    await waitFor(() => expect(result.current.tabs).toHaveLength(2))
    act(() => result.current.reconcileTabs([
      { id: 'root', title: 'Project Alpha' },
      { id: 'child-a', parentSessionId: 'root' },
      { id: 'child-b', parentSessionId: 'root' },
    ]))
    expect(result.current.tabs).toEqual([expect.objectContaining({
      kind: 'project', rootSessionId: 'root', label: 'Project Alpha',
    })])
  })

  it('deduplicates explicitly opened project tabs by root identity', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openProjectTab({ rootSessionId: 'root', label: 'Project', status: 'idle', unread: false }))
    act(() => result.current.openProjectTab({ rootSessionId: 'root', label: 'Project', status: 'idle', unread: false }))
    expect(result.current.tabs).toHaveLength(1)
    expect(tabKey(result.current.tabs[0])).toBe('project:root')
  })
})

describe('useChatTabs — file tabs (openFileTab)', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })

  it('appends a pinned FileTab with the basename as label and focuses it', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openFileTab('docs/superpowers/specs/foo.md'))
    expect(result.current.tabs).toHaveLength(1)
    const t = result.current.tabs[0]
    expect(t).toMatchObject({
      kind: 'file',
      path: 'docs/superpowers/specs/foo.md',
      label: 'foo.md',   // basename only
      pinned: true,
    })
    expect(result.current.activeIndex).toBe(0)
    expect(result.current.activeTab).toBe(t)
  })

  it('opening the same path again focuses the existing tab without duplicating', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.openFileTab('docs/foo.md'))
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.activeIndex).toBe(1)
    // move focus away, then re-open the same path
    act(() => result.current.switchTab(0))
    expect(result.current.activeIndex).toBe(0)
    act(() => result.current.openFileTab('docs/foo.md'))
    expect(result.current.tabs).toHaveLength(2)  // no duplicate
    expect(result.current.activeIndex).toBe(1)   // focused the existing file tab
  })

  it('a file tab and a session tab with the same raw id string do not collide (file: prefix in tabKey)', () => {
    const { result } = renderHook(() => useChatTabs())
    // session whose id is literally the same string as a file path
    act(() => result.current.openTab({ sessionId: 'docs/foo.md', label: 'S', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.openFileTab('docs/foo.md'))
    expect(result.current.tabs).toHaveLength(2)  // not deduped against each other
    const keys = result.current.tabs.map(tabKey)
    expect(keys[0]).toBe('docs/foo.md')       // session → raw id
    expect(keys[1]).toBe('file:docs/foo.md')  // file → prefixed, distinct
    expect(new Set(keys).size).toBe(2)
  })

  it('updateTabStatus and reconcileTabs leave file tabs untouched', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false, pinned: true }))
    act(() => result.current.openFileTab('docs/foo.md'))

    // updateTabStatus only matches session tabs — a file path is never a sessionId
    act(() => result.current.updateTabStatus('docs/foo.md', { status: 'running' } as never))
    const fileTab = result.current.tabs.find(t => t.kind === 'file')!
    expect(fileTab).toMatchObject({ kind: 'file', path: 'docs/foo.md', label: 'foo.md' })
    expect('status' in fileTab).toBe(false)

    // reconcile against an authoritative session list with no file entry → the
    // session is kept (id present) and the file tab survives unchanged
    act(() => result.current.reconcileTabs([{ id: 's1', status: 'idle' }]))
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.tabs.some(t => t.kind === 'file' && t.path === 'docs/foo.md')).toBe(true)
  })
})
