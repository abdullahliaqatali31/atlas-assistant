/**
 * The assistant drives the World map (plan §4.5): fly somewhere, change the
 * style, show or hide layers, find and focus an item, drop pins, go back,
 * and read what is on screen. Every op only changes the view, never the
 * owner's data or the outside world. Runtime tool → host → main → page;
 * the page answers in text the model can relay.
 */

/** Mirrors the renderer's layer registry (a test keeps them equal). */
export const MAP_LAYERS = ['places', 'quakes', 'events', 'flights', 'ships', 'satellites', 'cameras', 'pins'] as const
export type MapLayer = (typeof MAP_LAYERS)[number]

export const MAP_STYLES = ['satellite', 'today', 'relief', 'dark', 'light'] as const
export type MapStyle = (typeof MAP_STYLES)[number]

export interface Pin {
  lat: number
  lon: number
  label: string
  note?: string | undefined
}

export type MapOp =
  | { kind: 'view'; lat?: number | undefined; lon?: number | undefined; zoom?: number | undefined; label?: string | undefined; style?: MapStyle | undefined; globe?: boolean | undefined }
  | { kind: 'layers'; show: MapLayer[]; hide: MapLayer[] }
  | { kind: 'visible' }
  | { kind: 'find'; query: string; layers: MapLayer[] }
  | { kind: 'focus'; query?: string | undefined; lat?: number | undefined; lon?: number | undefined; zoom?: number | undefined; label?: string | undefined }
  | { kind: 'clear-selection' }
  | { kind: 'pins'; add: Pin[]; clear: boolean }
  | { kind: 'back' }

export const MC = {
  op: 'map:op',
  result: 'map:result',
} as const

export interface MapOpRequest {
  requestId: string
  op: MapOp
}

/** Exposed by the preload as `window.mapOps`. */
export interface MapOpsBridge {
  onOp(cb: (r: MapOpRequest) => void): () => void
  reply(requestId: string, result?: string, error?: string): void
}

const isLayer = (v: unknown): v is MapLayer => (MAP_LAYERS as readonly unknown[]).includes(v)
const isStyle = (v: unknown): v is MapStyle => (MAP_STYLES as readonly unknown[]).includes(v)
const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined)
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
const layers = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter(isLayer))] : [])

export const MAX_PINS = 40

/** A pin from tool input, or null when its place is not a real coordinate. */
export const parsePin = (v: unknown): Pin | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const lat = num(o.lat, -90, 90)
  const lon = num(o.lon, -180, 180)
  const label = text(o.label, 80)
  if (lat === undefined || lon === undefined || !label) return null
  return { lat, lon, label, note: text(o.note, 240) }
}

/** Builds and checks one map op from a map_* tool's input. Errors are written for the model. */
export const mapOpFromTool = (tool: string, input: Record<string, unknown>): MapOp => {
  switch (tool) {
    case 'map_view': {
      const lat = num(input.lat, -90, 90)
      const lon = num(input.lon, -180, 180)
      if ((lat === undefined) !== (lon === undefined)) throw new Error('Give both lat and lon, or a place name.')
      const op: MapOp = { kind: 'view', lat, lon, zoom: num(input.zoom, 0, 20), label: text(input.label, 80), style: isStyle(input.style) ? input.style : undefined, globe: typeof input.globe === 'boolean' ? input.globe : undefined }
      if (op.lat === undefined && op.style === undefined && op.globe === undefined && op.zoom === undefined) throw new Error('Say where to go (place or lat/lon), a zoom, a style or globe.')
      return op
    }
    case 'map_layers': {
      const show = layers(input.show)
      const hide = layers(input.hide).filter(l => !show.includes(l))
      if (!show.length && !hide.length) throw new Error(`Name layers to show or hide: ${MAP_LAYERS.join(', ')}.`)
      return { kind: 'layers', show, hide }
    }
    case 'map_visible':
      return { kind: 'visible' }
    case 'map_find': {
      const query = text(input.query, 80)
      if (!query) throw new Error('What should I look for?')
      return { kind: 'find', query, layers: layers(input.layers) }
    }
    case 'map_focus': {
      if (input.clear === true) return { kind: 'clear-selection' }
      const lat = num(input.lat, -90, 90)
      const lon = num(input.lon, -180, 180)
      const query = text(input.query, 80)
      if (!query && (lat === undefined || lon === undefined)) throw new Error('Say what to focus on: a query (a place, flight, ship, camera, event or pin on the map) or lat and lon.')
      return { kind: 'focus', query, lat, lon, zoom: num(input.zoom, 0, 20), label: text(input.label, 80) }
    }
    case 'map_pins': {
      const raw = Array.isArray(input.add) ? input.add : []
      const add = raw.map(parsePin).filter((p): p is Pin => p !== null).slice(0, MAX_PINS)
      if (raw.length && !add.length) throw new Error('Each pin needs lat, lon and a label.')
      const clear = input.clear === true
      if (!add.length && !clear) throw new Error('Add pins (lat, lon, label) or clear them.')
      return { kind: 'pins', add, clear }
    }
    case 'map_back':
      return { kind: 'back' }
  }
  throw new Error(`Unknown map tool ${tool}.`)
}
