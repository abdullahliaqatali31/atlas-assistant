/**
 * Live traffic that moves: TomTom's vector flow tiles give each road's shape
 * and how fast it flows against its free-flow speed (traffic_level 0..1);
 * vehicles are animated along those roads, fast and sparse where it flows,
 * slow and bunched where it jams, none on closed roads (as God's Eye View
 * does). Incidents (crashes, roadworks, closures) come from TomTom's
 * Incident Details. The flat map and the 3D view share this engine.
 */

// ── Tiles ─────────────────────────────────────────────────────────

export interface TileId {
  z: number
  x: number
  y: number
}

export interface Box {
  west: number
  south: number
  east: number
  north: number
}

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z
const latToY = (lat: number, z: number) => {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

/** The tiles covering a box at a zoom, nearest the centre first, at most `max`. */
export const tilesFor = (b: Box, z: number, max = 16): TileId[] => {
  const n = 2 ** z
  const x0 = Math.max(0, Math.floor(lonToX(b.west, z)))
  const x1 = Math.min(n - 1, Math.floor(lonToX(b.east, z)))
  const y0 = Math.max(0, Math.floor(latToY(b.north, z)))
  const y1 = Math.min(n - 1, Math.floor(latToY(b.south, z)))
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const out: TileId[] = []
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y })
  return out.sort((a, b2) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b2.x - cx, b2.y - cy)).slice(0, max)
}

/** A tile-local point (0..extent) to lon/lat. */
const tileToLonLat = (t: TileId, px: number, py: number, extent: number): [number, number] => {
  const n = 2 ** t.z
  const lon = ((t.x + px / extent) / n) * 360 - 180
  const yy = Math.PI * (1 - (2 * (t.y + py / extent)) / n)
  return [lon, (Math.atan(Math.sinh(yy)) * 180) / Math.PI]
}

// ── A small Mapbox Vector Tile decoder (only what traffic needs: lines and their tags) ──

class Reader {
  pos = 0
  constructor(readonly buf: Uint8Array) {}
  varint(): number {
    let r = 0
    let shift = 0
    let b: number
    do {
      b = this.buf[this.pos++]!
      r += (b & 0x7f) * 2 ** shift
      shift += 7
    } while (b & 0x80 && shift < 64)
    return r
  }
  skip(wire: number) {
    if (wire === 0) this.varint()
    else if (wire === 1) this.pos += 8
    else if (wire === 2) this.pos += this.varint()
    else if (wire === 5) this.pos += 4
    else throw new Error(`Unknown wire type ${wire}`)
  }
  sub(): Reader {
    const len = this.varint()
    const r = new Reader(this.buf.subarray(this.pos, this.pos + len))
    this.pos += len
    return r
  }
  get done() {
    return this.pos >= this.buf.length
  }
}

type TagValue = string | number | boolean

const readValue = (r: Reader): TagValue => {
  let v: TagValue = ''
  while (!r.done) {
    const key = r.varint()
    const field = key >> 3
    const wire = key & 7
    if (field === 1) {
      const len = r.varint()
      v = new TextDecoder().decode(r.buf.subarray(r.pos, r.pos + len))
      r.pos += len
    } else if (field === 2) {
      v = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 4).getFloat32(0, true)
      r.pos += 4
    } else if (field === 3) {
      v = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 8).getFloat64(0, true)
      r.pos += 8
    } else if (field === 4 || field === 5) v = r.varint()
    else if (field === 6) {
      const z = r.varint()
      v = (z >>> 1) ^ -(z & 1)
    } else if (field === 7) v = r.varint() !== 0
    else r.skip(wire)
  }
  return v
}

const packed = (r: Reader): number[] => {
  const s = r.sub()
  const out: number[] = []
  while (!s.done) out.push(s.varint())
  return out
}

/** Geometry commands to lines (tile coordinates). */
const decodeLines = (cmds: number[]): [number, number][][] => {
  const lines: [number, number][][] = []
  let x = 0
  let y = 0
  let line: [number, number][] = []
  for (let i = 0; i < cmds.length; ) {
    const c = cmds[i++]!
    const id = c & 7
    const count = c >> 3
    if (id === 7) continue
    for (let k = 0; k < count; k++) {
      const dx = cmds[i++]!
      const dy = cmds[i++]!
      x += (dx >>> 1) ^ -(dx & 1)
      y += (dy >>> 1) ^ -(dy & 1)
      if (id === 1) {
        if (line.length > 1) lines.push(line)
        line = [[x, y]]
      } else line.push([x, y])
    }
  }
  if (line.length > 1) lines.push(line)
  return lines
}

