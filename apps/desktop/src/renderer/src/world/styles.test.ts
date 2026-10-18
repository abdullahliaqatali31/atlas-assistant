import type { StyleSpecification } from 'maplibre-gl'
import { describe, expect, it } from 'vitest'

import { LAYERS, OWN_SOURCES, PICKABLE } from './layers.ts'
import { carryOverlays, composeStyle, creditLine, DEFAULT_STYLE, gibsDay, labelLayers, STYLES, styleCredit } from './styles.ts'

const vector = (name: string): StyleSpecification => ({
  version: 8,
  name,
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
    { id: 'highway_major', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
    { id: 'boundary_country', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary', paint: { 'line-color': '#333' } },
    { id: 'place_city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place' },
  ],
})
const bases = { dark: vector('dark'), light: vector('light') }
const NOW = Date.UTC(2026, 9, 18, 10)

describe('map styles', () => {
  it('opens on satellite imagery with place names and borders on top', () => {
    expect(DEFAULT_STYLE).toBe('satellite')
    const s = composeStyle({ id: 'satellite', bases, theme: 'dark', globe: false, now: NOW })
    expect(s.layers.map(l => l.id)).toEqual(['background', 'imagery', 'boundary_country', 'place_city'])
    const imagery = s.sources.imagery as { tiles: string[]; attribution: string }
    // The 2016 layer is the CC BY one; later years are non-commercial.
    expect(imagery.tiles[0]).toContain('/s2cloudless_3857/')
    expect(imagery.attribution).toContain('CC BY 4.0')
  })

  it('keeps only labels and borders when laying a vector style over imagery', () => {
    const layers = labelLayers(bases.dark)
    expect(layers.map(l => l.id)).toEqual(['boundary_country', 'place_city'])
    // Light names on a dark halo read over any imagery.
    expect(layers[1]).toMatchObject({ paint: { 'text-color': '#f1f5f9' } })
  })

  it('uses yesterday for the daily NASA view', () => {
    expect(gibsDay(NOW)).toBe('2026-10-17')
    const s = composeStyle({ id: 'today', bases, theme: 'dark', globe: false, now: NOW })
    expect((s.sources.imagery as { tiles: string[] }).tiles[0]).toContain('/default/2026-10-17/')
  })

  it('slips the relief under the first label of the theme’s style', () => {
    const s = composeStyle({ id: 'relief', bases, theme: 'light', globe: false, now: NOW })
    expect(s.name).toBe('light')
    const ids = s.layers.map(l => l.id)
    expect(ids.indexOf('hillshade')).toBe(ids.indexOf('place_city') - 1)
    expect(s.sources.terrain).toMatchObject({ type: 'raster-dem', encoding: 'terrarium' })
  })

  it('sets the projection from the globe switch', () => {
    expect(composeStyle({ id: 'dark', bases, theme: 'dark', globe: true, now: NOW }).projection).toEqual({ type: 'globe' })
    const flat = composeStyle({ id: 'dark', bases, theme: 'dark', globe: false, now: NOW })
    expect(flat.projection).toEqual({ type: 'mercator' })
    expect(flat.sky).toBeUndefined()
  })

  it('credits every style', () => {
    for (const s of STYLES) expect(styleCredit(s.id)).toMatch(/OpenStreetMap/)
    expect(styleCredit('satellite')).toContain('EOX')
  })

  it('always credits OpenStreetMap with its copyright link, and the live layers that are on', () => {
    for (const s of STYLES) {
      const parts = creditLine(s.id, [])
      expect(parts.find(p => p.text.includes('OpenStreetMap'))?.href).toBe('https://www.openstreetmap.org/copyright')
    }
    expect(creditLine('satellite', ['flights', 'places']).map(p => p.text)).toEqual([
      'Imagery © EOX Sentinel-2 cloudless 2016',
      'OpenFreeMap',
      '© OpenMapTiles',
      '© OpenStreetMap contributors',
      'Flights adsb.lol',
    ])
  })

  it('carries the map’s own layers on top of a new style', () => {
    const prev: StyleSpecification = {
      ...bases.dark,
      sources: { ...bases.dark.sources, flights: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [...bases.dark.layers, { id: 'flights', type: 'symbol', source: 'flights' }],
    }
    const next = composeStyle({ id: 'satellite', bases, theme: 'dark', globe: false, now: NOW })
    const out = carryOverlays(prev, next, OWN_SOURCES)
    expect(out.layers.at(-1)?.id).toBe('flights')
    expect(out.sources.flights).toBeDefined()
    expect(out.sources.imagery).toBeDefined()
    // Nothing from the old basemap leaks in.
    expect(out.layers.filter(l => l.id === 'water')).toHaveLength(0)
    expect(carryOverlays(undefined, next, OWN_SOURCES)).toBe(next)
  })
})

describe('layer registry', () => {
  it('gives every layer a unique source, map layers and a pick rank', () => {
    const ids = LAYERS.flatMap(l => l.draw.map(d => d.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const l of LAYERS) {
      expect(OWN_SOURCES.has(l.source)).toBe(true)
      for (const d of l.draw) expect([l.source, ...(l.extraSources ?? [])]).toContain('source' in d && d.source)
    }
    expect(new Set(LAYERS.map(l => l.pickRank)).size).toBe(LAYERS.length)
  })

  it('picks Atlas’s story and pins and your places first, then cameras, flights and ships', () => {
    expect(PICKABLE.slice(0, 6).map(p => p.kind)).toEqual(['story', 'pins', 'places', 'cameras', 'flights', 'ships'])
  })
})
