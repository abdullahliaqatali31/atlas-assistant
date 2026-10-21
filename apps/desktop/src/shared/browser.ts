/**
 * Atlas's own browser, inside its window, and the window's panes. The
 * browser is a hardened <webview> in its own persistent session (so a login
 * stays logged in), shown as a pane beside another one, a mini view in the
 * corner, or the whole window. Atlas drives it with the browser tools: what
 * it reads there is untrusted, and clicking or typing after reading a page
 * asks the owner first (unless Full control is on).
 */

/** What a pane of the window can show. */
export const SURFACES = ['home', 'world', 'habits', 'browser'] as const
export type Surface = (typeof SURFACES)[number]

export const SURFACE_LABEL: Record<Surface, string> = { home: 'Brain', world: 'World', habits: 'Profiles', browser: 'Browser' }

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
  | { kind: 'open'; target: string; newTab?: boolean | undefined }
  | { kind: 'tabs'; op: TabsOp }
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
        return target.trim() ? { kind: 'open', target: target.slice(0, 2000), ...(input.new_tab === true ? { newTab: true } : {}) } : 'Give a url or a query to open.'
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

// ── Tabs ──────────────────────────────────────────────────────────

/** One tab of Atlas's browser. Tabs survive restarts; a tab that has not been opened since wakes when switched to. */
export interface BrowserTab {
  id: string
  url: string
  title: string
  pinned: boolean
  /** Its group's id, or null. */
  group: string | null
  /** Atlas opened it (the owner can tell its tabs from theirs). */
  byAtlas: boolean
  opened: number
  lastUsed: number
}

/** A named, coloured group of tabs (e.g. "Daily work"). */
export interface TabGroup {
  id: string
  name: string
  color: string
  collapsed: boolean
}

export interface BrowserTabsState {
  tabs: BrowserTab[]
  groups: TabGroup[]
  active: string | null
}

export const EMPTY_TABS: BrowserTabsState = { tabs: [], groups: [], active: null }
export const MAX_TABS = 30
/** Tabs kept loaded at once (the rest sleep until opened). */
export const AWAKE_TABS = 8
export const GROUP_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#f87171', '#94a3b8'] as const

/** The owner's own tab actions (from the tab strip). */
export type TabAction =
  | { kind: 'new'; url?: string | undefined }
  | { kind: 'activate'; id: string }
  | { kind: 'close'; ids: string[] }
  | { kind: 'close-others'; id: string }
  | { kind: 'pin'; id: string; pinned: boolean }
  | { kind: 'group'; ids: string[]; group: string | null; name?: string | undefined }
  | { kind: 'group-rename'; group: string; name: string }
  | { kind: 'group-collapse'; group: string; collapsed: boolean }
  /** The toolbar: an address for the tab shown, and back, forward, reload. */
  | { kind: 'go'; url: string }
  | { kind: 'nav'; dir: 'back' | 'forward' | 'reload' }

/** Atlas's tab requests: tabs by their number in the list (1 is the first), groups by name. */
export type TabsOp =
  | { kind: 'list' }
  | { kind: 'new'; target: string; group?: string | undefined; pin?: boolean | undefined }
  | { kind: 'switch'; n: number }
  | { kind: 'close'; ns: number[] }
  | { kind: 'pin'; ns: number[]; pinned: boolean }
  | { kind: 'group'; ns: number[]; name: string; color?: string | undefined }
  | { kind: 'ungroup'; ns: number[] }

/** The tab strip's order: pinned first, then each group together (in the order they first appear), then the rest. */
export const orderTabs = (s: BrowserTabsState): BrowserTab[] => {
  const pinned = s.tabs.filter(t => t.pinned)
  const rest = s.tabs.filter(t => !t.pinned)
  const groups = [...new Set(rest.map(t => t.group).filter((g): g is string => g !== null))]
  return [...pinned, ...groups.flatMap(g => rest.filter(t => t.group === g)), ...rest.filter(t => t.group === null)]
}

