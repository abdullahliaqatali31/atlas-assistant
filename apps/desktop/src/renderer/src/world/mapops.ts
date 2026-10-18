/**
 * The pure half of the assistant's map ops: searching what is on the map,
 * describing what is on screen, how close to zoom for each kind of thing,
 * and the pins layer. MapView does the flying; this decides what to say.
 */
import type { Pin } from '../../../shared/map.ts'
import { kmBetween } from '../../../shared/world.ts'
import type { FC } from './geo.ts'
import type { NearbyItem, Props } from './hover.ts'
import { layerDef, LAYERS, type LayerId } from './layers.ts'

/** How close to fly for each kind: a camera wants streets, a satellite the region. */
export const ZOOM_FOR: Record<LayerId, number> = { places: 9, quakes: 7, events: 8, flights: 8, ships: 10, satellites: 4, cameras: 13, pins: 9 }

const label = (p: Props) => [p.title, p.name, p.callsign, p.label].filter(v => typeof v === 'string' && v).join(' ')

const fmt = (n: number) => n.toFixed(3)
const where = ([lon, lat]: [number, number]) => `${fmt(lat)}, ${fmt(lon)}`

/** Loaded items whose name contains every word of the query, best first: exact, then starts-with, then contains. */
export const findItems = (sources: Partial<Record<LayerId, FC>>, query: string, kinds: readonly LayerId[] = [], limit = 8): NearbyItem[] => {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  const scored: { item: NearbyItem; score: number }[] = []
  for (const l of LAYERS) {
    if (kinds.length && !kinds.includes(l.id)) continue
    for (const f of sources[l.id]?.features ?? []) {
      const name = label(f.properties).toLowerCase()
      if (!name || !words.every(w => name.includes(w))) continue
      const title = String(f.properties.title ?? l.kind)
      const t = title.toLowerCase()
      const score = t === q ? 0 : t.startsWith(q) ? 1 : 2
      scored.push({ item: { kind: l.id, title, km: 0, lngLat: f.geometry.coordinates as [number, number], props: f.properties }, score })
    }
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map(s => s.item)
}

export const describeFound = (items: NearbyItem[], query: string) =>
  items.length
    ? `Found ${items.length} on the map for "${query}":\n${items.map(i => `- ${layerDef(i.kind).kind}: ${i.title} (${where(i.lngLat)})`).join('\n')}`
    : `Nothing called "${query}" is on the map right now. Flights load only around the map centre when zoomed in to a region, ships only where they report; try map_view there first, or check the layer is on.`

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

/** Inside the view, also when it crosses the date line (west > east). */
export const inBounds = ([lon, lat]: [number, number], b: Bounds) => lat >= b.south && lat <= b.north && (b.west <= b.east ? lon >= b.west && lon <= b.east : lon >= b.west || lon <= b.east)

export interface ViewFacts {
  center: [number, number]
  zoom: number
  style: string
  globe: boolean
  layersOn: LayerId[]
  selected: { kind: LayerId; title: string } | null
}

/** What the map shows, in a few lines: where, how, how many of each, and the nearest few of each. */
export const describeVisible = (sources: Partial<Record<LayerId, FC>>, bounds: Bounds, v: ViewFacts, perLayer = 4): string => {
  const [lon, lat] = v.center
  const lines = [`The World map is looking at ${fmt(lat)}, ${fmt(lon)} at zoom ${v.zoom.toFixed(1)} (${v.style}${v.globe ? ', globe' : ', flat'}).`]
  if (v.selected) lines.push(`Card open: ${layerDef(v.selected.kind).kind} "${v.selected.title}".`)
  const off: string[] = []
  for (const id of LAYERS.map(l => l.id)) {
    if (!v.layersOn.includes(id)) {
      off.push(id)
      continue
    }
    const seen = (sources[id]?.features ?? []).filter(f => inBounds(f.geometry.coordinates as [number, number], bounds))
    if (!seen.length) continue
    const near = seen
      .map(f => ({ title: String(f.properties.title ?? ''), km: kmBetween({ lat, lon }, { lat: f.geometry.coordinates[1]!, lon: f.geometry.coordinates[0]! }) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, perLayer)
    lines.push(`${layerDef(id).label}: ${seen.length} on screen, e.g. ${near.map(n => n.title || '(unnamed)').join('; ')}.`)
  }
  if (lines.length === (v.selected ? 2 : 1)) lines.push('No items from the live layers are on screen here.')
  if (off.length) lines.push(`Layers off: ${off.join(', ')}.`)
  return lines.join('\n')
}

export const pinFeatures = (pins: readonly Pin[]): FC => ({
  type: 'FeatureCollection',
  features: pins.map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { id: `pin-${i}`, title: p.label, ...(p.note ? { note: p.note } : {}) } })),
})
