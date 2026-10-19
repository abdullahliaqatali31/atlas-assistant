/**
 * The assistant drives the World map (plan §4.5): fly somewhere, change the
 * style, show or hide layers, find and focus an item, drop pins, go back,
 * and read what is on screen. Every op only changes the view, never the
 * owner's data or the outside world. Runtime tool → host → main → page;
 * the page answers in text the model can relay.
 */

/** Mirrors the renderer's layer registry (a test keeps them equal). */
export const MAP_LAYERS = ['places', 'quakes', 'events', 'flights', 'ships', 'satellites', 'cameras', 'pins', 'story', 'disasters', 'news', 'rain', 'launches', 'radio'] as const
export type MapLayer = (typeof MAP_LAYERS)[number]

export const MAP_STYLES = ['satellite', 'today', 'relief', 'dark', 'light'] as const
export type MapStyle = (typeof MAP_STYLES)[number]

export interface Pin {
  lat: number
  lon: number
  label: string
  note?: string | undefined
}

/** One news item placed where it happens, in the order the assistant tells it. */
export interface StoryItem {
  lat: number
  lon: number
  /** Short headline. */
  label: string
  /** One or two sentences in the owner's language. */
  summary?: string | undefined
  /** Outlet or feed name. */
  source?: string | undefined
  url?: string | undefined
  /** Where it is, as said ("Gaza", "Strait of Hormuz"). */
  place?: string | undefined
  /** 0-10, how much it matters; bigger markers for bigger stories. */
  severity?: number | undefined
}

/** Why two story items are joined by a line. */
export interface StoryLink {
  /** 1-based item numbers. */
  from: number
  to: number
  reason?: string | undefined
}

export interface Story {
  title: string
  items: StoryItem[]
  links: StoryLink[]
}

export const MAX_STORY_ITEMS = 20

/** The 3D view's layers (its own rail), and what the assistant can do there. */
export const GLOBE3D_LAYERS = ['flights', 'ships', 'sats', 'cameras', 'cables', 'celestial'] as const
export type Globe3dLayer = (typeof GLOBE3D_LAYERS)[number]
export const GLOBE3D_ACTIONS = ['open', 'close', 'layers', 'fly_with', 'next_contact', 'follow_sat', 'camera', 'orbit', 'stop', 'state'] as const
export type Globe3dAction = (typeof GLOBE3D_ACTIONS)[number]

export interface Map3dOp {
  kind: '3d'
  action: Globe3dAction
  lat?: number | undefined
  lon?: number | undefined
  zoom?: number | undefined
  label?: string | undefined
  /** A callsign, satellite or camera name; "nearest" for the closest one. */
  query?: string | undefined
  /** fly_with: chase | cockpit; follow_sat: follow | eye. */
  mode?: 'chase' | 'cockpit' | 'follow' | 'eye' | undefined
  show: Globe3dLayer[]
  hide: Globe3dLayer[]
  /** next_contact: 1 next, -1 previous. orbit: 1 on, 0 off. */
  direction?: number | undefined
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
  | { kind: 'story'; story: Story | null }
  | { kind: 'tour'; action: 'play' | 'stop'; secondsEach: number }
  | Map3dOp

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
const layers3d = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is Globe3dLayer => (GLOBE3D_LAYERS as readonly unknown[]).includes(x)))] : [])

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

const httpsUrl = (v: unknown) => {
  const u = text(v, 500)
  return u && /^https:\/\/[^\s]+$/.test(u) ? u : undefined
}

/** A story from tool input: items need a real coordinate (the runtime resolves place names first). */
export const parseStory = (input: Record<string, unknown>): Story => {
  const title = text(input.title, 100) ?? 'News on the map'
  const raw = Array.isArray(input.items) ? input.items : []
  const items: StoryItem[] = []
  for (const r of raw.slice(0, MAX_STORY_ITEMS)) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const lat = num(o.lat, -90, 90)
    const lon = num(o.lon, -180, 180)
    const label = text(o.label, 140)
    if (lat === undefined || lon === undefined || !label) continue
    items.push({ lat, lon, label, summary: text(o.summary, 400), source: text(o.source, 80), url: httpsUrl(o.url), place: text(o.place, 80), severity: num(o.severity, 0, 10) })
  }
  if (!items.length) throw new Error('A story needs items, each with a label and either lat/lon or a place name.')
  const links: StoryLink[] = []
  for (const r of Array.isArray(input.links) ? input.links : []) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const from = num(o.from, 1, items.length)
    const to = num(o.to, 1, items.length)
    if (from === undefined || to === undefined || from === to || !Number.isInteger(from) || !Number.isInteger(to)) continue
    if (links.some(l => (l.from === from && l.to === to) || (l.from === to && l.to === from))) continue
    links.push({ from, to, reason: text(o.reason, 120) })
  }
  return { title, items, links: links.slice(0, 40) }
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
    case 'map_story': {
      if (input.clear === true && input.items === undefined) return { kind: 'story', story: null }
      return { kind: 'story', story: parseStory(input) }
    }
    case 'map_3d': {
      const action = (GLOBE3D_ACTIONS as readonly unknown[]).includes(input.action) ? (input.action as Globe3dAction) : undefined
      if (!action) throw new Error(`Say the action: ${GLOBE3D_ACTIONS.join(', ')}.`)
      const lat = num(input.lat, -90, 90)
      const lon = num(input.lon, -180, 180)
      if ((lat === undefined) !== (lon === undefined)) throw new Error('Give both lat and lon, or a place name.')
      const show = layers3d(input.show)
      const hide = layers3d(input.hide).filter(l => !show.includes(l))
      if (action === 'layers' && !show.length && !hide.length) throw new Error(`Name 3D layers to show or hide: ${GLOBE3D_LAYERS.join(', ')}.`)
      const query = text(input.query, 60)
      if (action === 'follow_sat' && !query) throw new Error('Which satellite? A name such as "ISS", "Hubble" or "GPS".')
      const mode = (['chase', 'cockpit', 'follow', 'eye'] as const).find(m => m === input.mode)
      return { kind: '3d', action, lat, lon, zoom: num(input.zoom, 0, 20), label: text(input.label, 80), query, mode, show, hide, direction: action === 'next_contact' ? (input.previous === true ? -1 : 1) : action === 'orbit' ? (input.on === false ? 0 : 1) : undefined }
    }
    case 'map_tour': {
      const action = input.action === 'stop' ? 'stop' : 'play'
      return { kind: 'tour', action, secondsEach: num(input.seconds_each, 3, 30) ?? 7 }
    }
  }
  throw new Error(`Unknown map tool ${tool}.`)
}
