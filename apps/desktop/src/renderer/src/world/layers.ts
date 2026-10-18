/**
 * The layer registry: every layer the World map can show, in one list. The
 * switches, the map's own sources and layers, picking and the Inspector's
 * labels all read from here, so a new layer is one entry (plan §6).
 */
import type { GeoJSONSourceSpecification, LayerSpecification } from 'maplibre-gl'

export type LayerId = 'places' | 'quakes' | 'events' | 'flights' | 'ships' | 'satellites' | 'cameras' | 'pins' | 'story' | 'disasters' | 'news'

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
  /** The map layer that can be clicked, when it is not the first one drawn. */
  pickLayer?: string
  /** More sources this layer draws from (e.g. the lines between story items). */
  extraSources?: string[]
  /** Extra options for this layer's GeoJSON source, e.g. clustering. */
  sourceOptions?: Partial<GeoJSONSourceSpecification>
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
    id: 'disasters',
    label: 'Disaster alerts (GDACS)',
    kind: 'Disaster alert',
    dot: '#f97316',
    source: 'disasters',
    pickRank: 4.5,
    draw: [
      {
        id: 'disasters',
        type: 'circle',
        source: 'disasters',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'rank'], 0, 5, 2, 11],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.85,
          'circle-stroke-width': ['interpolate', ['linear'], ['get', 'rank'], 0, 1, 2, 3],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': 0.8,
        },
      },
      {
        id: 'disaster-labels',
        type: 'symbol',
        source: 'disasters',
        minzoom: 3,
        filter: ['>=', ['get', 'rank'], 1],
        layout: { 'text-field': ['get', 'title'], 'text-offset': [0, 1.3], 'text-size': 10, 'text-anchor': 'top', 'text-max-width': 12 },
        paint: { 'text-color': '#fed7aa', 'text-halo-color': HALO, 'text-halo-width': 1.5 },
      },
    ],
  },
  {
    id: 'news',
    label: 'News (from your feeds)',
    kind: 'News',
    dot: '#fbbf24',
    source: 'news',
    pickRank: 0.5,
    pickLayer: 'news',
    // Many headlines name the same capital: they group into numbered bubbles until zoomed in.
    sourceOptions: { cluster: true, clusterRadius: 38, clusterMaxZoom: 9 },
    draw: [
      {
        id: 'news-clusters',
        type: 'circle',
        source: 'news',
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 11, 5, 14, 15, 18, 40, 23],
          'circle-color': '#fbbf24',
          'circle-opacity': 0.82,
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(251,191,36,0.35)',
        },
      },
      {
        id: 'news-cluster-count',
        type: 'symbol',
        source: 'news',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 11, 'text-allow-overlap': true },
        paint: { 'text-color': '#0b1020' },
      },
      {
        id: 'news',
        type: 'circle',
        source: 'news',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'severity'], 0, 4.5, 10, 9],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0b1020',
        },
      },
      {
        id: 'news-labels',
        type: 'symbol',
        source: 'news',
        filter: ['!', ['has', 'point_count']],
        minzoom: 6,
        layout: { 'text-field': ['get', 'title'], 'text-offset': [0, 1.1], 'text-size': 10, 'text-anchor': 'top', 'text-max-width': 16 },
        paint: { 'text-color': '#fde68a', 'text-halo-color': HALO, 'text-halo-width': 1.5 },
      },
    ],
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
  {
    id: 'pins',
    label: 'Atlas’s pins',
    kind: 'Pin',
    dot: '#f472b6',
    source: 'pins',
    pickRank: -1,
    draw: [
      {
        id: 'pins',
        type: 'circle',
        source: 'pins',
        paint: { 'circle-radius': 7, 'circle-color': '#f472b6', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' },
      },
      {
        id: 'pin-labels',
        type: 'symbol',
        source: 'pins',
        layout: { 'text-field': ['get', 'title'], 'text-offset': [0, 1.3], 'text-size': 12, 'text-anchor': 'top', 'text-max-width': 12 },
        paint: { 'text-color': '#fbcfe8', 'text-halo-color': HALO, 'text-halo-width': 1.6 },
      },
    ],
  },
  {
    id: 'story',
    label: 'News story',
    kind: 'News',
    dot: '#fbbf24',
    source: 'story',
    extraSources: ['story-links'],
    pickRank: -2,
    pickLayer: 'story',
    draw: [
      // Lines between related items, under the markers; their dashes march (MapView animates them).
      {
        id: 'story-links',
        type: 'line',
        source: 'story-links',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fbbf24', 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [0, 4, 3] },
      },
      {
        id: 'story-glow',
        type: 'circle',
        source: 'story',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'severity'], 0, 14, 10, 26],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.18,
          'circle-blur': 0.6,
        },
      },
      {
        id: 'story',
        type: 'circle',
        source: 'story',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'severity'], 0, 9, 10, 13],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#0b1020',
        },
      },
      {
        id: 'story-numbers',
        type: 'symbol',
        source: 'story',
        layout: { 'text-field': ['to-string', ['get', 'n']], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': '#0b1020' },
      },
      {
        id: 'story-labels',
        type: 'symbol',
        source: 'story',
        minzoom: 2.5,
        layout: { 'text-field': ['get', 'title'], 'text-offset': [0, 1.6], 'text-size': 11, 'text-anchor': 'top', 'text-max-width': 14 },
        paint: { 'text-color': '#fde68a', 'text-halo-color': HALO, 'text-halo-width': 1.6 },
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
export const OWN_SOURCES: ReadonlySet<string> = new Set([...LAYERS.flatMap(l => [l.source, ...(l.extraSources ?? [])]), 'selected'])

/** Layers that can be clicked, top priority first. */
export const PICKABLE = [...LAYERS].sort((a, b) => a.pickRank - b.pickRank).map(l => ({ layer: l.pickLayer ?? l.draw[0]!.id, kind: l.id }))

export const layerDef = (id: LayerId) => LAYERS.find(l => l.id === id)!

export const readLayers = (): Record<LayerId, boolean> => {
  const all = Object.fromEntries(LAYERS.map(l => [l.id, true])) as Record<LayerId, boolean>
  try {
    return { ...all, ...(JSON.parse(localStorage.getItem('world.layers') ?? '{}') as Partial<Record<LayerId, boolean>>) }
  } catch {
    return all
  }
}
