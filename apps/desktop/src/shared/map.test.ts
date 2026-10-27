import { describe, expect, it } from 'vitest'

import { mapOpFromTool, MAX_PINS, type Map3dOp } from './map.ts'

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

  it('builds a story: items need a place, links must join two real items once, links only https', () => {
    const op = mapOpFromTool('map_story', {
      title: 'Red Sea shipping',
      items: [
        { lat: 15.5, lon: 42.5, label: 'Ship attacked off Yemen', severity: 8, url: 'https://example.com/a' },
        { lat: 30.0, lon: 32.5, label: 'Suez traffic down', url: 'javascript:alert(1)' },
        { label: 'No place given' },
      ],
      links: [
        { from: 1, to: 2, reason: 'cause and effect' },
        { from: 2, to: 1 },
        { from: 1, to: 1 },
        { from: 1, to: 9 },
      ],
    })
    expect(op).toMatchObject({ kind: 'story', story: { title: 'Red Sea shipping', links: [{ from: 1, to: 2, reason: 'cause and effect' }] } })
    const items = (op as { story: { items: { url?: string }[] } }).story.items
    expect(items).toHaveLength(2)
    expect(items[0]?.url).toBe('https://example.com/a')
    expect(items[1]?.url).toBeUndefined()
    expect(() => mapOpFromTool('map_story', { items: [{ label: 'x' }] })).toThrow('A story needs items')
    expect(mapOpFromTool('map_story', { clear: true })).toEqual({ kind: 'story', story: null })
  })

  it('plays or stops a tour with a sensible pace', () => {
    expect(mapOpFromTool('map_tour', {})).toEqual({ kind: 'tour', action: 'play', secondsEach: 7 })
    expect(mapOpFromTool('map_tour', { action: 'stop', seconds_each: 1 })).toEqual({ kind: 'tour', action: 'stop', secondsEach: 7 })
  })

  it('drives the 3D view: actions, layers, modes and checks', () => {
    expect(mapOpFromTool('map_3d', { action: 'open', lat: 47.6, lon: -122.3, zoom: 12, label: 'Seattle' })).toMatchObject({ kind: '3d', action: 'open', lat: 47.6, lon: -122.3, zoom: 12, label: 'Seattle', show: [], hide: [] })
    expect(mapOpFromTool('map_3d', { action: 'layers', show: ['cables', 'nope'], hide: ['cables', 'flights'] })).toMatchObject({ show: ['cables'], hide: ['flights'] })
    expect(mapOpFromTool('map_3d', { action: 'fly_with', query: 'PIA301', mode: 'cockpit' })).toMatchObject({ action: 'fly_with', query: 'PIA301', mode: 'cockpit' })
    expect((mapOpFromTool('map_3d', { action: 'next_contact', previous: true }) as Map3dOp).direction).toBe(-1)
    expect((mapOpFromTool('map_3d', { action: 'orbit', on: false }) as Map3dOp).direction).toBe(0)
    expect(mapOpFromTool('map_3d', { action: 'follow_sat', query: 'ISS', mode: 'eye' })).toMatchObject({ query: 'ISS', mode: 'eye' })
    expect(() => mapOpFromTool('map_3d', { action: 'fly_to_mars' })).toThrow('Say the action')
    expect(() => mapOpFromTool('map_3d', { action: 'layers' })).toThrow('Name 3D layers')
    expect(() => mapOpFromTool('map_3d', { action: 'follow_sat' })).toThrow('Which satellite')
    expect(() => mapOpFromTool('map_3d', { action: 'open', lat: 10 })).toThrow('both lat and lon')
    expect((mapOpFromTool('map_3d', { action: 'camera', mode: 'sideways' }) as Map3dOp).mode).toBeUndefined()
  })

  it('rejects tools it does not know', () => {
    expect(() => mapOpFromTool('map_delete', {})).toThrow('Unknown map tool')
  })
})
