import { describe, expect, it } from 'vitest'

import type { FC } from './geo.ts'
import { CHOKEPOINTS, DEFAULT_FILTERS, layerFilter, mixBy, passes, topBy } from './panels.ts'

const fc = (props: Record<string, string | number>[]): FC => ({
  type: 'FeatureCollection',
  features: props.map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i, 0] }, properties: p })),
})

describe('layer panels', () => {
  const ships = fc([{ category: 'Cargo' }, { category: 'Tanker' }, { category: 'Cargo' }, { category: 'Passenger' }])

  it('counts a layer by type, biggest first', () => {
    expect(mixBy(ships, 'category')).toEqual([
      { value: 'Cargo', count: 2 },
      { value: 'Passenger', count: 1 },
      { value: 'Tanker', count: 1 },
    ])
    expect(mixBy(undefined, 'category')).toEqual([])
  })

  it('lists the strongest quakes first', () => {
    const quakes = fc([{ title: 'a', mag: 4.2 }, { title: 'b', mag: 6.1 }, { title: 'c', mag: 5 }])
    expect(topBy(quakes, 'mag', 2).map(f => f.properties.title)).toEqual(['b', 'c'])
  })

  it('filters the map and the panel lists by the same rule', () => {
    const f = { ...DEFAULT_FILTERS, militaryOnly: true, shipTypes: ['Tanker'], quakeMinMag: 5 }
    expect(layerFilter('flights', f)).toEqual(['==', ['get', 'military'], 1])
    expect(layerFilter('ships', f)).toEqual(['in', ['get', 'category'], ['literal', ['Tanker']]])
    expect(layerFilter('quakes', f)).toEqual(['>=', ['get', 'mag'], 5])
    expect(layerFilter('places', f)).toBeNull()
    expect(passes('flights', { military: 0 }, f)).toBe(false)
    expect(passes('ships', { category: 'Tanker' }, f)).toBe(true)
    expect(passes('quakes', { mag: 4.8 }, f)).toBe(false)
  })

  it('shows everything by default', () => {
    for (const id of ['flights', 'ships', 'quakes', 'events'] as const) expect(layerFilter(id, DEFAULT_FILTERS)).toBeNull()
  })

  it('keeps chokepoints on real coordinates', () => {
    for (const c of CHOKEPOINTS) {
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180)
    }
  })
})