export interface TileFeature {
  type: number
  tags: Record<string, TagValue>
  lines: [number, number][][]
}

/** One layer's features from a vector tile. */
export const decodeLayer = (buf: Uint8Array, layerName: string): { extent: number; features: TileFeature[] } => {
  const tile = new Reader(buf)
  while (!tile.done) {
    const key = tile.varint()
    if (key >> 3 !== 3 || (key & 7) !== 2) {
      tile.skip(key & 7)
      continue
    }
    const layer = tile.sub()
    let name = ''
    let extent = 4096
    const keys: string[] = []
    const values: TagValue[] = []
    const raw: { type: number; tags: number[]; geometry: number[] }[] = []
    while (!layer.done) {
      const k = layer.varint()
      const field = k >> 3
      if (field === 1) {
        const len = layer.varint()
        name = new TextDecoder().decode(layer.buf.subarray(layer.pos, layer.pos + len))
        layer.pos += len
      } else if (field === 2) {
        const f = layer.sub()
        const feat = { type: 0, tags: [] as number[], geometry: [] as number[] }
        while (!f.done) {
          const fk = f.varint()
          const ff = fk >> 3
          if (ff === 2) feat.tags = packed(f)
          else if (ff === 3) feat.type = f.varint()
          else if (ff === 4) feat.geometry = packed(f)
          else f.skip(fk & 7)
        }
        raw.push(feat)
      } else if (field === 3) {
        const len = layer.varint()
        keys.push(new TextDecoder().decode(layer.buf.subarray(layer.pos, layer.pos + len)))
        layer.pos += len
      } else if (field === 4) values.push(readValue(layer.sub()))
      else if (field === 5) extent = layer.varint()
      else layer.skip(k & 7)
    }
    if (name !== layerName) continue
    const features = raw.map(f => {
      const tags: Record<string, TagValue> = {}
      for (let i = 0; i + 1 < f.tags.length; i += 2) tags[keys[f.tags[i]!]!] = values[f.tags[i + 1]!]!
      return { type: f.type, tags, lines: f.type === 2 ? decodeLines(f.geometry) : [] }
    })
    return { extent, features }
  }
  return { extent: 4096, features: [] }
}

// ── Roads with their flow ─────────────────────────────────────────

export interface FlowRoad {
  /** lon/lat points along the road, in its driving direction. */
  path: [number, number][]
  /** Speed against free flow, 0 (standing) .. 1 (free). */
  level: number
  /** 0 motorway … 7 minor local road. */
  rank: number
  closed: boolean
  /** Real road, invented movement (no live data here). */
  sim?: boolean | undefined
}

const RANK: Record<string, number> = {
  Motorway: 0,
  'International road': 1,
  'Major road': 2,
  'Secondary road': 3,
  'Connecting road': 4,
  'Major local road': 5,
  'Local road': 6,
  'Minor local road': 7,
}

/** A TomTom flow tile (relative) to roads in lon/lat; points inside the tile margin are kept, so roads join up. */
export const roadsFromTile = (buf: Uint8Array, t: TileId): FlowRoad[] => {
  const { extent, features } = decodeLayer(buf, 'Traffic flow')
  const roads: FlowRoad[] = []
  for (const f of features) {
    const level = typeof f.tags.traffic_level === 'number' ? Math.max(0, Math.min(1, f.tags.traffic_level)) : 1
    const rank = RANK[String(f.tags.road_type)] ?? 6
    const closed = f.tags.road_closure === true
    for (const line of f.lines) roads.push({ path: line.map(([x, y]) => tileToLonLat(t, x, y, extent)), level, rank, closed })
  }
  return roads
}

/** OpenMapTiles road classes (OpenFreeMap) → rank, for places TomTom does not cover. */
const OMT_RANK: Record<string, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 5 }

