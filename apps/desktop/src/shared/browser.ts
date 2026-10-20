/**
 * Atlas's own browser, inside its window, and the window's panes. The
 * browser is a hardened <webview> in its own persistent session (so a login
 * stays logged in), shown as a pane beside another one, a mini view in the
 * corner, or the whole window. Atlas drives it with the browser tools: what
 * it reads there is untrusted, and clicking or typing after reading a page
 * asks the owner first (unless Full control is on).
 */

/** What a pane of the window can show. */
export const SURFACES = ['home', 'world', 'browser'] as const
export type Surface = (typeof SURFACES)[number]

export const SURFACE_LABEL: Record<Surface, string> = { home: 'Brain', world: 'World', browser: 'Browser' }

/** One pane, or two side by side (ratio is the first pane's share of the width). */
export interface StageLayout {
  main: Surface
  side: Surface | null
  ratio: number
}

export const isSurface = (v: unknown): v is Surface => (SURFACES as readonly unknown[]).includes(v)

/** Show a surface: in its pane if it is already showing, else in the focused pane. */
export const showSurface = (l: StageLayout, s: Surface, focused: 'main' | 'side' = 'main'): StageLayout => {
  if (l.main === s || l.side === s) return l
  return l.side && focused === 'side' ? { ...l, side: s } : { ...l, main: s }
}

/** Put a surface beside the main one (or close the second pane with null). */
export const setSide = (l: StageLayout, s: Surface | null): StageLayout => {
  if (s === null) return { ...l, side: null }
  if (s === l.main) return l.side ? { ...l, main: l.side, side: s } : { ...l, main: s === 'home' ? 'world' : 'home', side: s }
  return { ...l, side: s }
}

/** Take a surface out of the panes (the other one stays). */
export const dropSurface = (l: StageLayout, s: Surface): StageLayout => {
  if (l.side === s) return { ...l, side: null }
  if (l.main === s) return l.side ? { ...l, main: l.side, side: null } : { ...l, main: s === 'home' ? 'world' : 'home' }
  return l
}

export const clampRatio = (r: number) => Math.min(0.75, Math.max(0.25, Number.isFinite(r) ? r : 0.5))

/** pane: in one of the window's panes; mini: a small view in the corner; full: the whole window; hidden: kept alive out of sight. */
export const BROWSER_MODES = ['pane', 'mini', 'full', 'hidden'] as const
export type BrowserMode = (typeof BROWSER_MODES)[number]

export const BROWSER_PARTITION = 'persist:atlas-browser'
export const BROWSER_HOME = 'https://www.google.com/'

/** Typed words become a search; something that looks like an address becomes an https URL. Only web pages. */
export const toUrl = (input: string): string | null => {
  const s = input.trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).href
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/i.test(s)) return null
  if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

/** The model's browser requests. */
export type BrowserOp =
  | { kind: 'open'; target: string }
  | { kind: 'read' }
  | { kind: 'click'; n?: number | undefined; text?: string | undefined }
  | { kind: 'type'; n?: number | undefined; text: string; enter?: boolean | undefined }
  | { kind: 'key'; key: BrowserKey }
  | { kind: 'scroll'; dir: 'up' | 'down' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'view'; mode: BrowserMode }
  | { kind: 'state' }

export const BROWSER_KEYS = ['Enter', 'Tab', 'Escape', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Backspace'] as const
export type BrowserKey = (typeof BROWSER_KEYS)[number]

export const BROWSER_LOOK_ACTIONS = ['open', 'read', 'scroll', 'back', 'forward', 'view', 'state'] as const
export const BROWSER_ACT_ACTIONS = ['click', 'type', 'key'] as const

/** The browser tools' input, checked. */
export const browserOpFromTool = (tool: 'browser' | 'browser_act', input: Record<string, unknown>): BrowserOp | string => {
  const action = input.action
  const n = typeof input.n === 'number' && Number.isInteger(input.n) && input.n > 0 ? input.n : undefined
  const text = typeof input.text === 'string' ? input.text.slice(0, 2000) : undefined
  if (tool === 'browser') {
    switch (action) {
      case 'open': {
        const target = typeof input.url === 'string' ? input.url : typeof input.query === 'string' ? input.query : ''
        return target.trim() ? { kind: 'open', target: target.slice(0, 2000) } : 'Give a url or a query to open.'
      }
      case 'read':
      case 'back':
      case 'forward':
      case 'state':
        return { kind: action }
      case 'scroll':
        return { kind: 'scroll', dir: input.dir === 'up' ? 'up' : 'down' }
      case 'view':
        return (BROWSER_MODES as readonly unknown[]).includes(input.mode) ? { kind: 'view', mode: input.mode as BrowserMode } : `mode must be one of ${BROWSER_MODES.join(', ')}.`
      default:
        return `action must be one of ${BROWSER_LOOK_ACTIONS.join(', ')}.`
    }
  }
  switch (action) {
    case 'click':
      return n || text ? { kind: 'click', n, text } : 'Say what to click: n (its number from read) or text (its words).'
    case 'type':
      return text !== undefined ? { kind: 'type', n, text, enter: input.enter === true } : 'Give the text to type.'
    case 'key':
      return (BROWSER_KEYS as readonly unknown[]).includes(input.key) ? { kind: 'key', key: input.key as BrowserKey } : `key must be one of ${BROWSER_KEYS.join(', ')}.`
    default:
      return `action must be one of ${BROWSER_ACT_ACTIONS.join(', ')}.`
  }
}
