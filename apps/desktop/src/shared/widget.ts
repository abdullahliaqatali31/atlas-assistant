/**
 * The desktop widget: Atlas outside the browser, always within reach. A
 * small glass window (WebView2 on Windows) with four sizes: the orb alone,
 * a bar (orb, what was said, a box to type), the chat, and the glass (a
 * Jarvis-style panel: clock, what is next, the displays). Atlas moves it
 * between displays, and it follows a newly connected display when asked to.
 * Placement is worked out here, in plain numbers, and tested.
 */

export type WidgetMode = 'orb' | 'bar' | 'chat' | 'glass'
export const WIDGET_MODES: readonly WidgetMode[] = ['orb', 'bar', 'chat', 'glass']

export type Corner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center'
export const CORNERS: readonly Corner[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center']

/** One display as Windows sees it: whole area, the part not under the taskbar, physical pixels, and its scale. */
export interface DisplayInfo {
  id: string
  /** The monitor's own name ("DELL U2723QE"), or Windows' generic one. */
  name: string
  primary: boolean
  x: number
  y: number
  w: number
  h: number
  wx: number
  wy: number
  ww: number
  wh: number
  scale: number
}

export interface WidgetSettings {
  enabled: boolean
  /** Above other windows. */
  onTop: boolean
  /** A newly connected display: the widget glides to it and shows it. */
  followNewDisplays: boolean
  mode: WidgetMode
  /** Where it lives: a display (its id, with its name to find it again) and a corner. */
  display: { id: string; name: string } | null
  corner: Corner
  /**
   * Where the owner put it by dragging: how far across and down the display's free space it sits
   * (0 left/top … 1 right/bottom). It keeps that spot as it grows or shrinks; a corner clears it.
   */
  at: { x: number; y: number } | null
  /** clear: only Atlas floats over the desktop; frosted: blurred glass behind it (Windows 11). */
  look: WidgetLook
}

export type WidgetLook = 'clear' | 'frosted'

export const DEFAULT_WIDGET: WidgetSettings = { enabled: true, onTop: true, followNewDisplays: true, mode: 'bar', display: null, corner: 'bottom-right', at: null, look: 'clear' }

export interface WidgetView extends WidgetSettings {
  /** This computer can show it (Windows with WebView2). */
  available: boolean
  running: boolean
  /** Windows 11's acrylic glass is behind it (else the page draws its own background). */
  acrylic: boolean
  displays: DisplayInfo[]
  /** The display it is on now. */
  on: string | null
  /** A display that just connected, shown as a card for a few seconds. */
  announce: DisplayInfo | null
  error: string | null
}

/** Each mode's size in CSS pixels (times the display's scale on screen). */
export const WIDGET_SIZE: Record<WidgetMode, { w: number; h: number }> = {
  orb: { w: 132, h: 132 },
  bar: { w: 460, h: 148 },
  chat: { w: 420, h: 620 },
  glass: { w: 900, h: 600 },
}

/**
 * Where the widget goes on a display: inside its work area (never under the taskbar), a margin from
 * the edges; at the owner's own spot (`at`) when there is one, else in the corner.
 */
export const placeWidget = (d: DisplayInfo, mode: WidgetMode, corner: Corner, at: { x: number; y: number } | null = null, margin = 16) => {
  const size = WIDGET_SIZE[mode]
  const w = Math.min(Math.round(size.w * d.scale), d.ww - 2 * margin)
  const h = Math.min(Math.round(size.h * d.scale), d.wh - 2 * margin)
  const m = Math.round(margin * d.scale)
  const left = d.wx + m
  const right = d.wx + d.ww - w - m
  const top = d.wy + m
  const bottom = d.wy + d.wh - h - m
  const spot = at
  const place: Record<Corner, [number, number]> = {
    'top-left': [left, top],
    'top-right': [right, top],
    'bottom-left': [left, bottom],
    'bottom-right': [right, bottom],
    center: [d.wx + Math.round((d.ww - w) / 2), d.wy + Math.round((d.wh - h) / 2)],
  }
  if (spot) {
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    return { x: Math.round(left + clamp(spot.x) * (right - left)), y: Math.round(top + clamp(spot.y) * (bottom - top)), w, h }
  }
  const [x, y] = place[corner]
  return { x, y, w, h }
}

/** The spot a dragged window is in, as `at` for its display (the inverse of placeWidget). */
export const spotOf = (d: DisplayInfo, r: { x: number; y: number; w: number; h: number }, margin = 16) => {
  const m = Math.round(margin * d.scale)
  const free = (span: number, size: number) => Math.max(1, span - size - 2 * m)
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
  return { x: clamp((r.x - d.wx - m) / free(d.ww, r.w)), y: clamp((r.y - d.wy - m) / free(d.wh, r.h)) }
}

/** "DELL U2723QE · 2560×1440" (or "Display 2 · …" when it has no name of its own). */
export const displayLabel = (d: DisplayInfo, list: DisplayInfo[]) => {
  const n = list.findIndex(x => x.id === d.id) + 1
  const generic = !d.name || /generic|pnp|default monitor/i.test(d.name)
  return `${generic ? `Display ${n}` : d.name}${d.primary ? ' (main)' : ''} · ${d.w}×${d.h}`
}

/**
 * Which display a request means: "primary"/"main", "new"/"latest" (the one that connected last),
 * "left"/"right"/"other"/"next", a number (1 is the leftmost), or part of its name.
 */
export const pickDisplay = (list: DisplayInfo[], want: string, current: string | null, newest: string | null): DisplayInfo | null => {
  if (!list.length) return null
  const byX = [...list].sort((a, b) => a.x - b.x || a.y - b.y)
  const w = want.trim().toLowerCase()
  const cur = list.find(d => d.id === current) ?? list.find(d => d.primary) ?? byX[0]!
  if (!w || w === 'here' || w === 'current') return cur
  if (/^(primary|main|laptop|built-?in)$/.test(w)) return list.find(d => d.primary) ?? byX[0]!
  if (/^(new|newest|latest|external|connected)$/.test(w)) return list.find(d => d.id === newest) ?? list.find(d => !d.primary) ?? null
  if (/^(left|leftmost)$/.test(w)) return byX[0]!
  if (/^(right|rightmost)$/.test(w)) return byX[byX.length - 1]!
  if (/^(other|next|another|second screen|dusri|doosri)$/.test(w)) return byX[(byX.indexOf(cur) + 1) % byX.length]!
  if (/^\d+$/.test(w)) return byX[Number(w) - 1] ?? null
  return list.find(d => d.name.toLowerCase().includes(w) || d.id.toLowerCase() === w) ?? null
}

/** What the model or the page asks of the widget. */
export type WidgetOp =
  | { kind: 'state' }
  | { kind: 'show' }
  | { kind: 'hide' }
  | { kind: 'mode'; mode: WidgetMode }
  | { kind: 'move'; display?: string | undefined; corner?: Corner | undefined }
  | { kind: 'pin'; on: boolean }
  /** Bring up the full Atlas (the page in the browser). */
  | { kind: 'open-atlas' }

export const WGC = {
  get: 'widget:get',
  set: 'widget:set',
  op: 'widget:op',
  changed: 'widget:changed',
} as const

export const parseWidgetSettings = (v: unknown): Partial<WidgetSettings> | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const out: Partial<WidgetSettings> = {}
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  if (typeof o.onTop === 'boolean') out.onTop = o.onTop
  if (typeof o.followNewDisplays === 'boolean') out.followNewDisplays = o.followNewDisplays
  if (typeof o.mode === 'string' && (WIDGET_MODES as readonly string[]).includes(o.mode)) out.mode = o.mode as WidgetMode
  if (typeof o.corner === 'string' && (CORNERS as readonly string[]).includes(o.corner)) out.corner = o.corner as Corner
  if (o.look === 'clear' || o.look === 'frosted') out.look = o.look
  return Object.keys(out).length ? out : null
}

export const parseWidgetOp = (v: unknown): WidgetOp | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  switch (o.kind) {
    case 'state':
    case 'show':
    case 'hide':
    case 'open-atlas':
      return { kind: o.kind }
    case 'mode':
      return typeof o.mode === 'string' && (WIDGET_MODES as readonly string[]).includes(o.mode) ? { kind: 'mode', mode: o.mode as WidgetMode } : null
    case 'move': {
      const corner = typeof o.corner === 'string' && (CORNERS as readonly string[]).includes(o.corner) ? (o.corner as Corner) : undefined
      const display = typeof o.display === 'string' && o.display.length <= 60 ? o.display : undefined
      return { kind: 'move', display, corner }
    }
    case 'pin':
      return typeof o.on === 'boolean' ? { kind: 'pin', on: o.on } : null
    default:
      return null
  }
}

export interface WidgetBridge {
  get(): Promise<WidgetView>
  set(change: Partial<WidgetSettings>): Promise<WidgetView>
  op(op: WidgetOp): Promise<string>
  onChanged(cb: (v: WidgetView) => void): () => void
}
