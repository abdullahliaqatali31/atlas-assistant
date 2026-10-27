/**
 * The glass panel: a floating acrylic panel beside the desktop widget where
 * Atlas shows what the owner asked for without opening its main window:
 * today's news, one story in full (with its picture), a map of a place, or a
 * short note. "Side pe karo" puts it away and the widget is small again.
 *
 * The model asks with glass_show / glass_close (through the window's `ui`
 * requests); main fills news from its own feeds, so the model never has to
 * copy headlines, and validates everything the model sends.
 */
import { CATEGORIES, type Category, type Headline } from './news.ts'
import type { Camera, FlightsArea, GeoBox, SatelliteElements, ShipsResult, WorldSnapshot } from './world.ts'

export const MAX_GLASS_NEWS = 8
export const MAX_GLASS_PINS = 12

export interface GlassPin {
  lat: number
  lon: number
  label: string
}

export type GlassView =
  | { kind: 'news'; title: string; items: Headline[]; category: Category | null }
  | { kind: 'story'; item: Headline; n: number | null; of: number | null }
  | { kind: 'map'; title: string; lat: number; lon: number; zoom: number; pins: GlassPin[] }
  | { kind: 'note'; title: string; text: string }
  | { kind: 'files'; title: string; items: GlassFile[] }

/** A file found on the PC, as the glass panel shows it. */
export interface GlassFile {
  path: string
  name: string
  folder: string
  modified: number | null
  size: number
  kind: string
  /** A Windows thumbnail (data URL) for the first few. */
  thumb: string | null
}

/** What the model asks for. */
export type GlassOp =
  | { kind: 'news'; category: Category | null; query: string }
  | { kind: 'story'; n: number | null; query: string }
  | { kind: 'map'; title: string; lat: number; lon: number; zoom: number; pins: GlassPin[] }
  | { kind: 'note'; title: string; text: string }
  | { kind: 'close' }
  | { kind: 'state' }

export const GLASS_VIEWS = ['news', 'story', 'map', 'note'] as const

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null)

/** glass_show's input (place names already turned into lat/lon by the runtime) → an op, or an error to tell the model. */
export const parseGlassShow = (input: Record<string, unknown>): GlassOp | string => {
  switch (input.view) {
    case 'news': {
      const category = CATEGORIES.includes(input.category as Category) ? (input.category as Category) : null
      return { kind: 'news', category, query: str(input.query, 60) }
    }
    case 'story': {
      const n = num(input.n, 1, MAX_GLASS_NEWS)
      const query = str(input.query, 80)
      if (n === null && !query) return 'Say which story: n (its number in the list on the glass panel) or a few words of its title as query.'
      return { kind: 'story', n: n === null ? null : Math.round(n), query }
    }
    case 'map': {
      const lat = num(input.lat, -90, 90)
      const lon = num(input.lon, -180, 180)
      if (lat === null || lon === null) return 'Give the place (place) or its lat and lon.'
      const pins = (Array.isArray(input.pins) ? input.pins : [])
        .slice(0, MAX_GLASS_PINS)
        .map(p => p as Record<string, unknown>)
        .map(p => ({ lat: num(p?.lat, -90, 90), lon: num(p?.lon, -180, 180), label: str(p?.label, 60) }))
        .filter((p): p is GlassPin => p.lat !== null && p.lon !== null)
      const title = str(input.title, 80) || str(input.label, 80)
      return { kind: 'map', title, lat, lon, zoom: num(input.zoom, 1, 16) ?? 9, pins: pins.length ? pins : [{ lat, lon, label: title }] }
    }
    case 'note': {
      const text = typeof input.text === 'string' ? input.text.trim().slice(0, 2000) : ''
      if (!text) return 'Give the text to show.'
      return { kind: 'note', title: str(input.title, 80), text }
    }
    default:
      return `view must be one of ${GLASS_VIEWS.join(', ')}.`
  }
}

/** The newest headlines for the panel: one category or all, optionally matching words. */
export const pickNews = (all: Headline[], category: Category | null, query: string): Headline[] => {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  return all
    .filter(h => !category || h.category === category)
    .filter(h => !words.length || words.some(w => `${h.title} ${h.summary}`.toLowerCase().includes(w)))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .slice(0, MAX_GLASS_NEWS)
}

/** "Number 2" or "the one about the flood": a story from the list on the panel, else from all headlines. */
export const pickStory = (list: Headline[], all: Headline[], n: number | null, query: string): { item: Headline; n: number | null } | null => {
  if (n !== null && list[n - 1]) return { item: list[n - 1]!, n }
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  if (!words.length) return null
  const score = (h: Headline) => words.filter(w => h.title.toLowerCase().includes(w)).length
  for (const pool of [list, all]) {
    const best = [...pool].sort((a, b) => score(b) - score(a))[0]
    if (best && score(best) > 0) return { item: best, n: list.indexOf(best) >= 0 ? list.indexOf(best) + 1 : null }
  }
  return null
}

