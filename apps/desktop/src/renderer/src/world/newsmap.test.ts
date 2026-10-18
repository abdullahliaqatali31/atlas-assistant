import { describe, expect, it } from 'vitest'

import type { Headline } from '../../../shared/news.ts'
import { newsFeatures } from './newsmap.ts'

const h = (id: string, title: string, summary = ''): Headline => ({ id, title, link: `https://news.example/${id}`, source: 'Dawn', category: 'pakistan', publishedAt: 1, summary, image: null })

describe('newsFeatures', () => {
  it('places headlines that name a place and skips the rest', () => {
    const fc = newsFeatures([h('a', 'Rain floods roads in Karachi'), h('b', 'Opinion: why we read'), h('c', 'Missile strike near Kharkiv')])
    expect(fc.features.map(f => f.properties.place)).toEqual(['Karachi', 'Kharkiv'])
    expect(fc.features[1]?.properties).toMatchObject({ severity: 7, source: 'Dawn', url: 'https://news.example/c' })
  })

  it('spreads country-level headlines around the capital, the same way every time', () => {
    const one = newsFeatures([h('x1', 'Pakistani team wins'), h('x2', 'Pakistani rupee steady')])
    const [a, b] = one.features.map(f => f.geometry.coordinates)
    expect(a).not.toEqual(b)
    for (const p of [a!, b!]) {
      expect(Math.abs(p[0]! - 73.04)).toBeLessThanOrEqual(0.61)
      expect(Math.abs(p[1]! - 33.72)).toBeLessThanOrEqual(0.61)
    }
    expect(newsFeatures([h('x1', 'Pakistani team wins')]).features[0]?.geometry.coordinates).toEqual(a)
  })
})
