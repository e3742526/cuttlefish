import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MobileTabBar } from '../mobile-tab-bar'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MobileTabBar />
    </MemoryRouter>
  )
}

describe('MobileTabBar', () => {
  it('renders exactly 5 tabs with the curated labels', () => {
    renderAt('/')
    const tabs = screen.getAllByRole('link')
    expect(tabs).toHaveLength(5)
    for (const label of ['Chat', 'Command Center', 'Organization', 'Approvals', 'Settings']) {
      expect(screen.getByRole('link', { name: label })).toBeDefined()
    }
  })

  it('marks the Chat tab current on "/" and no other', () => {
    renderAt('/')
    expect(
      screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')
    ).toBe('page')
    for (const label of ['Command Center', 'Organization', 'Approvals', 'Settings']) {
      expect(
        screen.getByRole('link', { name: label }).getAttribute('aria-current')
      ).toBeNull()
    }
  })

  it('marks the Approvals tab current on "/approvals"', () => {
    renderAt('/approvals')
    expect(
      screen.getByRole('link', { name: 'Approvals' }).getAttribute('aria-current')
    ).toBe('page')
    expect(
      screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')
    ).toBeNull()
  })
})