/** What the model hears back: short, numbered, so "detail of 2" is easy. */
export const describeGlass = (v: GlassView | null): string => {
  if (!v) return 'The glass panel is closed.'
  switch (v.kind) {
    case 'news':
      return v.items.length ? `Showing on the glass panel: ${v.title}. ${v.items.map((h, i) => `${i + 1}. ${h.title} (${h.source})`).join(' ')}` : `No headlines for that right now; the panel says so.`
    case 'story':
      return `Showing story${v.n ? ` ${v.n}` : ''} in full on the glass panel: ${v.item.title} (${v.item.source}). ${v.item.summary}`
    case 'map':
      return `Showing a map of ${v.title || `${v.lat.toFixed(2)}, ${v.lon.toFixed(2)}`} on the glass panel${v.pins.length > 1 ? ` with ${v.pins.length} pins` : ''}.`
    case 'files':
      return `Showing ${v.items.length} file${v.items.length === 1 ? '' : 's'} on the glass panel: ${v.title}.`
    case 'note':
      return `Showing the note${v.title ? ` "${v.title}"` : ''} on the glass panel.`
  }
}

/** The panel's size for each view. */
export const GLASS_SIZE: Record<GlassView['kind'], { width: number; height: number }> = {
  // Room around the content for the neon glow.
  news: { width: 432, height: 600 },
  story: { width: 492, height: 680 },
  map: { width: 592, height: 472 },
  note: { width: 432, height: 372 },
  files: { width: 452, height: 620 },
}

type Rect = { x: number; y: number; width: number; height: number }

/**
 * Where the panel goes: beside the widget, on the side toward the middle of
 * the screen (a widget at the top right shows things to its left), lined up
 * with the widget's top edge in the top half of the screen and its bottom
 * edge in the bottom half. The panel narrows to the room on that side; only
 * when a side is too tight does it stack above or below the widget instead.
 * Without a widget: the bottom-right corner. Always inside the work area.
 */
export const panelBounds = (widget: Rect | null, size: { width: number; height: number }, area: Rect, gap = 12): Rect => {
  const height = Math.min(size.height, area.height - 2 * gap)
  const clampY = (y: number, h: number) => Math.max(area.y + gap, Math.min(area.y + area.height - h - gap, y))
  const clampX = (x: number, w: number) => Math.max(area.x + gap, Math.min(area.x + area.width - w - gap, x))
  if (!widget) {
    const width = Math.min(size.width, area.width - 2 * gap)
    return { x: clampX(area.x + area.width - width - gap, width), y: clampY(area.y + area.height - height - gap, height), width, height }
  }
  const rightHalf = widget.x + widget.width / 2 > area.x + area.width / 2
  const bottomHalf = widget.y + widget.height / 2 > area.y + area.height / 2
  const room = rightHalf ? widget.x - gap - (area.x + gap) : area.x + area.width - gap - (widget.x + widget.width + gap)
  const width = Math.min(size.width, room)
  if (width >= Math.min(size.width, 320)) {
    const x = rightHalf ? widget.x - gap - width : widget.x + widget.width + gap
    const y = bottomHalf ? widget.y + widget.height - height : widget.y
    return { x, y: clampY(y, height), width, height }
  }
  // Too tight beside it: above it (bottom half) or below it (top half), on its corner edge.
  const w = Math.min(size.width, area.width - 2 * gap)
  const h = Math.max(200, Math.min(height, bottomHalf ? widget.y - gap - (area.y + gap) : area.y + area.height - gap - (widget.y + widget.height + gap)))
  const x = rightHalf ? widget.x + widget.width - w : widget.x
  const y = bottomHalf ? widget.y - gap - h : widget.y + widget.height + gap
  return { x: clampX(x, w), y: clampY(y, h), width: w, height: h }
}

/** The panel's content hugs the edge nearest the widget: its top in the top half of the screen. */
export const panelAlign = (widget: Rect | null, area: Rect): GlassAlign => (widget && widget.y + widget.height / 2 < area.y + area.height / 2 ? 'top' : 'bottom')

export const GLS = {
  /** Main → panel: what to show. */
  view: 'glass:view',
  /** Panel → main. */
  close: 'glass:close',
  back: 'glass:back',
  story: 'glass:story',
  openLink: 'glass:open-link',
  /** Panel → main: open or reveal a file the panel is showing. */
  openFile: 'glass:open-file',
  revealFile: 'glass:reveal-file',
  /** Panel → main: the pointer is over something solid (true) or over see-through space (false). */
  hit: 'glass:hit',
  /** Panel → main: the World map's live layers, for the panel's map. */
  world: 'glass:world',
} as const

/** The live layers the panel's map can ask for. */
export type GlassWorldKind = 'state' | 'flights' | 'ships' | 'satellites' | 'cameras'

/** Which edge the panel's content hugs: the one nearest the widget. */
export type GlassAlign = 'top' | 'bottom'

/** The panel page's bridge (window.glass). */
export interface GlassBridge {
  onView(cb: (v: GlassView | null, align: GlassAlign) => void): () => void
  close(): Promise<void>
  /** From a story back to the list it came from. */
  back(): Promise<void>
  /** Open one story from the list. */
  story(n: number): Promise<void>
  openLink(url: string): Promise<void>
  openFile(path: string): Promise<void>
  revealFile(path: string): Promise<void>
  /** Clicks reach the panel only over its cards; elsewhere they fall through to the desktop. */
  hit(solid: boolean): void
  /** The World map's live data, the same as the app's own map uses. */
  world(kind: 'state'): Promise<WorldSnapshot>
  world(kind: 'flights', box: GeoBox): Promise<FlightsArea>
  world(kind: 'ships', box: GeoBox): Promise<ShipsResult>
  world(kind: 'satellites'): Promise<SatelliteElements[]>
  world(kind: 'cameras'): Promise<Camera[]>
}