/** Main roads from an OpenMapTiles tile, as roads with unknown flow (movement is simulated); two-way roads both ways. */
export const simRoadsFromTile = (buf: Uint8Array, t: TileId): FlowRoad[] => {
  const { extent, features } = decodeLayer(buf, 'transportation')
  const roads: FlowRoad[] = []
  for (const f of features) {
    const rank = OMT_RANK[String(f.tags.class)]
    if (rank === undefined || f.tags.brunnel === 'tunnel') continue
    const oneway = f.tags.oneway === 1 || f.tags.oneway === true
    const ramp = f.tags.ramp === 1 || f.tags.ramp === true
    for (const line of f.lines) {
      const path = line.map(([x, y]) => tileToLonLat(t, x, y, extent))
      roads.push({ path, level: 0.85, rank: ramp ? 4 : rank, closed: false, sim: true })
      if (!oneway && !ramp) roads.push({ path: [...path].reverse(), level: 0.85, rank, closed: false, sim: true })
    }
  }
  return roads
}

/** green → yellow → orange → red, by flow; closed roads dark red. */
export const flowColor = (level: number, closed = false) => (closed ? '#7f1d1d' : level >= 0.75 ? '#22c55e' : level >= 0.5 ? '#eab308' : level >= 0.25 ? '#f97316' : '#ef4444')

export interface TrafficFlowView {
  roads: FlowRoad[]
  source: 'tomtom' | 'simulated' | 'none'
}

// ── Vehicles ──────────────────────────────────────────────────────

const R = 6_371_000
const metres = (a: [number, number], b: [number, number]) => {
  const k = Math.PI / 180
  const x = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k)
  const y = (b[1] - a[1]) * k
  return Math.hypot(x, y) * R
}

/** Free-flow speeds (m/s) by road rank. */
const FREE = [30, 25, 20, 16, 13, 11, 9, 7]

interface Lane {
  path: [number, number][]
  /** Distance from the start to each point. */
  at: number[]
  length: number
  speed: number
  level: number
  color: string
}

/** Simulated movement: one calm colour, so it never looks like a real jam. */
export const SIM_COLOR = '#7dd3fc'

export interface Vehicle {
  lane: number
  d: number
}

/**
 * Vehicles along the roads. Each road gets cars by its length, more where it
 * jams (cars bunch up) and on bigger roads; each moves at its road's speed
 * (sped up so movement shows on a map) and wraps around at the end.
 */
export class TrafficEngine {
  lanes: Lane[] = []
  cars: Vehicle[] = []

  setRoads(roads: readonly FlowRoad[], maxCars = 1800, seed = 1) {
    let s = seed
    const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
    this.lanes = []
    for (const r of roads) {
      if (r.closed || r.path.length < 2) continue
      const at = [0]
      for (let i = 1; i < r.path.length; i++) at.push(at[i - 1]! + metres(r.path[i - 1]!, r.path[i]!))
      const length = at[at.length - 1]!
      if (length < 30) continue
      this.lanes.push({ path: r.path, at, length, speed: (FREE[r.rank] ?? 9) * Math.max(0.06, r.level), level: r.level, color: r.sim ? SIM_COLOR : flowColor(r.level) })
    }
    // Cars per metre: busier roads and jams hold more.
    const want = this.lanes.map((l, i) => ({ i, n: (l.length / 1000) * (3 + (1 - l.level) * 9) * (l.speed > 18 ? 1.6 : 1) }))
    const total = want.reduce((a, w) => a + w.n, 0)
    const scale = total > maxCars ? maxCars / total : 1
    this.cars = []
    for (const w of want) {
      const n = w.n * scale
      const count = Math.floor(n) + (rnd() < n - Math.floor(n) ? 1 : 0)
      for (let k = 0; k < count; k++) this.cars.push({ lane: w.i, d: rnd() * this.lanes[w.i]!.length })
    }
  }

  /** Move every car by dt seconds of its road's speed, times `boost` so it shows at map scale. */
  step(dt: number, boost: number) {
    for (const c of this.cars) {
      const l = this.lanes[c.lane]!
      c.d = (c.d + l.speed * dt * boost) % l.length
    }
  }

  /** Where a car is: lon, lat and heading (radians, east = 0, counter-clockwise). */
  place(c: Vehicle): { lon: number; lat: number; heading: number; color: string; level: number } {
    const l = this.lanes[c.lane]!
    let lo = 0
    let hi = l.at.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (l.at[mid]! <= c.d) lo = mid
      else hi = mid
    }
    const a = l.path[lo]!
    const b = l.path[hi]!
    const span = l.at[hi]! - l.at[lo]! || 1
    const f = (c.d - l.at[lo]!) / span
    const lon = a[0] + (b[0] - a[0]) * f
    const lat = a[1] + (b[1] - a[1]) * f
    const heading = Math.atan2(b[1] - a[1], (b[0] - a[0]) * Math.cos((lat * Math.PI) / 180))
    return { lon, lat, heading, color: l.color, level: l.level }
  }
}

