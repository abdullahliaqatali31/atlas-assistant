/**
 * Atlas's own window: which page is showing, whether the conversation is
 * open, compact mode, the window size, and the commands Atlas (or the owner)
 * uses to change them. The page reports its part; main owns the window.
 */
import type { GlassOp } from './glass.ts'
import type { MapOp } from './map.ts'
import type { SystemOp } from './system.ts'

export const VIEWS = ['home', 'world', 'alerts', 'today', 'news', 'projects', 'files', 'apps', 'learning', 'controls', 'setup'] as const
export type View = (typeof VIEWS)[number]

export const VIEW_LABEL: Record<View, string> = {
  home: 'Home',
  world: 'World',
  alerts: 'Alerts (the last 24 hours)',
  today: 'Today',
  news: 'News',
  projects: 'Projects',
  files: 'Files',
  apps: 'Apps',
  learning: 'Learning',
  controls: 'Connections and permissions',
  setup: 'Setup and personality',
}

/** Window sizes Atlas can pick: compact is a small chat-only window. */
export const WINDOW_SIZES = ['compact', 'normal', 'large', 'maximized', 'minimized'] as const
export type WindowSize = (typeof WINDOW_SIZES)[number]

/** How the page lays itself out at the current width. */
export type Layout = 'phone' | 'narrow' | 'wide' | 'ultrawide'

export const layoutFor = (width: number): Layout => (width < 640 ? 'phone' : width < 1100 ? 'narrow' : width < 1600 ? 'wide' : 'ultrawide')

/** What the page reports. */
export interface PageUi {
  view: View
  chatOpen: boolean
  compact: boolean
}

export interface UiState extends PageUi {
  width: number
  height: number
  layout: Layout
  maximized: boolean
  minimized: boolean
  /** The window is open (not only in the tray). */
  visible: boolean
  focused: boolean
  /** Kept above other windows. */
  pinned: boolean
}

/** A change to the window; anything left out stays as it is. */
export interface UiChange {
  view?: View | undefined
  chat?: boolean | undefined
  size?: WindowSize | undefined
  pinned?: boolean | undefined
  /** Bring the window to the front, over other apps. */
  front?: boolean | undefined
}

/** The model's window tools; map ops drive the World map (shared/map.ts). */
export type UiOp = { kind: 'state' } | { kind: 'set'; change: UiChange } | { kind: 'map'; op: MapOp } | { kind: 'glass'; op: GlassOp } | { kind: 'system'; op: SystemOp }

/** Page-side commands main sends (view, chat, compact). */
export interface PageCommand {
  view?: View | undefined
  chat?: boolean | undefined
  compact?: boolean | undefined
  /** Open the News page on this tab, scrolled to this story (from the glass panel). */
  news?: { tab: string; focus: string | null } | undefined
}

export const UC = {
  report: 'ui:report',
  command: 'ui:command',
  set: 'ui:set',
  state: 'ui:state',
} as const

export interface UiBridge {
  /** The page tells main what it shows. */
  report(state: PageUi): void
  onCommand(cb: (c: PageCommand) => void): () => void
  /** The owner's own buttons (compact, pin) go through the same path as Atlas's. */
  set(change: UiChange): Promise<UiState>
  state(): Promise<UiState>
}

export const isView = (v: unknown): v is View => (VIEWS as readonly unknown[]).includes(v)
export const isWindowSize = (v: unknown): v is WindowSize => (WINDOW_SIZES as readonly unknown[]).includes(v)

export const parseUiChange = (v: unknown): UiChange | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const change: UiChange = {}
  if (o.view !== undefined) {
    if (!isView(o.view)) return null
    change.view = o.view
  }
  if (o.chat !== undefined) {
    if (typeof o.chat !== 'boolean') return null
    change.chat = o.chat
  }
  if (o.size !== undefined) {
    if (!isWindowSize(o.size)) return null
    change.size = o.size
  }
  if (o.front !== undefined) {
    if (typeof o.front !== 'boolean') return null
    change.front = o.front
  }
  if (o.pinned !== undefined) {
    if (typeof o.pinned !== 'boolean') return null
    change.pinned = o.pinned
  }
  return change
}

/** The window described for the model, in plain words. */
export const describeUi = (s: UiState): string => {
  if (!s.visible) return 'Atlas’s window is closed (only the tray icon is showing).'
  const parts = [
    s.compact ? 'Compact mode: a small chat-only window' : `Showing ${VIEW_LABEL[s.view]}`,
    s.compact ? '' : s.chatOpen ? 'conversation open' : 'conversation hidden',
    s.minimized ? 'minimized' : s.maximized ? 'maximized' : `${s.width}×${s.height} (${s.layout} layout)`,
    s.pinned ? 'kept on top of other windows' : '',
    s.focused ? 'in front' : 'behind other windows',
  ]
  return `${parts.filter(Boolean).join('; ')}.`
}
