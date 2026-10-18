import { describe, expect, it } from 'vitest'

import { MAP_LAYERS } from '../../../shared/map.ts'
import type { FC } from './geo.ts'
import { LAYERS } from './layers.ts'
import { describeFound, describeVisible, findItems, inBounds, pinFeatures, ZOOM_FOR } from './mapops.ts'

const fc = (items: { lon: number; lat: number; props: Record<string, string | number> }[]): FC => ({
  type: 'FeatureCollection',
  features: items.map(i => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i.lon, i.lat] }, properties: i.props })),
})

const sources = {
  flights: fc([
    { lon: 67.1, lat: 24.9, props: { title: 'PIA301 · A320', callsign: 'PIA301' } },
    { lon: 67.3, lat: 25.1, props: { title: 'UAE612 · B77W', callsign: 'UAE612' } },
  ]),
  ships: fc([{ lon: 56.3, lat: 26.5, props: { title: 'FRONT ALTAIR · Tanker', name: 'FRONT ALTAIR' } }]),
  places: fc([{ lon: 67.0, lat: 24.86, props: { id: 'p1', title: 'Karachi' } }]),
}

describe('map ops', () => {
  it('keeps the shared layer list in step with the registry', () => {
    expect([...MAP_LAYERS].sort()).toEqual(LAYERS.map(l => l.id).sort())
    for (const id of MAP_LAYERS) expect(ZOOM_FOR[id]).toBeGreaterThan(0)
  })

  it('finds by callsign or name, exact matches first, case-insensitive', () => {
    expect(findItems(sources, 'pia301').map(i => i.title)).toEqual(['PIA301 · A320'])
    expect(findItems(sources, 'front altair')[0]).toMatchObject({ kind: 'ships', lngLat: [56.3, 26.5] })
    expect(findItems(sources, 'karachi')[0]?.kind).toBe('places')
    expect(findItems(sources, 'PIA', ['ships'])).toEqual([])
  })

  it('explains an empty search so the assistant can try again', () => {
    expect(describeFound([], 'EK600')).toContain('Flights load only around the map centre')
  })

  it('handles views that cross the date line', () => {
    expect(inBounds([179, 0], { west: 170, south: -10, east: -170, north: 10 })).toBe(true)
    expect(inBounds([0, 0], { west: 170, south: -10, east: -170, north: 10 })).toBe(false)
  })

  it('describes the screen: place, style, counts and the nearest items, and layers that are off', () => {
    const text = describeVisible(
      sources,
      { west: 66, south: 24, east: 68, north: 26 },
      { center: [67.0, 24.86], zoom: 8, style: 'satellite', globe: false, layersOn: ['flights', 'places', 'ships'], selected: { kind: 'places', title: 'Karachi' } },
    )
    expect(text).toContain('zoom 8.0 (satellite, flat)')
    expect(text).toContain('Card open: Your place "Karachi"')
    expect(text).toContain('Flights (live): 2 on screen, e.g. PIA301 · A320; UAE612 · B77W.')
    // The tanker in Hormuz is not on this screen.
    expect(text).not.toContain('FRONT ALTAIR')
    expect(text).toContain('Layers off: quakes, cameras, events, satellites, pins.')
  })

  it('turns pins into map features with their labels and notes', () => {
    const f = pinFeatures([{ lat: 26.5, lon: 56.3, label: 'Strait of Hormuz', note: 'Tanker seized' }]).features[0]
    expect(f).toMatchObject({ geometry: { coordinates: [56.3, 26.5] }, properties: { title: 'Strait of Hormuz', note: 'Tanker seized' } })
  })
})
