import { describe, expect, it } from 'vitest'

import { mapOpFromTool, MAX_PINS } from './map.ts'

describe('mapOpFromTool', () => {
  it('builds a fly-to with style and globe', () => {
    expect(mapOpFromTool('map_view', { lat: 24.86, lon: 67.0, zoom: 9, style: 'satellite', globe: true })).toEqual({
      kind: 'view',
      lat: 24.86,
      lon: 67.0,
      zoom: 9,
      label: undefined,
      style: 'satellite',
      globe: true,
    })
  })

  it('refuses half a coordinate, an empty view and out-of-range values', () => {
    expect(() => mapOpFromTool('map_view', { lat: 10 })).toThrow('both lat and lon')
    expect(() => mapOpFromTool('map_view', {})).toThrow('Say where')
    // An unknown style or a latitude past the pole is ignored, not passed on.
    expect(() => mapOpFromTool('map_view', { lat: 95, lon: 10, style: 'google' })).toThrow('both lat and lon')
  })

  it('keeps only real layers, and show wins over hide', () => {
    expect(mapOpFromTool('map_layers', { show: ['flights', 'bogus'], hide: ['flights', 'ships'] })).toEqual({ kind: 'layers', show: ['flights'], hide: ['ships'] })
    expect(() => mapOpFromTool('map_layers', { show: ['bogus'] })).toThrow('Name layers')
  })

  it('focuses by name or by coordinates, or closes the card', () => {
    expect(mapOpFromTool('map_focus', { query: 'Hormuz' })).toMatchObject({ kind: 'focus', query: 'Hormuz' })
    expect(mapOpFromTool('map_focus', { lat: 26.5, lon: 56.3 })).toMatchObject({ kind: 'focus', lat: 26.5, lon: 56.3 })
    expect(mapOpFromTool('map_focus', { clear: true })).toEqual({ kind: 'clear-selection' })
    expect(() => mapOpFromTool('map_focus', {})).toThrow('Say what to focus on')
  })

  it('checks pins and caps how many', () => {
    const many = Array.from({ length: MAX_PINS + 5 }, (_, i) => ({ lat: 1, lon: i, label: `p${i}` }))
    expect((mapOpFromTool('map_pins', { add: many }) as { add: unknown[] }).add).toHaveLength(MAX_PINS)
    expect(() => mapOpFromTool('map_pins', { add: [{ lat: 1, lon: 2 }] })).toThrow('lat, lon and a label')
    expect(mapOpFromTool('map_pins', { clear: true })).toEqual({ kind: 'pins', add: [], clear: true })
  })

  it('rejects tools it does not know', () => {
    expect(() => mapOpFromTool('map_delete', {})).toThrow('Unknown map tool')
  })
})
