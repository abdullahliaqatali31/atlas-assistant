/**
 * Atlas's own browser, main side. The page hosts a <webview> in its own
 * persistent session; here every webview is hardened before it attaches
 * (no preload, no Node, sandboxed, web pages only), new windows open in the
 * tab next to the one that asked, permission prompts are refused, and the browser looks like
 * plain Chrome to the sites it visits. Atlas drives it through the guest's
 * webContents: reading the page (text and numbered things to click or type
 * into) and clicking or typing with real input events, as a person would.
 *
 * The browser has tabs: main keeps the list (saved between runs, pinned and
 * grouped tabs included); the page draws one webview per awake tab and tells
 * main which webContents is which tab. Atlas acts on the tab shown.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { session, webContents, type BrowserWindow, type WebContents } from 'electron'

import {
  BROWSER_HOME,
  BROWSER_PARTITION,
  BRT,
  EMPTY_TABS,
  GROUP_COLORS,
  MAX_TABS,
  orderTabs,
  parseTabAction,
  toUrl,
  type BrowserMode,
  type BrowserOp,
  type BrowserTab,
  type BrowserTabsState,
  type TabAction,
  type TabGroup,
  type TabsOp,
} from '../shared/browser.ts'
import type { PageCommand } from '../shared/ui.ts'

const ATTACH_TIMEOUT_MS = 12_000
const LOAD_TIMEOUT_MS = 15_000
const MAX_TEXT = 6_000
const MAX_ITEMS = 120

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A plain Chrome user agent: some sites (Google sign-in among them) refuse embedded browsers that say otherwise. */
const chromeAgent = () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`

/** Runs in the page: its text, and the things on screen one can click or type into, numbered. */
const READ_PAGE = `(() => {
  for (const e of document.querySelectorAll('[data-atlas-n]')) e.removeAttribute('data-atlas-n')
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[role=combobox],[role=searchbox],[role=textbox],[contenteditable=""],[contenteditable=true]'
  const items = []
  let n = 0
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width < 3 || r.height < 3) continue
    if (r.bottom < -innerHeight || r.top > innerHeight * 2.5) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue
    const tag = el.tagName.toLowerCase()
    const kind = tag === 'input' ? 'input:' + (el.type || 'text') : el.getAttribute('role') || tag
    const words = (el.getAttribute('aria-label') || el.innerText || (tag === 'input' && el.type !== 'password' ? el.value : '') || el.placeholder || el.title || el.getAttribute('alt') || el.querySelector('img')?.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 90)
    if (!words && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue
    n++
    el.setAttribute('data-atlas-n', String(n))
    const where = r.top < 0 ? ' (above)' : r.top > innerHeight ? ' (below)' : ''
    const href = tag === 'a' && el.href && !el.href.startsWith('javascript:') ? ' -> ' + el.href.slice(0, 100) : ''
    items.push('[' + n + '] ' + kind + (words ? ' "' + words + '"' : '') + (el.placeholder && words !== el.placeholder ? ' (' + el.placeholder.slice(0, 40) + ')' : '') + href + where)
    if (n >= ${MAX_ITEMS}) break
  }
  const text = (document.body ? document.body.innerText : '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim()
  return { title: document.title, url: location.href, text: text.slice(0, ${MAX_TEXT}), more: text.length > ${MAX_TEXT}, items, y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight }
})()`

/** Runs in the page: find a thing (by number, or by its words), bring it into view, and say where it is. */
const LOCATE = (n: number | null, text: string | null) => `(() => {
  const label = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || '').replace(/\\s+/g, ' ').trim()
  let el = ${n === null ? 'null' : `document.querySelector('[data-atlas-n="${n}"]')`}
  const want = ${JSON.stringify(text?.toLowerCase() ?? null)}
  if (!el && want) {
    const all = [...document.querySelectorAll('a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=combobox],[role=searchbox],[role=textbox],[contenteditable=true]')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 })
    el = all.find(e => label(e).toLowerCase() === want) || all.find(e => label(e).toLowerCase().includes(want)) || null
  }
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 20)), label: label(el).slice(0, 80), tag: el.tagName.toLowerCase(), editable: el.matches('input,textarea,[contenteditable=true],[contenteditable=""],[role=textbox],[role=searchbox],[role=combobox]') }
})()`

interface PageRead {
  title: string
  url: string
  text: string
  more: boolean
  items: string[]
  y: number
  height: number
  view: number
}

const newId = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

/** A saved tab list, checked (a bad or old file gives an empty browser, never a crash). */
const loadTabs = (file: string): BrowserTabsState => {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BrowserTabsState>
    const groups = (Array.isArray(raw.groups) ? raw.groups : [])
      .filter(g => g && typeof g.id === 'string' && typeof g.name === 'string')
      .map(g => ({ id: g.id, name: g.name.slice(0, 40), color: typeof g.color === 'string' ? g.color : GROUP_COLORS[0], collapsed: g.collapsed === true }))
    const known = new Set(groups.map(g => g.id))
    const tabs = (Array.isArray(raw.tabs) ? raw.tabs : [])
      .filter(t => t && typeof t.id === 'string' && typeof t.url === 'string' && /^https?:/.test(t.url))
      .slice(0, MAX_TABS)
      .map(t => ({
        id: t.id,
        url: t.url,
        title: typeof t.title === 'string' ? t.title.slice(0, 200) : '',
        pinned: t.pinned === true,
        group: typeof t.group === 'string' && known.has(t.group) ? t.group : null,
        byAtlas: t.byAtlas === true,
        opened: typeof t.opened === 'number' ? t.opened : Date.now(),
        lastUsed: typeof t.lastUsed === 'number' ? t.lastUsed : 0,
      }))
    const active = tabs.some(t => t.id === raw.active) ? (raw.active as string) : (tabs[0]?.id ?? null)
    return { tabs, groups: groups.filter(g => tabs.some(t => t.group === g.id)), active }
  } catch {
    return { ...EMPTY_TABS }
  }
}

export class BrowserService {
  /** Each awake tab's page, by tab id (sleeping tabs have none). */
  private readonly pages = new Map<string, WebContents>()
  private readonly waiters = new Map<string, (() => void)[]>()
  private prepared = false
  private tabs: BrowserTabsState
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deps: {
      /** Opens (or shows) Atlas's window. */
      ensureWindow: () => Promise<BrowserWindow>
      command: (c: PageCommand) => void
      mode: () => BrowserMode
      log: (level: 'info' | 'warn', message: string) => void
      handle: <T>(channel: string, fn: (arg: unknown, arg2: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      /** Where the tab list is kept between runs. */
      file: string
    },
  ) {
    this.tabs = loadTabs(deps.file)
  }

  register() {
    this.deps.handle(BRT.get, () => this.tabs)
    this.deps.handle(BRT.act, a => {
      const action = parseTabAction(a)
      if (action) this.act(action)
    })
    this.deps.handle(BRT.report, r => this.report(r))
  }

  /** The tab Atlas and the toolbar act on. */
  private activeTab(): BrowserTab | null {
    return this.tabs.tabs.find(t => t.id === this.tabs.active) ?? null
  }

  private activePage(): WebContents | null {
    const wc = this.tabs.active ? this.pages.get(this.tabs.active) : undefined
    return wc && !wc.isDestroyed() ? wc : null
  }

  /** The site the browser shows (host name), for the widget. */
  site(): string | null {
    try {
      const url = this.activePage()?.getURL() ?? this.activeTab()?.url
      return url ? new URL(url).hostname.replace(/^www\./, '') || null : null
    } catch {
      return null
    }
  }

  /** Tell the page and save (a moment later, so a burst of changes writes once). */
  private changed() {
    this.deps.toRenderer(BRT.state, this.tabs)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        mkdirSync(dirname(this.deps.file), { recursive: true })
        writeFileSync(this.deps.file, JSON.stringify(this.tabs))
      } catch (e) {
        this.deps.log('warn', `Could not save the browser tabs: ${String(e)}`)
      }
    }, 600)
  }

  /** A tab's page told its webContents id, address or title. */
  private report(v: unknown) {
    const r = (v ?? {}) as { id?: unknown; wcId?: unknown; url?: unknown; title?: unknown }
    const tab = this.tabs.tabs.find(t => t.id === r.id)
    if (!tab) return
    if (typeof r.wcId === 'number') {
      const wc = webContents.fromId(r.wcId)
      // Only a webview in the browser's own session can be a tab.
      if (wc && !wc.isDestroyed() && wc.getType() === 'webview' && wc.session === session.fromPartition(BROWSER_PARTITION)) {
        this.pages.set(tab.id, wc)
        wc.once('destroyed', () => {
          if (this.pages.get(tab.id) === wc) this.pages.delete(tab.id)
        })
        for (const w of this.waiters.get(tab.id)?.splice(0) ?? []) w()
      }
    }
    let dirty = false
    if (typeof r.url === 'string' && /^https?:/.test(r.url) && r.url !== tab.url) {
      tab.url = r.url.slice(0, 2000)
      dirty = true
    }
    if (typeof r.title === 'string' && r.title !== tab.title) {
      tab.title = r.title.slice(0, 200)
      dirty = true
    }
    if (dirty) this.changed()
  }

  private tabOf(wc: WebContents): BrowserTab | null {
    for (const [id, page] of this.pages) if (page === wc) return this.tabs.tabs.find(t => t.id === id) ?? null
    return null
  }

  /** A new tab, placed after `after` (or at the end); when the list is full the longest-unused ordinary tab makes room. */
  private newTab(url: string, o: { byAtlas: boolean; after?: string | null | undefined; activate?: boolean | undefined; group?: string | null | undefined; pinned?: boolean | undefined }): BrowserTab {
    if (this.tabs.tabs.length >= MAX_TABS) {
      const spare = this.tabs.tabs.filter(t => !t.pinned && t.id !== this.tabs.active).sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (spare) this.remove([spare.id])
    }
    const now = Date.now()
    const after = o.after ? this.tabs.tabs.find(t => t.id === o.after) : undefined
    const tab: BrowserTab = { id: newId('t'), url, title: '', pinned: o.pinned === true, group: o.group ?? (after && !after.pinned ? after.group : null), byAtlas: o.byAtlas, opened: now, lastUsed: now }
    const at = after ? this.tabs.tabs.indexOf(after) + 1 : this.tabs.tabs.length
    this.tabs.tabs.splice(at, 0, tab)
    if (o.activate !== false) this.tabs.active = tab.id
    this.changed()
    return tab
  }

  private activate(id: string) {
    const tab = this.tabs.tabs.find(t => t.id === id)
    if (!tab) return
    tab.lastUsed = Date.now()
    this.tabs.active = id
    // A collapsed group opens when one of its tabs is shown.
    const g = this.tabs.groups.find(x => x.id === tab.group)
    if (g) g.collapsed = false
    this.changed()
  }

  private remove(ids: string[]) {
    const gone = new Set(ids)
    const order = orderTabs(this.tabs)
    const at = order.findIndex(t => t.id === this.tabs.active)
    this.tabs.tabs = this.tabs.tabs.filter(t => !gone.has(t.id))
    if (this.tabs.active && gone.has(this.tabs.active)) {
      // The next tab along takes its place, else the one before.
      const left = order.filter(t => !gone.has(t.id))
      const next = order.slice(at + 1).find(t => !gone.has(t.id)) ?? left[left.length - 1]
      this.tabs.active = next?.id ?? null
    }
    this.tidyGroups()
    this.changed()
  }

  private tidyGroups() {
    this.tabs.groups = this.tabs.groups.filter(g => this.tabs.tabs.some(t => t.group === g.id))
  }

  /** The group with this name, made if new. */
  private groupNamed(name: string, color?: string): TabGroup {
    const found = this.tabs.groups.find(g => g.name.toLowerCase() === name.toLowerCase())
    if (found) return found
    const g: TabGroup = { id: newId('g'), name, color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : GROUP_COLORS[this.tabs.groups.length % GROUP_COLORS.length]!, collapsed: false }
    this.tabs.groups.push(g)
    return g
  }

  private setGroup(ids: string[], group: string | null) {
    for (const t of this.tabs.tabs) if (ids.includes(t.id)) {
      t.group = group
      if (group) t.pinned = false
    }
    this.tidyGroups()
    this.changed()
  }

  /** The owner's own clicks on the tab strip. */
  private act(a: TabAction) {
    switch (a.kind) {
      case 'new': {
        const url = (a.url && toUrl(a.url)) || BROWSER_HOME
        this.newTab(url, { byAtlas: false, after: this.tabs.active })
        return
      }
      case 'activate':
        return this.activate(a.id)
      case 'close':
        return this.remove(a.ids)
      case 'close-others':
        return this.remove(this.tabs.tabs.filter(t => t.id !== a.id && !t.pinned).map(t => t.id))
      case 'pin': {
        const t = this.tabs.tabs.find(x => x.id === a.id)
        if (!t) return
        t.pinned = a.pinned
        if (a.pinned) t.group = null
        this.tidyGroups()
        return this.changed()
      }
      case 'group': {
        if (!a.ids.length) return
        if (a.group === null && !a.name) return this.setGroup(a.ids, null)
        const g = a.group ? this.tabs.groups.find(x => x.id === a.group) : this.groupNamed(a.name || 'Group')
        if (g) this.setGroup(a.ids, g.id)
        return
      }
      case 'group-rename': {
        const g = this.tabs.groups.find(x => x.id === a.group)
        if (g) g.name = a.name
        return this.changed()
      }
      case 'group-collapse': {
        const g = this.tabs.groups.find(x => x.id === a.group)
        if (g) g.collapsed = a.collapsed
        return this.changed()
      }
    }
  }

  /** The tabs as Atlas sees them: numbered in strip order, with what it needs to judge which are still wanted. */
  private listTabs(): string {
    const order = orderTabs(this.tabs)
    if (!order.length) return 'No tabs are open.'
    const now = Date.now()
    const groupName = (id: string | null) => this.tabs.groups.find(g => g.id === id)?.name
    const lines = order.map((t, i) => {
      let host = t.url
      try {
        host = new URL(t.url).hostname.replace(/^www\./, '')
      } catch {
        // Keep the address.
      }
      const tags = [t.pinned ? 'pinned' : '', groupName(t.group) ? `group "${groupName(t.group)}"` : '', t.id === this.tabs.active ? 'showing' : '', t.byAtlas ? 'opened by Atlas' : 'opened by owner', `used ${ago(now - t.lastUsed)}`].filter(Boolean)
      return `${i + 1}. ${t.title || '(untitled)'} — ${host} [${tags.join(', ')}]`
    })
    return [`${order.length} tab${order.length === 1 ? '' : 's'} (numbers for browser_tabs):`, ...lines].join('\n')
  }

  private async tabsOp(op: TabsOp): Promise<string> {
    const order = orderTabs(this.tabs)
    const pick = (ns: number[]) => ns.map(n => order[n - 1]).filter((t): t is BrowserTab => t !== undefined)
    switch (op.kind) {
      case 'list':
        return this.listTabs()
      case 'new': {
        const url = toUrl(op.target)
        if (!url) return 'That is not a web address.'
        const group = op.group ? this.groupNamed(op.group).id : null
        this.newTab(url, { byAtlas: true, after: this.tabs.active, group, pinned: op.pin })
        const wc = await this.ensure()
        await this.settle(wc)
        return `Opened a new tab${op.group ? ` in "${op.group}"` : ''}${op.pin ? ' (pinned)' : ''}.\n${this.describe(await this.read(wc), false)}`
      }
      case 'switch': {
        const t = order[op.n - 1]
        if (!t) return `There is no tab ${op.n}. ${this.listTabs()}`
        this.activate(t.id)
        const wc = await this.ensure()
        await this.settle(wc, 6_000)
        return `Switched to tab ${op.n}.\n${this.describe(await this.read(wc), false)}`
      }
      case 'close': {
        const ts = pick(op.ns)
        if (!ts.length) return `No such tabs. ${this.listTabs()}`
        this.remove(ts.map(t => t.id))
        return `Closed ${ts.map(t => `"${t.title || t.url}"`).join(', ')}. The numbers have changed:\n${this.listTabs()}`
      }
      case 'pin': {
        const ts = pick(op.ns)
        for (const t of ts) {
          t.pinned = op.pinned
          if (op.pinned) t.group = null
        }
        this.tidyGroups()
        this.changed()
        return `${op.pinned ? 'Pinned' : 'Unpinned'} ${ts.length} tab${ts.length === 1 ? '' : 's'}. Pinned tabs come first now:\n${this.listTabs()}`
      }
      case 'group': {
        const ts = pick(op.ns)
        if (!ts.length) return `No such tabs. ${this.listTabs()}`
        const g = this.groupNamed(op.name, op.color)
        this.setGroup(
          ts.map(t => t.id),
          g.id,
        )
        return `Grouped ${ts.length} tab${ts.length === 1 ? '' : 's'} as "${g.name}":\n${this.listTabs()}`
      }
      case 'ungroup': {
        const ts = pick(op.ns)
        this.setGroup(
          ts.map(t => t.id),
          null,
        )
        return `Took ${ts.length} tab${ts.length === 1 ? '' : 's'} out of their group:\n${this.listTabs()}`
      }
    }
  }

  /** The browser's own session: Chrome's face, no permission prompts, nothing but web pages. */
  private prepare() {
    if (this.prepared) return
    this.prepared = true
    const s = session.fromPartition(BROWSER_PARTITION)
    s.setUserAgent(chromeAgent())
    s.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'fullscreen' || permission === 'clipboard-sanitized-write'))
    s.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen' || permission === 'clipboard-sanitized-write')
  }

  /** Watch the main window's page for webviews: harden each before it attaches; pop-ups become new tabs. */
  watch(host: WebContents) {
    this.prepare()
    host.on('will-attach-webview', (event, prefs, params) => {
      delete (prefs as { preload?: string }).preload
      prefs.nodeIntegration = false
      prefs.nodeIntegrationInSubFrames = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      prefs.webSecurity = true
      prefs.allowRunningInsecureContent = false
      if (params.partition !== BROWSER_PARTITION || !/^(https?:|about:blank)/.test(params.src ?? '')) event.preventDefault()
    })
    host.on('did-attach-webview', (_event, wc) => {
      wc.setWindowOpenHandler(({ url }) => {
        // Pop-ups (sign-in windows included) open as a tab next to the one that asked.
        if (/^https?:/.test(url)) {
          const from = this.tabOf(wc)
          this.newTab(url, { byAtlas: from?.byAtlas ?? false, after: from?.id ?? this.tabs.active })
        }
        return { action: 'deny' }
      })
      wc.on('will-navigate', (e, url) => {
        if (!/^(https?:|about:blank)/.test(url)) e.preventDefault()
      })
    })
  }

  /** The tab shown, opened (in the corner if the browser was out of sight) and loaded into a page. */
  private async ensure(): Promise<WebContents> {
    if (!this.activeTab()) this.newTab(BROWSER_HOME, { byAtlas: true })
    const id = this.tabs.active!
    const ready = this.activePage()
    if (ready) {
      if (this.deps.mode() === 'hidden') this.deps.command({ browser: { mode: 'mini' } })
      return ready
    }
    await this.deps.ensureWindow()
    this.deps.command({ browser: { mode: this.deps.mode() === 'hidden' ? 'mini' : this.deps.mode() } })
    await Promise.race([
      new Promise<void>(r => {
        const list = this.waiters.get(id) ?? []
        list.push(r)
        this.waiters.set(id, list)
      }),
      sleep(ATTACH_TIMEOUT_MS),
    ])
    const wc = this.activePage()
    if (!wc) throw new Error('The browser did not open.')
    return wc
  }

  /** Wait for the page to finish loading (or give up after a while), then a moment for scripts. */
  private async settle(wc: WebContents, ms = LOAD_TIMEOUT_MS) {
    const started = Date.now()
    await sleep(250)
    while (wc.isLoading() && Date.now() - started < ms) await sleep(150)
    await sleep(500)
  }

  private async read(wc: WebContents): Promise<PageRead> {
    return (await wc.executeJavaScript(READ_PAGE, true)) as PageRead
  }

  private describe(p: PageRead, full: boolean): string {
    const n = this.tabs.tabs.length
    const lines = [`Page: ${p.title || '(no title)'}`, `URL: ${p.url}`, `Scrolled ${p.y} of ${Math.max(0, p.height - p.view)} px.${n > 1 ? ` (${n} tabs open: browser_tabs lists them.)` : ''}`]
    const text = full ? p.text : p.text.slice(0, 1800)
    lines.push('', 'Text:', text + (p.more || text.length < p.text.length ? '\n…(more: scroll or read)' : ''))
    if (p.items.length) lines.push('', 'On the page (use the numbers with browser_act):', ...(full ? p.items : p.items.slice(0, 50)))
    return lines.join('\n')
  }

  private async click(wc: WebContents, x: number, y: number) {
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await sleep(40)
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }

  private key(wc: WebContents, keyCode: string) {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
  }

  async handle(op: BrowserOp): Promise<string> {
    if (op.kind === 'view') {
      if (op.mode !== 'hidden') await this.deps.ensureWindow()
      this.deps.command({ browser: { mode: op.mode } })
      return op.mode === 'hidden' ? 'The browser is put away (the pages stay open).' : `The browser now shows ${op.mode === 'pane' ? 'as a pane beside the other one' : op.mode === 'mini' ? 'as a mini view in the corner' : 'over the whole window'}.`
    }
    if (op.kind === 'state') {
      const tab = this.activeTab()
      if (!tab) return 'The browser has no tabs open.'
      const wc = this.activePage()
      return `The browser (${this.deps.mode()}, ${this.tabs.tabs.length} tab${this.tabs.tabs.length === 1 ? '' : 's'}) shows "${wc?.getTitle() ?? tab.title}" at ${wc?.getURL() ?? tab.url}${wc?.isLoading() ? ', still loading' : ''}.`
    }
    if (op.kind === 'tabs' && (op.op.kind === 'list' || op.op.kind === 'close' || op.op.kind === 'pin' || op.op.kind === 'group' || op.op.kind === 'ungroup')) return this.tabsOp(op.op)
    if (op.kind === 'open' && (op.newTab || !this.activeTab())) {
      const url = toUrl(op.target)
      if (!url) throw new Error('That is not a web address.')
      this.newTab(url, { byAtlas: true, after: this.tabs.active })
    }
    this.deps.command({ browser: { driving: true } })
    try {
      if (op.kind === 'tabs') return await this.tabsOp(op.op)
      const wc = await this.ensure()
      switch (op.kind) {
        case 'open': {
          if (!op.newTab && this.activeTab()?.url !== toUrl(op.target)) {
            const url = toUrl(op.target)
            if (!url) throw new Error('That is not a web address.')
            await wc.loadURL(url).catch((e: unknown) => {
              // A redirect aborts the first load; the page still arrives.
              if (!String(e).includes('ERR_ABORTED')) throw e
            })
          }
          await this.settle(wc)
          return (op.newTab ? 'Opened in a new tab.\n' : '') + this.describe(await this.read(wc), false)
        }
        case 'read':
          return this.describe(await this.read(wc), true)
        case 'scroll': {
          await wc.executeJavaScript(`window.scrollBy({ top: ${op.dir === 'up' ? -1 : 1} * innerHeight * 0.85 })`, true)
          await sleep(400)
          return this.describe(await this.read(wc), false)
        }
        case 'back':
        case 'forward': {
          const h = wc.navigationHistory
          if (op.kind === 'back' ? !h.canGoBack() : !h.canGoForward()) return `Nothing to go ${op.kind} to.`
          if (op.kind === 'back') h.goBack()
          else h.goForward()
          await this.settle(wc)
          return this.describe(await this.read(wc), false)
        }
        case 'click': {
          const at = (await wc.executeJavaScript(LOCATE(op.n ?? null, op.text ?? null), true)) as { x: number; y: number; label: string } | null
          if (!at) throw new Error(`Could not find ${op.n ? `[${op.n}]` : `"${op.text}"`} on the page. Read the page again for fresh numbers.`)
          await sleep(250)
          const again = ((await wc.executeJavaScript(LOCATE(op.n ?? null, op.text ?? null), true)) as { x: number; y: number } | null) ?? at
          const before = this.tabs.tabs.length
          await this.click(wc, again.x, again.y)
          await this.settle(wc, 8_000)
          // The click opened a new tab (a link with target=_blank): read that one.
          if (this.tabs.tabs.length > before) {
            const fresh = await this.ensure()
            await this.settle(fresh, 8_000)
            return `Clicked ${op.n ? `[${op.n}] ` : ''}"${at.label}"; it opened in a new tab. Now:\n${this.describe(await this.read(fresh), false)}`
          }
          return `Clicked ${op.n ? `[${op.n}] ` : ''}"${at.label}". Now:\n${this.describe(await this.read(wc), false)}`
        }
        case 'type': {
          if (op.n !== undefined) {
            const at = (await wc.executeJavaScript(LOCATE(op.n, null), true)) as { x: number; y: number; editable: boolean } | null
            if (!at) throw new Error(`Could not find [${op.n}] on the page. Read the page again for fresh numbers.`)
            await sleep(200)
            await this.click(wc, at.x, at.y)
            await sleep(150)
            // Replace what was there.
            await wc.executeJavaScript(`(() => { const e = document.activeElement; if (e && 'select' in e && typeof e.select === 'function') e.select(); else document.execCommand('selectAll') })()`, true)
          }
          await wc.insertText(op.text)
          if (op.enter) {
            await sleep(120)
            this.key(wc, 'Enter')
            await this.settle(wc, 10_000)
            return `Typed and pressed Enter. Now:\n${this.describe(await this.read(wc), false)}`
          }
          return `Typed "${op.text.slice(0, 60)}${op.text.length > 60 ? '…' : ''}"${op.n ? ` into [${op.n}]` : ''}.`
        }
        case 'key': {
          this.key(wc, op.key)
          await this.settle(wc, 6_000)
          return `Pressed ${op.key}. Now:\n${this.describe(await this.read(wc), false)}`
        }
      }
    } finally {
      this.deps.command({ browser: { driving: false } })
    }
  }
}
