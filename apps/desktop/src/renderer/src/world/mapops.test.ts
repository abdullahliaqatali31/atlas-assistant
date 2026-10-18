import { describe, expect, it } from 'vitest'

import { MAP_LAYERS } from '../../../shared/map.ts'
import type { FC } from './geo.ts'
import { LAYERS } from './layers.ts'
import { describeFound, describeVisible, findItems, inBounds, linkFeatures, pinFeatures, storyFeatures, ZOOM_FOR } from './mapops.ts'

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
    expect(text).toContain('Layers off: quakes, cameras, events, disasters, satellites, pins, story.')
  })

  const story = {
    title: 'Pacific',
    items: [
      { lat: 35.7, lon: 139.7, label: 'Tokyo summit', severity: 3 },
      { lat: 37.8, lon: -122.4, label: 'San Francisco deal', severity: 9 },
    ],
    links: [{ from: 1, to: 2, reason: 'same talks' }],
  }

  it('numbers story items and colours them by severity', () => {
    const f = storyFeatures(story).features
    expect(f.map(x => x.properties.n)).toEqual([1, 2])
    expect(f[1]?.properties).toMatchObject({ title: 'San Francisco deal', color: '#ef4444', severity: 9 })
    expect(storyFeatures(null).features).toEqual([])
  })

  it('finds a story item by its number', () => {
    const sources = { story: storyFeatures(story) }
    expect(findItems(sources, '#2')[0]).toMatchObject({ kind: 'story', title: 'San Francisco deal' })
    expect(findItems(sources, '2')[0]?.title).toBe('San Francisco deal')
  })

  it('draws a link as one unbroken arc, even across the date line', () => {
    const line = linkFeatures(story).features[0]!.geometry.coordinates
    expect(line[0]![0]).toBeCloseTo(139.7, 6)
    expect(line[0]![1]).toBeCloseTo(35.7, 6)
    const [lon, lat] = line.at(-1)!
    // Unwrapped: -122.4 becomes 237.6 so the line crosses the Pacific instead of the whole world.
    expect(lon).toBeCloseTo(237.6, 5)
    expect(lat).toBeCloseTo(37.8, 5)
    for (let i = 1; i < line.length; i++) expect(Math.abs(line[i]![0] - line[i - 1]![0])).toBeLessThan(10)
    // A great circle from Tokyo to San Francisco bows north of both ends.
    expect(Math.max(...line.map(p => p[1]))).toBeGreaterThan(45)
  })

  it('turns pins into map features with their labels and notes', () => {
    const f = pinFeatures([{ lat: 26.5, lon: 56.3, label: 'Strait of Hormuz', note: 'Tanker seized' }]).features[0]
    expect(f).toMatchObject({ geometry: { coordinates: [56.3, 26.5] }, properties: { title: 'Strait of Hormuz', note: 'Tanker seized' } })
  })
})
