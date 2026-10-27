import { describe, expect, it } from 'vitest'

import { isCableId, parseCableDetail, parseCables, parseLandings, satGroup } from './space.ts'

describe('submarine cables', () => {
  it('reads cable routes, both line kinds, and drops bad points', () => {
    const cables = parseCables({
      features: [
        { properties: { id: 'apx-west', name: 'APX West', color: '#939597' }, geometry: { type: 'MultiLineString', coordinates: [[[106.1, -5.3], [108.3, -15.1], ['x', 1]], [[1, 1]]] } },
        { properties: { id: 'solo', name: 'Solo', color: 'red' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
        { properties: { name: 'no id' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      ],
    })
    expect(cables).toEqual([
      { id: 'apx-west', name: 'APX West', color: '#939597', lines: [[[106.1, -5.3], [108.3, -15.1]]] },
      { id: 'solo', name: 'Solo', color: '#39d5ff', lines: [[[0, 0], [1, 1]]] },
    ])
    expect(parseCables(null)).toEqual([])
  })

  it('reads landing points', () => {
    expect(parseLandings({ features: [{ properties: { id: 'perth', name: 'Perth, WA, Australia' }, geometry: { coordinates: [115.8, -31.9] } }, { properties: {}, geometry: { coordinates: [0, 0] } }] })).toEqual([{ id: 'perth', name: 'Perth, WA, Australia', lon: 115.8, lat: -31.9 }])
  })

  it('reads a cable card and keeps only web links', () => {
    const d = parseCableDetail({ id: 'apx-west', name: 'APX West', length: '4,600 km', landing_points: [{ name: 'Perth, WA, Australia', country: 'Australia' }], owners: 'SUBCO', rfs: '2029', is_planned: true, url: 'javascript:alert(1)' })
    expect(d).toEqual({ id: 'apx-west', name: 'APX West', length: '4,600 km', owners: 'SUBCO', rfs: '2029', planned: true, url: '', landings: [{ name: 'Perth, WA, Australia', country: 'Australia' }] })
    expect(parseCableDetail({})).toBeNull()
  })

  it('only accepts slug ids for the detail call', () => {
    expect(isCableId('apx-west')).toBe(true)
    expect(isCableId('../etc')).toBe(false)
    expect(isCableId('a?b')).toBe(false)
  })
})

describe('satellite groups', () => {
  it('falls back to the brightest group', () => {
    expect(satGroup('gps-ops').label).toBe('GPS')
    expect(satGroup('nope').id).toBe('visual')
  })
})