// ── Incidents ─────────────────────────────────────────────────────

export interface TrafficIncident {
  id: string
  /** Where to put its marker (the start of its stretch). */
  lat: number
  lon: number
  /** The stretch of road it covers. */
  path: [number, number][]
  kind: IncidentKind
  /** 0 unknown, 1 minor, 2 moderate, 3 major, 4 closed/undefined. */
  magnitude: number
  description: string
  from: string
  to: string
  road: string
  /** Delay in seconds, length in metres. */
  delay: number
  length: number
  start: number | null
  end: number | null
}

export type IncidentKind = 'accident' | 'jam' | 'roadworks' | 'closure' | 'weather' | 'hazard' | 'other'

/** TomTom iconCategory → a kind. */
const KIND: Record<number, IncidentKind> = { 1: 'accident', 2: 'weather', 3: 'hazard', 4: 'weather', 5: 'weather', 6: 'jam', 7: 'closure', 8: 'closure', 9: 'roadworks', 10: 'weather', 11: 'weather', 14: 'hazard' }

export const INCIDENT_LABEL: Record<IncidentKind, string> = { accident: 'Accident', jam: 'Traffic jam', roadworks: 'Roadworks', closure: 'Road closed', weather: 'Weather on the road', hazard: 'Hazard', other: 'Incident' }

/** The Incident Details (v5) answer to incidents. */
export const parseIncidents = (j: unknown): TrafficIncident[] => {
  const list = (j as { incidents?: unknown[] } | null)?.incidents
  if (!Array.isArray(list)) return []
  const out: TrafficIncident[] = []
  for (const raw of list) {
    const o = raw as {
      type?: string
      geometry?: { type?: string; coordinates?: unknown }
      properties?: { id?: string; iconCategory?: number; magnitudeOfDelay?: number; events?: { description?: string }[]; from?: string; to?: string; roadNumbers?: string[]; delay?: number | null; length?: number; startTime?: string | null; endTime?: string | null }
    }
    const p = o.properties ?? {}
    const g = o.geometry
    let path: [number, number][] = []
    if (g?.type === 'Point' && Array.isArray(g.coordinates)) path = [g.coordinates as [number, number]]
    else if (g?.type === 'LineString' && Array.isArray(g.coordinates)) path = (g.coordinates as [number, number][]).filter(c => Array.isArray(c) && c.length >= 2)
    if (!path.length) continue
    const [lon, lat] = path[0]!
    if (typeof lon !== 'number' || typeof lat !== 'number') continue
    const t = (s: string | null | undefined) => (s ? Date.parse(s) || null : null)
    out.push({
      id: String(p.id ?? `${lon},${lat}`),
      lat,
      lon,
      path: path.length > 400 ? path.filter((_, i) => i % Math.ceil(path.length / 400) === 0) : path,
      kind: KIND[p.iconCategory ?? 0] ?? 'other',
      magnitude: typeof p.magnitudeOfDelay === 'number' ? p.magnitudeOfDelay : 0,
      description: (p.events ?? []).map(e => e.description).filter(Boolean).join(', ') || 'Incident',
      from: p.from ?? '',
      to: p.to ?? '',
      road: (p.roadNumbers ?? []).join(', '),
      delay: typeof p.delay === 'number' ? p.delay : 0,
      length: typeof p.length === 'number' ? p.length : 0,
      start: t(p.startTime),
      end: t(p.endTime),
    })
  }
  return out
}

export const INCIDENT_FIELDS = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description},startTime,endTime,from,to,length,delay,roadNumbers}}}'

/** Incident Details asks for at most 10,000 km²: shrink a box around its centre to fit. */
export const fitIncidentBox = (b: Box): Box => {
  const cLat = (b.south + b.north) / 2
  const cLon = (b.west + b.east) / 2
  const kmLat = (b.north - b.south) * 111
  const kmLon = (b.east - b.west) * 111 * Math.cos((cLat * Math.PI) / 180)
  const area = kmLat * kmLon
  if (area <= 9_500) return b
  const k = Math.sqrt(9_500 / area)
  const hLat = ((b.north - b.south) / 2) * k
  const hLon = ((b.east - b.west) / 2) * k
  return { west: cLon - hLon, east: cLon + hLon, south: cLat - hLat, north: cLat + hLat }
}
