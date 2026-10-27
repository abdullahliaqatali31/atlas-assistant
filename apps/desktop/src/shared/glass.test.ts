import { describe, expect, it } from 'vitest'

import { describeGlass, panelAlign, panelBounds, parseGlassShow, pickNews, pickStory } from './glass.ts'
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
    expect(describeGlass({ kind: 'news', title: 'Pakistan', items: pickNews(ALL, 'pakistan', ''), category: 'pakistan' })).toContain('1. New metro line opens in Lahore (Dawn) 2. Floods in Sindh')
    expect(describeGlass(null)).toMatch(/closed/)
  })

  it('opens beside the widget toward the middle of the screen, on its edge, narrowing to fit', () => {
    // Top-right orb: the panel to its left, tops lined up; content hugs the top.
    const topRight = { x: 1840, y: 20, width: 64, height: 64 }
    expect(panelBounds(topRight, { width: 432, height: 600 }, AREA)).toEqual({ x: 1396, y: 20, width: 432, height: 600 })
    expect(panelAlign(topRight, AREA)).toBe('top')
    // Bottom-right: to its left, bottoms lined up; content hugs the bottom.
    const br = panelBounds({ x: 1840, y: 960, width: 64, height: 64 }, { width: 432, height: 600 }, AREA)
    expect(br.x + br.width).toBe(1828)
    expect(br.y + br.height).toBe(1024)
    expect(panelAlign({ x: 1840, y: 960, width: 64, height: 64 }, AREA)).toBe('bottom')
    // Top-left: to its right.
    expect(panelBounds({ x: 20, y: 20, width: 64, height: 64 }, { width: 432, height: 600 }, AREA)).toMatchObject({ x: 96, y: 20 })
    // A narrow screen: the panel narrows to the room beside the widget.
    const narrow = { x: 0, y: 0, width: 800, height: 1040 }
    const n = panelBounds({ x: 420, y: 20, width: 64, height: 64 }, { width: 432, height: 600 }, narrow)
    expect(n.width).toBeLessThan(432)
    expect(n.x + n.width).toBe(408)
    // Too tight on both sides: stacked below it instead, inside the screen.
    const tiny = { x: 0, y: 0, width: 500, height: 1040 }
    const s = panelBounds({ x: 218, y: 20, width: 64, height: 64 }, { width: 432, height: 600 }, tiny)
    expect(s.y).toBe(96)
    expect(s.x + s.width).toBeLessThanOrEqual(500)
    const none = panelBounds(null, { width: 560, height: 2000 }, AREA)
    expect(none.height).toBe(1040 - 24)
    expect(none.x + none.width).toBe(1920 - 12)
  })
})
