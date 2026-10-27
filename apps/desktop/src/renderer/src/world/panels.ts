/**
 * What the layer panels show and filter (plan §4.2), pure: the world's
 * shipping chokepoints, a layer's mix by type, its biggest items, and the
 * map filters the Filters tab sets.
 */
import type { FilterSpecification } from 'maplibre-gl'

import type { FC } from './geo.ts'
import type { LayerId } from './layers.ts'

/** Straits and canals most of the world's sea trade passes through; a click flies there. */
export const CHOKEPOINTS: { name: string; lat: number; lon: number; zoom: number }[] = [
  { name: 'Strait of Hormuz', lat: 26.57, lon: 56.25, zoom: 8 },
  { name: 'Bab el-Mandeb', lat: 12.6, lon: 43.35, zoom: 8 },
  { name: 'Suez Canal', lat: 30.6, lon: 32.33, zoom: 8 },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.4, zoom: 7 },
  { name: 'Singapore Strait', lat: 1.2, lon: 103.85, zoom: 9 },
  { name: 'Panama Canal', lat: 9.1, lon: -79.68, zoom: 9 },
  { name: 'Strait of Gibraltar', lat: 35.95, lon: -5.6, zoom: 9 },
  { name: 'Strait of Dover', lat: 51.0, lon: 1.45, zoom: 9 },
  { name: 'Bosporus', lat: 41.12, lon: 29.07, zoom: 10 },
  { name: 'Taiwan Strait', lat: 24.4, lon: 119.5, zoom: 7 },
]

/** How many of each value of one property, biggest first. */
export const mixBy = (fc: FC | undefined, key: string): { value: string; count: number }[] => {
  const counts = new Map<string, number>()
  for (const f of fc?.features ?? []) {
    const v = String(f.properties[key] ?? 'Other')
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** The top `n` items by a numeric property. */
export const topBy = (fc: FC | undefined, key: string, n = 6) =>
  [...(fc?.features ?? [])].sort((a, b) => Number(b.properties[key] ?? 0) - Number(a.properties[key] ?? 0)).slice(0, n)

export interface MapFilters {
  militaryOnly: boolean
  /** Ship types to show; empty shows all. */
  shipTypes: string[]
  quakeMinMag: number
  /** Event categories to show; empty shows all. */
  eventTypes: string[]
  /** 0 all, 1 orange and red, 2 red only. */
  disasterMinAlert: number
  /** News categories to show; empty shows all. */
  newsTypes: string[]
  /** Let OpenSky (non-commercial terms) fill in flights where adsb.lol sees few. */
  openSky: boolean
}

export const DEFAULT_FILTERS: MapFilters = { militaryOnly: false, shipTypes: [], quakeMinMag: 4, eventTypes: [], disasterMinAlert: 0, newsTypes: [], openSky: false }

export const readFilters = (): MapFilters => {
  try {
    const raw = JSON.parse(localStorage.getItem('world.filters') ?? '{}') as Partial<MapFilters>
    return {
      militaryOnly: raw.militaryOnly === true,
      shipTypes: Array.isArray(raw.shipTypes) ? raw.shipTypes.filter((v): v is string => typeof v === 'string') : [],
      quakeMinMag: typeof raw.quakeMinMag === 'number' && raw.quakeMinMag >= 4 && raw.quakeMinMag <= 8 ? raw.quakeMinMag : 4,
      eventTypes: Array.isArray(raw.eventTypes) ? raw.eventTypes.filter((v): v is string => typeof v === 'string') : [],
      disasterMinAlert: raw.disasterMinAlert === 1 || raw.disasterMinAlert === 2 ? raw.disasterMinAlert : 0,
      openSky: raw.openSky === true,
      newsTypes: Array.isArray(raw.newsTypes) ? raw.newsTypes.filter((v): v is string => typeof v === 'string') : [],
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

export const saveFilters = (f: MapFilters) => {
  try {
    localStorage.setItem('world.filters', JSON.stringify(f))
  } catch {
    // A convenience only.
  }
}

/** The MapLibre filter for one layer's map layers, or null to show everything. */
export const layerFilter = (id: LayerId, f: MapFilters): FilterSpecification | null => {
  switch (id) {
    case 'flights':
      return f.militaryOnly ? ['==', ['get', 'military'], 1] : null
    case 'ships':
      return f.shipTypes.length ? ['in', ['get', 'category'], ['literal', f.shipTypes]] : null
    case 'quakes':
      return f.quakeMinMag > 4 ? ['>=', ['get', 'mag'], f.quakeMinMag] : null
    case 'events':
      return f.eventTypes.length ? ['in', ['get', 'category'], ['literal', f.eventTypes]] : null
    case 'disasters':
      return f.disasterMinAlert ? ['>=', ['get', 'rank'], f.disasterMinAlert] : null
    default:
      return null
  }
}

/** Does an item pass the layer's filter? Counts and lists use the same rule as the map. */
export const passes = (id: LayerId, props: Record<string, string | number>, f: MapFilters) => {
  switch (id) {
    case 'flights':
      return !f.militaryOnly || props.military === 1
    case 'ships':
      return !f.shipTypes.length || f.shipTypes.includes(String(props.category))
    case 'quakes':
      return Number(props.mag ?? 0) >= f.quakeMinMag
    case 'events':
      return !f.eventTypes.length || f.eventTypes.includes(String(props.category))
    case 'disasters':
      return Number(props.rank ?? 0) >= f.disasterMinAlert
    default:
      return true
  }
}
