/**
 * The layer registry: every layer the World map can show, in one list. The
 * switches, the map's own sources and layers, picking and the Inspector's
 * labels all read from here, so a new layer is one entry (plan §6).
 */
import type { GeoJSONSourceSpecification, LayerSpecification } from 'maplibre-gl'

export type LayerId = 'places' | 'quakes' | 'events' | 'flights' | 'ships' | 'satellites' | 'cameras' | 'pins' | 'story' | 'disasters' | 'news' | 'rain' | 'launches' | 'radio' | 'fires'

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
  /** A tiled image layer instead of GeoJSON (the tiles are set by the map). */
  raster?: { maxzoom: number; attribution: string }
  /** Extra options for this layer's GeoJSON source, e.g. clustering. */
  sourceOptions?: Partial<GeoJSONSourceSpecification>
}

const HALO = '#0b1020'

/** Draw order, bottom to top. */
export const LAYERS: LayerDef[] = [
  {
    // Drawn first, so every point sits on top of the rain.
    id: 'rain',
    label: 'Rain (NASA satellites)',
    kind: 'Rain',
    dot: '#38bdf8',
    source: 'rain',
    pickRank: 99,
    raster: { maxzoom: 6, attribution: 'NASA GPM IMERG via GIBS' },
    draw: [{ id: 'rain', type: 'raster', source: 'rain', paint: { 'raster-opacity': 0.72, 'raster-fade-duration': 300 } }],
  },
  {
    id: 'radio',
    label: 'World radio (live)',
    kind: 'Radio station',
    dot: '#e879f9',
    source: 'radio',
    pickRank: 7,
    pickLayer: 'radio',
    // Thousands of stations: they group into bubbles until zoomed in.
    sourceOptions: { cluster: true, clusterRadius: 36, clusterMaxZoom: 8 },
    draw: [
      {
        id: 'radio-clusters',
        type: 'circle',
        source: 'radio',
        filter: ['has', 'point_count'],
        paint: { 'circle-radius': ['step', ['get', 'point_count'], 9, 10, 12, 50, 16, 200, 21], 'circle-color': '#e879f9', 'circle-opacity': 0.55, 'circle-stroke-width': 1.5, 'circle-stroke-color': 'rgba(232,121,249,0.4)' },
      },
      {
        id: 'radio-cluster-count',
        type: 'symbol',
        source: 'radio',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 10, 'text-allow-overlap': true },
        paint: { 'text-color': '#ffffff' },
      },
      { id: 'radio', type: 'circle', source: 'radio', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 4.5, 'circle-color': '#e879f9', 'circle-stroke-width': 1.5, 'circle-stroke-color': HALO } },
      {
        id: 'radio-labels',
        type: 'symbol',
        source: 'radio',
        filter: ['!', ['has', 'point_count']],
        minzoom: 7,
        layout: { 'text-field': ['get', 'title'], 'text-offset': [0, 1.1], 'text-size': 10, 'text-anchor': 'top', 'text-max-width': 12 },
        paint: { 'text-color': '#f5d0fe', 'text-halo-color': HALO, 'text-halo-width': 1.5 },
      },
    ],
  },
  {
    id: 'launches',
    label: 'Space launches (±30 days)',
    kind: 'Space launch',
    dot: '#a3e635',
    source: 'launches',
    pickRank: 3.5,
    draw: [
      { id: 'launches', type: 'circle', source: 'launches', paint: { 'circle-radius': ['case', ['==', ['get', 'upcoming'], 1], 7, 5], 'circle-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff', 'circle-stroke-opacity': 0.85 } },
      {
        id: 'launch-labels',
        type: 'symbol',
        source: 'launches',
        minzoom: 2.5,
        filter: ['==', ['get', 'next'], 1],
        layout: { 'text-field': ['get', 'label'], 'text-offset': [0, 1.2], 'text-size': 10, 'text-anchor': 'top', 'text-max-width': 14 },
        paint: { 'text-color': '#d9f99d', 'text-halo-color': HALO, 'text-halo-width': 1.5 },
      },
    ],
  },
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
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 10, 5], 'circle-color': ['coalesce', ['get', 'color'], '#2dd4bf'], 'circle-opacity': 0.8, 'circle-stroke-width': 0.5, 'circle-stroke-color': HALO },
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
    id: 'fires',
    label: 'Fires from space (NASA FIRMS, last 24 h)',
    kind: 'Fire seen from space',
    dot: '#fb923c',
    source: 'fires',
    pickRank: 6.5,
    draw: [
      {
        id: 'fires',
        type: 'circle',
        source: 'fires',
        paint: {
          // Stronger fires are bigger and redder; more of them show as you zoom in.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, ['interpolate', ['linear'], ['get', 'frp'], 0, 1.2, 100, 2.5, 1000, 5], 8, ['interpolate', ['linear'], ['get', 'frp'], 0, 3, 100, 6, 1000, 11]],
          'circle-color': ['interpolate', ['linear'], ['get', 'frp'], 0, '#fde047', 20, '#fb923c', 100, '#ef4444', 500, '#b91c1c'],
          'circle-opacity': 0.85,
          'circle-blur': 0.35,
        },
      },
    ],
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
    dot: '#7dd3fc',
    source: 'flights',
    pickRank: 2,
    draw: [
      {
        id: 'flights',
        type: 'symbol',
        source: 'flights',
        layout: { 'icon-image': 'plane', // The 48 px silhouette: small over the whole world, full size over a city; picked and important ones a bit larger.
          'icon-size': ['interpolate', ['linear'], ['zoom'], 2, ['case', ['<', ['get', 'rank'], 2], 0.26, 0.15], 6, ['case', ['<', ['get', 'rank'], 2], 0.45, 0.33], 10, ['case', ['<', ['get', 'rank'], 2], 0.6, 0.48], 14, ['case', ['<', ['get', 'rank'], 2], 0.72, 0.6]], 'icon-rotate': ['get', 'track'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'symbol-sort-key': ['get', 'rank'] },
        paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': HALO, 'icon-halo-width': 1 },
      },
      {
        id: 'flight-labels',
        type: 'symbol',
        source: 'flights',
        minzoom: 5,
        // Labels compete for room (no overlap); emergencies and military win, so a busy sky never turns into a smear.
        layout: { 'text-field': ['get', 'label'], 'text-offset': [0, 1.2], 'text-size': 10, 'text-anchor': 'top', 'symbol-sort-key': ['get', 'rank'], 'text-optional': true },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': HALO, 'text-halo-width': 1.5 },
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

/** The picked item's path: where an aircraft or ship has been, a satellite's next orbit and footprint. */
export const TRAIL_LAYER: LayerSpecification = {
  id: 'trail',
  type: 'line',
  source: 'trail',
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: { 'line-color': ['coalesce', ['get', 'color'], '#22d3ee'], 'line-width': ['coalesce', ['get', 'width'], 2], 'line-opacity': 0.85, 'line-dasharray': [2, 1.5] },
}

/** A picked flight's route: flown (solid), still to go (dashed), and its two airports. */
export const ROUTE_LAYERS: LayerSpecification[] = [
  {
    id: 'route-flown',
    type: 'line',
    source: 'route',
    filter: ['==', ['get', 'part'], 'flown'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fbbf24', 'line-width': 2, 'line-opacity': 0.9 },
  },
  {
    id: 'route-ahead',
    type: 'line',
    source: 'route',
    filter: ['==', ['get', 'part'], 'ahead'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fde68a', 'line-width': 1.5, 'line-opacity': 0.75, 'line-dasharray': [2, 2] },
  },
  {
    id: 'route-airports',
    type: 'circle',
    source: 'route',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 4, 'circle-color': '#0b1220', 'circle-stroke-width': 2, 'circle-stroke-color': '#fbbf24' },
  },
  {
    id: 'route-labels',
    type: 'symbol',
    source: 'route',
    filter: ['==', ['geometry-type'], 'Point'],
    layout: { 'text-field': ['get', 'code'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': true },
    paint: { 'text-color': '#fde68a', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.2 },
  },
]

/** Every source the map owns (kept across style switches). */
export const OWN_SOURCES: ReadonlySet<string> = new Set([...LAYERS.flatMap(l => [l.source, ...(l.extraSources ?? [])]), 'selected', 'trail', 'route'])

/** Layers that can be clicked, top priority first. */
export const PICKABLE = [...LAYERS].sort((a, b) => a.pickRank - b.pickRank).map(l => ({ layer: l.pickLayer ?? l.draw[0]!.id, kind: l.id }))

export const layerDef = (id: LayerId) => LAYERS.find(l => l.id === id)!

/** Layers that start switched off. */
const DEFAULT_OFF: ReadonlySet<LayerId> = new Set(['rain', 'radio'])

export const readLayers = (): Record<LayerId, boolean> => {
  // Heavy or noisy layers start off; the owner turns them on with one key.
  const all = Object.fromEntries(LAYERS.map(l => [l.id, !DEFAULT_OFF.has(l.id)])) as Record<LayerId, boolean>
  try {
    return { ...all, ...(JSON.parse(localStorage.getItem('world.layers') ?? '{}') as Partial<Record<LayerId, boolean>>) }
  } catch {
    return all
  }
}
