import { describe, expect, it } from 'vitest'

import { browserOpFromTool, clampRatio, dropSurface, setSide, showSurface, toUrl, type StageLayout } from './browser.ts'

describe('browser addresses', () => {
  it('opens web addresses, searches words, refuses other schemes', () => {
    expect(toUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(toUrl('en.wikipedia.org')).toBe('https://en.wikipedia.org')
    expect(toUrl('daraz.pk/deals')).toBe('https://daraz.pk/deals')
    expect(toUrl('Gujranwala weather today')).toBe('https://www.google.com/search?q=Gujranwala%20weather%20today')
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
