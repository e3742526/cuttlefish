import { describe, it, expect } from 'vitest'
import { NAV_ITEMS, MOBILE_TAB_ITEMS, applyNavOrder } from '../nav'

describe('NAV_ITEMS', () => {
  it('includes Command Center and Orchestration in the Ops group', () => {
    const commandCenter = NAV_ITEMS.find((item) => item.href === '/command')
    const orchestration = NAV_ITEMS.find((item) => item.href === '/orchestration')
    expect(commandCenter).toMatchObject({ label: 'Command Center', group: 'ops' })
    expect(orchestration).toMatchObject({ label: 'Orchestration', group: 'ops' })
  })

  it('assigns every item to one of the three groups', () => {
    for (const item of NAV_ITEMS) {
      expect(['work', 'organization', 'ops']).toContain(item.group)
    }
  })
})

describe('MOBILE_TAB_ITEMS', () => {
  it('has exactly 5 curated entries', () => {
    expect(MOBILE_TAB_ITEMS).toHaveLength(5)
  })

  it('lists the curated hrefs in order', () => {
    expect(MOBILE_TAB_ITEMS.map((item) => item.href)).toEqual([
      '/',
      '/command',
      '/org',
      '/approvals',
      '/settings',
    ])
  })

  it('derives every entry from NAV_ITEMS (icons/labels stay in sync)', () => {
    for (const item of MOBILE_TAB_ITEMS) {
      expect(NAV_ITEMS).toContain(item)
    }
  })
})

describe('applyNavOrder', () => {
  const hrefs = (items: { href: string }[]) => items.map((i) => i.href)
  const def = hrefs(NAV_ITEMS)

  it('returns the default order unchanged for an empty order', () => {
    expect(hrefs(applyNavOrder([]))).toEqual(def)
  })

  it('reorders items by the given hrefs', () => {
    const order = ['/settings', '/org', '/'] // partial: move these to the front
    const result = hrefs(applyNavOrder(order))
    expect(result.slice(0, 3)).toEqual(['/settings', '/org', '/'])
    // every other item is still present, in default relative order, after them
    expect(new Set(result)).toEqual(new Set(def))
    expect(result).toHaveLength(def.length)
    const rest = result.slice(3)
    expect(rest).toEqual(def.filter((h) => !order.includes(h)))
  })

  it('appends an item missing from the order (a newly added route never disappears)', () => {
    // Order names every current href EXCEPT "/skills" → it must still appear, at the end.
    const order = def.filter((h) => h !== '/skills')
    const result = hrefs(applyNavOrder(order))
    expect(result).toContain('/skills')
    expect(result[result.length - 1]).toBe('/skills')
    expect(result).toHaveLength(def.length)
  })

  it('ignores hrefs in the order that no longer exist (a removed route cannot corrupt it)', () => {
    const result = hrefs(applyNavOrder(['/ghost-route', '/org']))
    expect(result).not.toContain('/ghost-route')
    expect(result[0]).toBe('/org')
    expect(result).toHaveLength(def.length)
  })

  it('does not mutate the input array or NAV_ITEMS', () => {
    const order = ['/org', '/']
    const snapshot = [...order]
    applyNavOrder(order)
    expect(order).toEqual(snapshot)
    expect(hrefs(NAV_ITEMS)).toEqual(def)
  })
})
