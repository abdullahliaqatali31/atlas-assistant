/**
 * The layer registry: every layer the World map can show, in one list. The
 * switches, the map's own sources and layers, picking and the Inspector's
 * labels all read from here, so a new layer is one entry (plan §6).
 */
import type { LayerSpecification } from 'maplibre-gl'

export type LayerId = 'places' | 'quakes' | 'events' | 'flights' | 'ships' | 'satellites' | 'cameras'

export interface LayerDef {
  id: LayerId
  /** The switch's label. */
  label: string
  /** What one item is called in the Inspector. */
  kind: string
  /** Swatch colour for the switch and the Inspector. */
  dot: string
  /** The GeoJSON source this layer draws from (same name as the id). */
  source: string
  /** MapLibre layers, bottom first; the first one is the one that can be picked. */
  draw: LayerSpecification[]
  /** Lower wins when several items sit under the pointer. */
  pickRank: number
}

const HALO = '#0b1020'

/** Draw order, bottom to top. */
export const LAYERS: LayerDef[] = [
  {
    id: 'quakes',
    label: 'Earthquakes (M4+)',
    kind: 'Earthquake',
    dot: '#f97316',
    source: 'quakes',
    pickRank: 6,
    draw: [
      {
        id: 'quakes',
        type: 'circle',
        source: 'quakes',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 4, 4, 6, 9, 8, 16],
          'circle-color': ['interpolate', ['linear'], ['get', 'mag'], 4, '#facc15', 5.5, '#f97316', 7, '#ef4444'],
          'circle-opacity': 0.75,
          'circle-stroke-width': 1,
          'circle-stroke-color': HALO,
        },
      },
    ],
  },
  {
    id: 'cameras',
    label: 'Public cameras',
    kind: 'Public camera',
    dot: '#2dd4bf',
    source: 'cameras',
    pickRank: 1,
    draw: [
      {
        id: 'cameras',
        type: 'circle',
        source: 'cameras',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 10, 5], 'circle-color': '#2dd4bf', 'circle-opacity': 0.8, 'circle-stroke-width': 0.5, 'circle-stroke-color': HALO },
      },
    ],
  },
  {
    id: 'events',
    label: 'Fires, storms, volcanoes, floods',
    kind: 'Natural event',
    dot: '#ef4444',
    source: 'events',
    pickRank: 5,
    draw: [{ id: 'events', type: 'circle', source: 'events', paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-width': 1, 'circle-stroke-color': HALO } }],
  },
  {
    id: 'satellites',
    label: 'Satellites & ISS',
    kind: 'Satellite',
    dot: '#c084fc',
    source: 'satellites',
    pickRank: 4,
    draw: [
      { id: 'satellites', type: 'circle', source: 'satellites', paint: { 'circle-radius': ['get', 'size'], 'circle-color': '#c084fc', 'circle-stroke-width': 1, 'circle-stroke-color': HALO } },
      {
        id: 'satellite-labels',
        type: 'symbol',
        source: 'satellites',
        layout: { 'text-field': ['get', 'label'], 'text-offset': [0, 1.1], 'text-size': 11, 'text-anchor': 'top' },
        paint: { 'text-color': '#e9d5ff', 'text-halo-color': HALO, 'text-halo-width': 1.5 },
      },
    ],
  },
  {
    id: 'ships',
    label: 'Ships (live)',
    kind: 'Ship',
    dot: '#34d399',
    source: 'ships',
    pickRank: 3,
    draw: [
      {
        id: 'ships',
        type: 'symbol',
        source: 'ships',
        layout: { 'icon-image': 'ship', 'icon-size': 0.45, 'icon-rotate': ['get', 'rotation'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true },
        paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': HALO, 'icon-halo-width': 1 },
      },
      {
        id: 'ship-labels',
        type: 'symbol',
        source: 'ships',
        minzoom: 8,
        layout: { 'text-field': ['get', 'name'], 'text-offset': [0, 1.1], 'text-size': 10, 'text-anchor': 'top' },
        paint: { 'text-color': '#a7f3d0', 'text-halo-color': HALO, 'text-halo-width': 1.5 },
      },
    ],
  },
  {
    id: 'flights',
    label: 'Flights (live)',
    kind: 'Flight',
    dot: '#fbbf24',
    source: 'flights',
    pickRank: 2,
    draw: [
      {
        id: 'flights',
        type: 'symbol',
        source: 'flights',
        layout: { 'icon-image': 'plane', 'icon-size': 0.55, 'icon-rotate': ['get', 'track'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true },
        paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': HALO, 'icon-halo-width': 1 },
      },
      {
        id: 'flight-labels',
        type: 'symbol',
        source: 'flights',
        minzoom: 6.5,
        layout: { 'text-field': ['get', 'callsign'], 'text-offset': [0, 1.2], 'text-size': 10, 'text-anchor': 'top' },
        paint: { 'text-color': '#fde68a', 'text-halo-color': HALO, 'text-halo-width': 1.5 },
      },
    ],
  },
  {
    id: 'places',
    label: 'Your places',
    kind: 'Your place',
    dot: '#22d3ee',
    source: 'places',
    pickRank: 0,
    draw: [
      { id: 'places', type: 'circle', source: 'places', paint: { 'circle-radius': 7, 'circle-color': '#22d3ee', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'places',
        layout: { 'text-field': ['get', 'title'], 'text-offset': [0, 1.3], 'text-size': 12, 'text-anchor': 'top' },
        paint: { 'text-color': '#e2e8f0', 'text-halo-color': HALO, 'text-halo-width': 1.5 },
      },
    ],
  },
]

/** The ring around the picked item, above every layer. */
export const SELECTED_LAYER: LayerSpecification = {
  id: 'selected',
  type: 'circle',
  source: 'selected',
  paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff', 'circle-stroke-opacity': 0.9 },
}

/** Every source the map owns (kept across style switches). */
export const OWN_SOURCES: ReadonlySet<string> = new Set([...LAYERS.map(l => l.source), 'selected'])

/** Layers that can be clicked, top priority first. */
export const PICKABLE = [...LAYERS].sort((a, b) => a.pickRank - b.pickRank).map(l => ({ layer: l.draw[0]!.id, kind: l.id }))

export const layerDef = (id: LayerId) => LAYERS.find(l => l.id === id)!

export const readLayers = (): Record<LayerId, boolean> => {
  const all = Object.fromEntries(LAYERS.map(l => [l.id, true])) as Record<LayerId, boolean>
  try {
    return { ...all, ...(JSON.parse(localStorage.getItem('world.layers') ?? '{}') as Partial<Record<LayerId, boolean>>) }
  } catch {
    return all
  }
}