export const parseTabAction = (v: unknown): TabAction | null => {
  const o = (v ?? {}) as Record<string, unknown>
  const id = (x: unknown) => (typeof x === 'string' && /^[\w-]{4,40}$/.test(x) ? x : null)
  const ids = (x: unknown) => (Array.isArray(x) ? x.map(id).filter((y): y is string => y !== null).slice(0, MAX_TABS) : [])
  switch (o.kind) {
    case 'new':
      return { kind: 'new', url: typeof o.url === 'string' ? o.url.slice(0, 2000) : undefined }
    case 'activate':
      return id(o.id) ? { kind: 'activate', id: id(o.id)! } : null
    case 'close':
      return { kind: 'close', ids: ids(o.ids) }
    case 'close-others':
      return id(o.id) ? { kind: 'close-others', id: id(o.id)! } : null
    case 'pin':
      return id(o.id) ? { kind: 'pin', id: id(o.id)!, pinned: o.pinned === true } : null
    case 'group':
      return { kind: 'group', ids: ids(o.ids), group: o.group === null ? null : id(o.group), name: typeof o.name === 'string' ? o.name.trim().slice(0, 40) : undefined }
    case 'group-rename':
      return id(o.group) && typeof o.name === 'string' && o.name.trim() ? { kind: 'group-rename', group: id(o.group)!, name: o.name.trim().slice(0, 40) } : null
    case 'group-collapse':
      return id(o.group) ? { kind: 'group-collapse', group: id(o.group)!, collapsed: o.collapsed === true } : null
    case 'go':
      return typeof o.url === 'string' && toUrl(o.url.slice(0, 2000)) ? { kind: 'go', url: toUrl(o.url.slice(0, 2000))! } : null
    case 'nav':
      return o.dir === 'back' || o.dir === 'forward' || o.dir === 'reload' ? { kind: 'nav', dir: o.dir } : null
  }
  return null
}

/** The tabs tool's input, checked. */
export const tabsOpFromTool = (input: Record<string, unknown>): TabsOp | string => {
  const nums = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'number' ? [v] : []).filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0).slice(0, MAX_TABS)
  const ns = nums(input.tabs ?? input.tab)
  switch (input.action) {
    case 'list':
      return { kind: 'list' }
    case 'new': {
      const target = typeof input.url === 'string' ? input.url : typeof input.query === 'string' ? input.query : ''
      return target.trim() ? { kind: 'new', target: target.slice(0, 2000), group: typeof input.group === 'string' ? input.group.slice(0, 40) : undefined, pin: input.pin === true } : 'Give a url or query for the new tab.'
    }
    case 'switch':
      return ns[0] ? { kind: 'switch', n: ns[0] } : 'Which tab? Its number from list.'
    case 'close':
      return ns.length ? { kind: 'close', ns } : 'Which tabs? Their numbers from list.'
    case 'pin':
    case 'unpin':
      return ns.length ? { kind: 'pin', ns, pinned: input.action === 'pin' } : 'Which tabs? Their numbers from list.'
    case 'group':
      return ns.length && typeof input.group === 'string' && input.group.trim() ? { kind: 'group', ns, name: input.group.trim().slice(0, 40), color: typeof input.color === 'string' ? input.color : undefined } : 'Give the tabs (numbers) and a group name.'
    case 'ungroup':
      return ns.length ? { kind: 'ungroup', ns } : 'Which tabs? Their numbers from list.'
  }
  return 'action must be one of list, new, switch, close, pin, unpin, group, ungroup.'
}

export const BRT = {
  state: 'browser-tabs:state',
  get: 'browser-tabs:get',
  act: 'browser-tabs:act',
  report: 'browser-tabs:report',
  picture: 'browser-tabs:picture',
  input: 'browser-tabs:input',
} as const

/** A picture of a tab's page, for the web interface (which cannot hold the page itself). */
export interface TabPicture {
  url: string
  width: number
  height: number
  /** The page in it: address, title, still loading, and whether back or forward lead anywhere. */
  page?: { url: string; title: string; loading: boolean; back: boolean; forward: boolean }
}

/** The owner's hands on a tab from a browser: positions are 0..1 of the picture. */
export type RemoteInput =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; dy: number }
  | { kind: 'key'; key: (typeof REMOTE_KEYS)[number] }
  | { kind: 'text'; text: string }

export const REMOTE_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End'] as const

const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

export const parseRemoteInput = (v: unknown): RemoteInput | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.kind === 'click' && unit(o.x) && unit(o.y)) return { kind: 'click', x: o.x as number, y: o.y as number }
  if (o.kind === 'wheel' && unit(o.x) && unit(o.y) && typeof o.dy === 'number' && Math.abs(o.dy) <= 5000) return { kind: 'wheel', x: o.x as number, y: o.y as number, dy: o.dy }
  if (o.kind === 'key' && REMOTE_KEYS.includes(o.key as (typeof REMOTE_KEYS)[number])) return { kind: 'key', key: o.key as (typeof REMOTE_KEYS)[number] }
  if (o.kind === 'text' && typeof o.text === 'string' && o.text.length > 0 && o.text.length <= 500) return { kind: 'text', text: o.text }
  return null
}

/** The page's side of the tabs (window.atlasTabs). */
export interface BrowserTabsBridge {
  get(): Promise<BrowserTabsState>
  onState(cb: (s: BrowserTabsState) => void): () => void
  act(a: TabAction): Promise<void>
  /** A tab's page told its webContents id (on load), its address and title. */
  report(r: { id: string; wcId?: number | undefined; url?: string | undefined; title?: string | undefined }): void
  /** A picture of the tab's page at about this width, or null when the page is not open on the PC. */
  picture(id: string, width: number): Promise<TabPicture | null>
  input(id: string, input: RemoteInput): Promise<void>
}
