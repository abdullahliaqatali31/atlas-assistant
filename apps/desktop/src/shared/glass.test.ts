import { describe, expect, it } from 'vitest'

import { describeGlass, panelBounds, parseGlassShow, pickNews, pickStory } from './glass.ts'
import type { Headline } from './news.ts'

const h = (id: string, title: string, category: Headline['category'], at: number): Headline => ({ id, title, link: `https://example.com/${id}`, source: 'Dawn', category, publishedAt: at, summary: `${title} summary`, image: null })
const ALL = [h('a', 'Floods in Sindh displace thousands', 'pakistan', 3), h('b', 'Markets rally on rate cut', 'business', 5), h('c', 'New metro line opens in Lahore', 'pakistan', 4), h('d', 'Chip shortage eases', 'tech', 1)]
const AREA = { x: 0, y: 0, width: 1920, height: 1040 }

describe('glass panel', () => {
  it('picks the newest headlines, by category or words', () => {
    expect(pickNews(ALL, null, '').map(x => x.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(pickNews(ALL, 'pakistan', '').map(x => x.id)).toEqual(['c', 'a'])
    expect(pickNews(ALL, null, 'flood').map(x => x.id)).toEqual(['a'])
  })

  it('finds "number 2" in what the owner sees, or a story by its words', () => {
    const list = pickNews(ALL, 'pakistan', '')
    expect(pickStory(list, ALL, 2, '')).toMatchObject({ item: { id: 'a' }, n: 2 })
    expect(pickStory(list, ALL, null, 'the metro one')).toMatchObject({ item: { id: 'c' }, n: 1 })
    // Not on the panel, but in today's news.
    expect(pickStory(list, ALL, null, 'chip shortage')).toMatchObject({ item: { id: 'd' }, n: null })
    expect(pickStory(list, ALL, 9, '')).toBeNull()
  })

  it('checks what the model sends', () => {
    expect(parseGlassShow({ view: 'map', lat: 95, lon: 0 })).toMatch(/lat and lon/)
    expect(parseGlassShow({ view: 'note', text: '  ' })).toMatch(/text/)
    expect(parseGlassShow({ view: 'news', category: 'sports' })).toEqual({ kind: 'news', category: null, query: '' })
    const map = parseGlassShow({ view: 'map', lat: 24.86, lon: 67, title: 'Karachi', zoom: 40, pins: [{ lat: 1, lon: 2, label: 'x' }, { lat: 'no' }] })
    expect(map).toMatchObject({ kind: 'map', zoom: 9, pins: [{ lat: 1, lon: 2, label: 'x' }] })
  })

  it('tells the model a numbered list, so it can say "detail of 2"', () => {
    expect(describeGlass({ kind: 'news', title: 'Pakistan', items: pickNews(ALL, 'pakistan', '') })).toContain('1. New metro line opens in Lahore (Dawn) 2. Floods in Sindh')
    expect(describeGlass(null)).toMatch(/closed/)
  })

  it('stacks above the widget on its corner edge, beside it when there is no room, never off screen', () => {
    // Bottom-right orb: the panel sits above it, right edges lined up.
    const orb = { x: 1840, y: 960, width: 64, height: 64 }
    const p = panelBounds(orb, { width: 400, height: 560 }, AREA)
    expect(p).toEqual({ x: 1504, y: 388, width: 400, height: 560 })
    // The same corner as a pill (wider to the left): the panel does not move sideways.
    expect(panelBounds({ x: 1556, y: 952, width: 348, height: 72 }, { width: 400, height: 560 }, AREA).x).toBe(1504)
    // Top-left: below it, left edges lined up.
    expect(panelBounds({ x: 20, y: 20, width: 64, height: 64 }, { width: 400, height: 560 }, AREA)).toMatchObject({ x: 20, y: 96 })
    // Mid-height on a short screen: no room above or below, so beside it.
    const side = panelBounds({ x: 1840, y: 500, width: 64, height: 64 }, { width: 400, height: 560 }, { x: 0, y: 0, width: 1920, height: 900 })
    expect(side.x + side.width).toBeLessThanOrEqual(1840)
    const none = panelBounds(null, { width: 560, height: 2000 }, AREA)
    expect(none.height).toBe(1040 - 24)
    expect(none.x + none.width).toBe(1920 - 12)
  })
})
