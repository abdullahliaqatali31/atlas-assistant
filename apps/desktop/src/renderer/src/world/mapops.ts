/**
 * The pure half of the assistant's map ops: searching what is on the map,
 * describing what is on screen, how close to zoom for each kind of thing,
 * and the pins layer. MapView does the flying; this decides what to say.
 */
import type { Pin, Story } from '../../../shared/map.ts'
import { kmBetween, type FlightRoute } from '../../../shared/world.ts'
import type { FC } from './geo.ts'
import type { NearbyItem, Props } from './hover.ts'
import { layerDef, LAYERS, type LayerId } from './layers.ts'

/** How close to fly for each kind: a camera wants streets, a satellite the region. */
export const ZOOM_FOR: Record<LayerId, number> = { places: 9, quakes: 7, events: 8, flights: 8, ships: 10, satellites: 4, cameras: 13, pins: 9, story: 6, disasters: 6, news: 7 }

const label = (p: Props) => [p.title, p.name, p.callsign, p.label].filter(v => typeof v === 'string' && v).join(' ')

const fmt = (n: number) => n.toFixed(3)
const where = ([lon, lat]: [number, number]) => `${fmt(lat)}, ${fmt(lon)}`

/** Loaded items whose name contains every word of the query, best first: exact, then starts-with, then contains. */
export const findItems = (sources: Partial<Record<LayerId, FC>>, query: string, kinds: readonly LayerId[] = [], limit = 8): NearbyItem[] => {
  const q = query.trim().toLowerCase()
  if (!q) return []
  // "#2" or "2": the story item with that number.
  const numbered = /^#?(\d{1,2})$/.exec(q)
  if (numbered && (!kinds.length || kinds.includes('story'))) {
    const f = sources.story?.features.find(x => x.properties.n === Number(numbered[1]))
    if (f) return [{ kind: 'story', title: String(f.properties.title), km: 0, lngLat: f.geometry.coordinates as [number, number], props: f.properties }]
  }
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

// ── Stories: numbered news markers and the arcs between them ──

/** Calm amber for minor items, through orange, to red for the gravest. */
export const severityColor = (s: number | undefined) => (s === undefined ? '#fbbf24' : s >= 8 ? '#ef4444' : s >= 6 ? '#f97316' : s >= 4 ? '#f59e0b' : '#fbbf24')

export const storyFeatures = (story: Story | null): FC => ({
  type: 'FeatureCollection',
  features: (story?.items ?? []).map((it, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
    properties: {
      id: `story-${i + 1}`,
      n: i + 1,
      title: it.label,
      severity: it.severity ?? 5,
      color: severityColor(it.severity),
      ...(it.summary ? { summary: it.summary } : {}),
      ...(it.source ? { source: it.source } : {}),
      ...(it.url ? { url: it.url } : {}),
      ...(it.place ? { place: it.place } : {}),
    },
  })),
})

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/**
 * Points along the great circle from a to b ([lon, lat]). Longitudes are
 * unwrapped (may pass 180) so a line over the Pacific stays one line.
 */
export const greatCircle = (a: [number, number], b: [number, number], steps = 48): [number, number][] => {
  const [l1, p1] = [rad(a[0]), rad(a[1])]
  const [l2, p2] = [rad(b[0]), rad(b[1])]
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2))
  if (d < 1e-9) return [a, b]
  const out: [number, number][] = []
  let prev = a[0]
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2)
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2)
    const z = A * Math.sin(p1) + B * Math.sin(p2)
    let lon = deg(Math.atan2(y, x))
    // Keep each step within 180° of the last, so the line never jumps across the map.
    while (lon - prev > 180) lon -= 360
    while (lon - prev < -180) lon += 360
    prev = lon
    out.push([lon, deg(Math.atan2(z, Math.sqrt(x * x + y * y)))])
  }
  return out
}

export interface LineFC {
  type: 'FeatureCollection'
  features: { type: 'Feature'; geometry: { type: 'LineString'; coordinates: [number, number][] }; properties: Record<string, string | number> }[]
}

export const linkFeatures = (story: Story | null): LineFC => ({
  type: 'FeatureCollection',
  features: (story?.links ?? []).flatMap(l => {
    const a = story!.items[l.from - 1]
    const b = story!.items[l.to - 1]
    if (!a || !b) return []
    return [{ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: greatCircle([a.lon, a.lat], [b.lon, b.lat]) }, properties: { from: l.from, to: l.to, reason: l.reason ?? '' } }]
  }),
})

type RouteFC = { type: 'FeatureCollection'; features: ({ type: 'Feature'; geometry: { type: 'LineString'; coordinates: [number, number][] } | { type: 'Point'; coordinates: [number, number] }; properties: Record<string, string> })[] }

/** A picked flight's route: origin to the aircraft (flown), the aircraft to destination (ahead), and both airports. */
export const routeFeatures = (route: FlightRoute | null, plane: [number, number]): RouteFC => {
  if (!route) return { type: 'FeatureCollection', features: [] }
  const from: [number, number] = [route.origin.lon, route.origin.lat]
  const to: [number, number] = [route.destination.lon, route.destination.lat]
  const code = (a: FlightRoute['origin']) => a.iata || a.icao
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: greatCircle(from, plane) }, properties: { part: 'flown' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: greatCircle(plane, to) }, properties: { part: 'ahead' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: from }, properties: { code: code(route.origin) } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: to }, properties: { code: code(route.destination) } },
    ],
  }
}

/** How far along its route an aircraft is (0 to 1), and the distance still to fly. */
export const routeProgress = (route: FlightRoute, plane: { lat: number; lon: number }) => {
  const done = kmBetween({ lat: route.origin.lat, lon: route.origin.lon }, plane)
  const left = kmBetween(plane, { lat: route.destination.lat, lon: route.destination.lon })
  return { fraction: done + left > 0 ? done / (done + left) : 0, kmLeft: Math.round(left) }
}
