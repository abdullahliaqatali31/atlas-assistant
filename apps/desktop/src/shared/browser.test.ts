import { describe, expect, it } from 'vitest'

import { browserOpFromTool, clampRatio, dropSurface, orderTabs, parseTabAction, setSide, showSurface, tabsOpFromTool, toUrl, type BrowserTab, type StageLayout } from './browser.ts'

describe('browser addresses', () => {
  it('opens web addresses, searches words, refuses other schemes', () => {
    expect(toUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(toUrl('en.wikipedia.org')).toBe('https://en.wikipedia.org')
    expect(toUrl('daraz.pk/deals')).toBe('https://daraz.pk/deals')
    expect(toUrl('Multan weather today')).toBe('https://www.google.com/search?q=Multan%20weather%20today')
    expect(toUrl('javascript:alert(1)')).toBeNull()
    expect(toUrl('file:///C:/Windows')).toBeNull()
    expect(toUrl('   ')).toBeNull()
  })

  it('checks the tools’ input', () => {
    expect(browserOpFromTool('browser', { action: 'open', query: 'cricket score' })).toEqual({ kind: 'open', target: 'cricket score' })
    expect(browserOpFromTool('browser', { action: 'view', mode: 'mini' })).toEqual({ kind: 'view', mode: 'mini' })
    expect(typeof browserOpFromTool('browser', { action: 'click', n: 2 })).toBe('string')
    expect(browserOpFromTool('browser_act', { action: 'click', n: 3 })).toEqual({ kind: 'click', n: 3, text: undefined })
    expect(browserOpFromTool('browser_act', { action: 'type', n: 1, text: 'Lahore', enter: true })).toEqual({ kind: 'type', n: 1, text: 'Lahore', enter: true })
    expect(typeof browserOpFromTool('browser_act', { action: 'key', key: 'F5' })).toBe('string')
  })
})

describe('panes', () => {
  const one: StageLayout = { main: 'home', side: null, ratio: 0.5 }
  it('shows a surface where it is, or in the focused pane', () => {
    expect(showSurface(one, 'world')).toEqual({ ...one, main: 'world' })
    const two = setSide(one, 'world')
    expect(two).toEqual({ main: 'home', side: 'world', ratio: 0.5 })
    expect(showSurface(two, 'world')).toBe(two)
    expect(showSurface(two, 'browser', 'side')).toEqual({ ...two, side: 'browser' })
    expect(showSurface(two, 'browser', 'main')).toEqual({ ...two, main: 'browser' })
  })

  it('puts a surface beside, never twice, and takes it out again', () => {
    expect(setSide({ main: 'browser', side: null, ratio: 0.5 }, 'browser')).toEqual({ main: 'home', side: 'browser', ratio: 0.5 })
    expect(setSide({ main: 'home', side: 'world', ratio: 0.5 }, 'home')).toEqual({ main: 'world', side: 'home', ratio: 0.5 })
    expect(dropSurface({ main: 'home', side: 'browser', ratio: 0.5 }, 'browser')).toEqual({ main: 'home', side: null, ratio: 0.5 })
    expect(dropSurface({ main: 'browser', side: 'world', ratio: 0.5 }, 'browser')).toEqual({ main: 'world', side: null, ratio: 0.5 })
    expect(dropSurface({ main: 'browser', side: null, ratio: 0.5 }, 'browser').main).toBe('home')
    expect(clampRatio(0.9)).toBe(0.75)
    expect(clampRatio(Number.NaN)).toBe(0.5)
  })
})

describe('browser tabs', () => {
  const tab = (id: string, o: Partial<BrowserTab> = {}): BrowserTab => ({ id, url: 'https://a.com', title: id, pinned: false, group: null, byAtlas: false, opened: 0, lastUsed: 0, ...o })

  it('orders pinned first, then each group together, then the rest', () => {
    const tabs = [tab('t-one'), tab('t-two', { group: 'g-b' }), tab('t-three', { pinned: true }), tab('t-four', { group: 'g-a' }), tab('t-five', { group: 'g-b' })]
    expect(orderTabs({ tabs, groups: [], active: null }).map(t => t.id)).toEqual(['t-three', 't-two', 't-five', 't-four', 't-one'])
  })

  it('checks the tabs tool and the tab strip’s actions', () => {
    expect(tabsOpFromTool({ action: 'close', tabs: [2, 3, -1, 1.5] })).toEqual({ kind: 'close', ns: [2, 3] })
    expect(tabsOpFromTool({ action: 'switch', tab: 4 })).toEqual({ kind: 'switch', n: 4 })
    expect(tabsOpFromTool({ action: 'group', tabs: [1], group: ' Daily work ' })).toEqual({ kind: 'group', ns: [1], name: 'Daily work', color: undefined })
    expect(typeof tabsOpFromTool({ action: 'group', tabs: [1] })).toBe('string')
    expect(typeof tabsOpFromTool({ action: 'explode' })).toBe('string')
    expect(browserOpFromTool('browser', { action: 'open', url: 'x.com', new_tab: true })).toEqual({ kind: 'open', target: 'x.com', newTab: true })
    expect(parseTabAction({ kind: 'activate', id: 'tabc123' })).toEqual({ kind: 'activate', id: 'tabc123' })
    expect(parseTabAction({ kind: 'activate', id: '../../x' })).toBeNull()
    expect(parseTabAction({ kind: 'nope' })).toBeNull()
  })
})
