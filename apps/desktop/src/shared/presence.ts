/**
 * Atlas's presence outside the main window: a small always-on-top desktop
 * widget that shows what Atlas is doing (a dot when idle, a pill with a
 * caption while listening, thinking or speaking, a card when it speaks up or
 * needs a yes) and lets the owner stop it, answer, or open Atlas.
 *
 * The widget's page is sandboxed like the main window and gets only this
 * state and these few commands; main validates every one.
 */

export type PresenceActivity = 'idle' | 'listening' | 'thinking' | 'speaking'

/** When the desktop widget shows: never, while Atlas's window is out of sight, or always. */
export type WidgetWhen = 'off' | 'background' | 'always'
export const WIDGET_WHEN: readonly WidgetWhen[] = ['off', 'background', 'always']
export type WidgetScale = 's' | 'm' | 'l'
export const WIDGET_SCALES: readonly WidgetScale[] = ['s', 'm', 'l']

export type PresenceCard =
  | { kind: 'initiative'; id: string; text: string; canMute: boolean }
  | { kind: 'approval'; id: string; tool: string; summary: string }
  /** Something is waiting but the owner check is on: say so, show nothing private. */
  | { kind: 'locked' }

export interface PresenceState {
  activity: PresenceActivity
  /** The newest words: what Atlas is saying, or what it heard. Empty when idle. */
  caption: string
  /** Microphone or voice level, 0 to 1. */
  level: number
  card: PresenceCard | null
  name: string
  scale: WidgetScale
  /** The glass panel is open beside it: stay a compact orb (it shows what Atlas is doing). */
  glass: boolean
  /** Full control is on: an amber ring, so it is never on unnoticed. */
  fullControl: boolean
}

/** What the main window's conversation reports; main adds the card, name and scale. */
export interface PresenceUpdate {
  activity: PresenceActivity
  caption: string
  level: number
}

export const PRS = {
  /** Main window → main: what the conversation is doing. */
  update: 'presence:update',
  /** Main → main window: the widget asked to stop or to talk. */
  command: 'presence:command',
  /** Main window ↔ main: the widget setting. */
  getWhen: 'presence:get-when',
  setWhen: 'presence:set-when',
  /** Main → widget. */
  state: 'presence:state',
  /** Widget → main. */
  stop: 'presence:stop',
  talk: 'presence:talk',
  open: 'presence:open',
  resize: 'presence:resize',
  menu: 'presence:menu',
  initiative: 'presence:initiative',
  approval: 'presence:approval',
  /** Widget → main: the owner pressed and moved; main moves the window with the cursor until released. */
  dragStart: 'presence:drag-start',
  dragEnd: 'presence:drag-end',
} as const

export type PresenceCommand = 'stop' | 'talk'

/** The widget page's bridge (window.presence). */
export interface PresenceBridge {
  onState(cb: (s: PresenceState) => void): () => void
  stop(): Promise<void>
  talk(): Promise<void>
  open(): Promise<void>
  menu(): Promise<void>
  resize(width: number, height: number): Promise<void>
  approval(id: string, approved: boolean): Promise<void>
  initiative(id: string, action: 'snooze' | 'mute' | 'dismiss'): Promise<void>
  dragStart(): Promise<void>
  dragEnd(): Promise<void>
}

/** The main window's side (window.presenceHost): report what the conversation does, hear the widget's asks, the setting. */
export interface PresenceHostBridge {
  update(u: PresenceUpdate): Promise<void>
  onCommand(cb: (c: PresenceCommand) => void): () => void
  when(): Promise<WidgetWhen>
  setWhen(when: WidgetWhen): Promise<WidgetWhen>
}

const ACTIVITIES: readonly PresenceActivity[] = ['idle', 'listening', 'thinking', 'speaking']

export const parsePresenceUpdate = (v: unknown): PresenceUpdate | null => {
  const o = v as Partial<PresenceUpdate> | null
  if (!o || typeof o !== 'object' || !ACTIVITIES.includes(o.activity as PresenceActivity)) return null
  const level = typeof o.level === 'number' && Number.isFinite(o.level) ? Math.max(0, Math.min(1, o.level)) : 0
  return { activity: o.activity as PresenceActivity, caption: typeof o.caption === 'string' ? o.caption.slice(-600) : '', level }
}

/** The widget's page measures itself; main keeps it within these bounds. */
export const WIDGET_LIMITS = { minWidth: 48, maxWidth: 440, minHeight: 48, maxHeight: 460 } as const

export const parseWidgetSize = (w: unknown, h: unknown): { width: number; height: number } | null => {
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return null
  return {
    width: Math.round(Math.max(WIDGET_LIMITS.minWidth, Math.min(WIDGET_LIMITS.maxWidth, w))),
    height: Math.round(Math.max(WIDGET_LIMITS.minHeight, Math.min(WIDGET_LIMITS.maxHeight, h))),
  }
}

type Rect = { x: number; y: number; width: number; height: number }

/**
 * The widget's new bounds when its size changes: it grows away from the
 * screen edge it sits near (a widget in the bottom-right corner grows up and
 * to the left), so the corner the owner put it in stays put, and it never
 * leaves the work area.
 */
export const growFrom = (prev: Rect, size: { width: number; height: number }, area: Rect): Rect => {
  const rightHalf = prev.x + prev.width / 2 > area.x + area.width / 2
  const bottomHalf = prev.y + prev.height / 2 > area.y + area.height / 2
  let x = rightHalf ? prev.x + prev.width - size.width : prev.x
  let y = bottomHalf ? prev.y + prev.height - size.height : prev.y
  x = Math.max(area.x, Math.min(area.x + area.width - size.width, x))
  y = Math.max(area.y, Math.min(area.y + area.height - size.height, y))
  return { x, y, width: size.width, height: size.height }
}

/** Where the widget first appears: the bottom-right corner, above the taskbar. */
export const startBounds = (area: Rect, size: { width: number; height: number }, margin = 24): Rect => ({
  x: area.x + area.width - size.width - margin,
  y: area.y + area.height - size.height - margin,
  ...size,
})

/** Whether the widget should be on screen now. */
/** Where Atlas's own window is: in front (focused), open behind other apps, or away (minimised, hidden, closed). */
export type MainWindowState = 'front' | 'open' | 'away'

/**
 * The widget never sits beside Atlas's window while it is in front: it steps
 * in when the window is away ("background"), or also when it is behind other
 * apps ("always").
 */
export const widgetVisible = (when: WidgetWhen, main: MainWindowState) => when !== 'off' && main !== 'front' && (when === 'always' || main === 'away')
