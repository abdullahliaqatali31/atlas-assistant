/**
 * Atlas's own browser: Google Chrome (or Edge) installed on this PC, driven
 * with Playwright, in its own profile (its sign-ins stay apart from the
 * owner's browsers) and without a window of its own: the owner's page shows
 * a live picture of the tab and sends clicks, scrolling and typing back.
 * Atlas reads pages (text and numbered things to click or type into) and
 * acts with real mouse and keyboard input, as a person would. Pages a site
 * opens by itself become tabs next to the one that asked.
 *
 * The browser has tabs: the list is kept here (saved between runs, pinned
 * and grouped tabs included); a few pages stay awake, the rest load again
 * when shown, and the whole browser closes after minutes of nobody using it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { chromium, type BrowserContext, type Page } from 'playwright-core'

import {
  BROWSER_HOME,
  BRT,
  EMPTY_TABS,
  GROUP_COLORS,
  MAX_TABS,
  orderTabs,
  parseRemoteInput,
  parseTabAction,
  toUrl,
  type BrowserMode,
  type BrowserOp,
  type BrowserTab,
  type BrowserTabsState,
  type TabAction,
  type TabGroup,
  type TabPicture,
  type TabsOp,
} from '../shared/browser.ts'
import type { PageCommand } from '../shared/ui.ts'

const LOAD_TIMEOUT_MS = 15_000
const MAX_TEXT = 6_000
const MAX_ITEMS = 120

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Scrollbars for every page in the browser: thin, translucent, rounded, on all sides. */
const PAGE_SCROLLBARS = `
::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: rgb(128 128 128 / 0.42); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: rgb(56 189 248 / 0.65); border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
`

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

/** Pages awake at once (each is a renderer process); more sleep and load again when shown. */
const AWAKE = 3
/** Nobody looked at or used the browser for this long: it closes (and opens again on demand). */
const IDLE_CLOSE_MS = 5 * 60_000
const VIEWPORT = { width: 1280, height: 800 }
const KEY_NAMES: Record<string, string> = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }

export class BrowserService {
  private context: BrowserContext | null = null
  private starting: Promise<BrowserContext> | null = null
  /** Each awake tab's page, by tab id (sleeping tabs have none). */
  private readonly pages = new Map<string, Page>()
  private tabs: BrowserTabsState
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private agent = ''

  constructor(
    private readonly deps: {
      command: (c: PageCommand) => void
      mode: () => BrowserMode
      log: (level: 'info' | 'warn', message: string) => void
      handle: <T>(channel: string, fn: (arg: unknown, arg2: unknown, arg3?: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      /** Where the tab list is kept between runs. */
      file: string
      /** The browser's own profile: its sign-ins and cookies, apart from the owner's own browsers. */
      profileDir: string
    },
  ) {
    this.tabs = loadTabs(deps.file)
  }

  register() {
    this.deps.handle(BRT.get, () => this.tabs)
    this.deps.handle(BRT.act, a => {
      const action = parseTabAction(a)
      if (action) return this.act(action)
    })
    this.deps.handle(BRT.picture, (id, width, since) => this.picture(id, width, since))
    this.deps.handle(BRT.input, (id, input) => this.remote(id, input))
  }

  // ── the browser itself ───────────────────────────────────

  /** Chrome (or Edge) installed on this PC, its own profile, no window: the page shows it. */
  private async browser(): Promise<BrowserContext> {
    if (this.context) return this.context
    this.starting ??= (async () => {
      let last: unknown = null
      for (const channel of ['chrome', 'msedge'] as const) {
        try {
          const ctx = await chromium.launchPersistentContext(this.deps.profileDir, {
            channel,
            headless: true,
            viewport: VIEWPORT,
            ignoreDefaultArgs: ['--enable-automation'],
            // Lean: no extensions, sync, translate or background downloads, and a cap on page processes.
            args: [
              '--disable-blink-features=AutomationControlled',
              '--no-first-run',
              '--no-default-browser-check',
              '--disable-extensions',
              '--disable-component-update',
              '--disable-background-networking',
              '--disable-sync',
              '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication',
              '--renderer-process-limit=4',
            ],
          })
          // Sites see plain Chrome, not "HeadlessChrome".
          const version = ctx.browser()?.version() ?? '140.0.0.0'
          this.agent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split('.')[0]}.0.0.0 Safari/537.36`
          await ctx.setExtraHTTPHeaders({}).catch(() => undefined)
          await ctx.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => undefined })`)
          await ctx.addInitScript(`addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(PAGE_SCROLLBARS)}; document.documentElement.appendChild(s) })`)
          // A page the site opened by itself (target=_blank, sign-in pop-ups) becomes a tab next to its opener.
          ctx.on('page', p => void this.adopt(p))
          ctx.on('close', () => {
            this.context = null
            this.pages.clear()
          })
          for (const p of ctx.pages()) await p.close().catch(() => undefined)
          this.context = ctx
          this.deps.log('info', `Atlas's browser started (${channel} ${version}).`)
          return ctx
        } catch (e) {
          last = e
        }
      }
      throw new Error(`Atlas's browser needs Google Chrome or Microsoft Edge on this PC (${last instanceof Error ? last.message.split('\n')[0] : String(last)}).`)
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** Used just now: closes after a while of nobody using or watching it. */
  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS)
    this.idleTimer.unref?.()
  }

  async close() {
    const ctx = this.context
    this.context = null
    this.pages.clear()
    await ctx?.close().catch(() => undefined)
  }

  /** Page events keep the tab's address and title. */
  private follow(id: string, page: Page) {
    this.pages.set(id, page)
    page.on('framenavigated', f => {
      if (f === page.mainFrame()) this.report(id, f.url(), null)
    })
    page.on('load', () => void page.title().then(t => this.report(id, null, t), () => undefined))
    page.on('close', () => {
      if (this.pages.get(id) === page) this.pages.delete(id)
    })
    void page.setExtraHTTPHeaders({ 'User-Agent': this.agent }).catch(() => undefined)
  }

  private async adopt(page: Page) {
    if ([...this.pages.values()].includes(page)) return
    const opener = await page.opener().catch(() => null)
    const from = opener ? [...this.pages].find(([, p]) => p === opener)?.[0] : undefined
    if (!from) return
    const fromTab = this.tabs.tabs.find(t => t.id === from)
    const tab = this.newTab(page.url() === 'about:blank' ? BROWSER_HOME : page.url(), { byAtlas: fromTab?.byAtlas ?? false, after: from })
    this.follow(tab.id, page)
  }

  /** The tab's page, opened (and loaded at its address) if it was asleep; the longest-unused pages sleep. */
  private async pageFor(id: string): Promise<Page> {
    const existing = this.pages.get(id)
    if (existing && !existing.isClosed()) return existing
    const tab = this.tabs.tabs.find(t => t.id === id)
    if (!tab) throw new Error('That tab is closed.')
    const ctx = await this.browser()
    const page = await ctx.newPage()
    this.follow(id, page)
    await page.goto(tab.url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS }).catch(() => undefined)
    // Keep a few pages awake: the one shown and the most recently used.
    const awake = [...this.pages.keys()].map(k => this.tabs.tabs.find(t => t.id === k)).filter((t): t is BrowserTab => t !== undefined)
    for (const t of awake.sort((a, b) => b.lastUsed - a.lastUsed).slice(AWAKE)) if (t.id !== this.tabs.active) void this.pages.get(t.id)?.close()
    return page
  }

  // ── the web interface's picture and hands ────────────────

  private async picture(id: unknown, width: unknown, since?: unknown): Promise<TabPicture | null> {
    if (typeof id !== 'string' || !this.tabs.tabs.some(t => t.id === id)) return null
    this.touch()
    const page = await this.pageFor(id).catch((e: unknown) => this.trouble(e))
    if (!page) return null
    // Headless Chrome draws only the tab in front: bring this one forward first.
    await page.bringToFront().catch(() => undefined)
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.max(320, Math.min(1600, Math.round(width))) : 1024
    const shot = await page.screenshot({ type: 'jpeg', quality: w < VIEWPORT.width ? 65 : 75, scale: 'css', timeout: 12_000 }).catch((e: unknown) => this.trouble(e))
    if (!shot) return null
    const loading = await page.evaluate('document.readyState !== "complete"').catch(() => false)
    const hist = (await page.evaluate('history.length').catch(() => 1)) as number
    // The same picture as the page already has: say so instead of sending it again.
    const hash = createHash('sha1').update(shot).digest('base64')
    return {
      url: hash === since ? '' : `data:image/jpeg;base64,${shot.toString('base64')}`,
      hash,
      same: hash === since,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      page: { url: page.url(), title: await page.title().catch(() => ''), loading: loading === true, back: hist > 1, forward: false },
    }
  }

  private lastTrouble = ''
  /** Says why a picture failed (once per distinct reason), then gives up quietly. */
  private trouble(e: unknown): null {
    const why = e instanceof Error ? e.message.split('\n')[0]! : String(e)
    if (why !== this.lastTrouble) this.deps.log('warn', `Atlas's browser: ${why}`)
    this.lastTrouble = why
    return null
  }

  private async remote(id: unknown, raw: unknown) {
    const input = parseRemoteInput(raw)
    if (!input || typeof id !== 'string') return
    this.touch()
    const page = await this.pageFor(id)
    await page.bringToFront().catch(() => undefined)
    const at = (fx: number, fy: number) => ({ x: Math.round(VIEWPORT.width * fx), y: Math.round(VIEWPORT.height * fy) })
    if (input.kind === 'click') {
      const p = at(input.x, input.y)
      await page.mouse.click(p.x, p.y)
    } else if (input.kind === 'wheel') {
      const p = at(input.x, input.y)
      await page.mouse.move(p.x, p.y)
      await page.mouse.wheel(0, input.dy)
    } else if (input.kind === 'key') await page.keyboard.press(KEY_NAMES[input.key] ?? input.key)
    else await page.keyboard.insertText(input.text)
  }

  // ── tabs ──────────────────────────────────────────────────

  /** The tab Atlas and the toolbar act on. */
  private activeTab(): BrowserTab | null {
    return this.tabs.tabs.find(t => t.id === this.tabs.active) ?? null
  }

  /** The site the browser shows (host name). */
  site(): string | null {
    try {
      const url = (this.tabs.active && this.pages.get(this.tabs.active)?.url()) || this.activeTab()?.url
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

  /** A tab's page moved to an address or got its title. */
  private report(id: string, url: string | null, title: string | null) {
    const tab = this.tabs.tabs.find(t => t.id === id)
    if (!tab) return
    let dirty = false
    if (url && /^https?:/.test(url) && url !== tab.url) {
      tab.url = url.slice(0, 2000)
      dirty = true
    }
    if (title !== null && title !== tab.title) {
      tab.title = title.slice(0, 200)
      dirty = true
    }
    if (dirty) this.changed()
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
    for (const id of ids) void this.pages.get(id)?.close()
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
    for (const t of this.tabs.tabs)
      if (ids.includes(t.id)) {
        t.group = group
        if (group) t.pinned = false
      }
    this.tidyGroups()
    this.changed()
  }

  /** The owner's own clicks on the tab strip and the toolbar. */
  private async act(a: TabAction) {
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
      case 'go': {
        if (!this.activeTab()) return void this.newTab(a.url, { byAtlas: false })
        this.touch()
        const page = await this.pageFor(this.tabs.active!)
        await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS }).catch(() => undefined)
        return
      }
      case 'nav': {
        if (!this.tabs.active) return
        this.touch()
        const page = await this.pageFor(this.tabs.active)
        const opts = { waitUntil: 'domcontentloaded' as const, timeout: LOAD_TIMEOUT_MS }
        await (a.dir === 'back' ? page.goBack(opts) : a.dir === 'forward' ? page.goForward(opts) : page.reload(opts)).catch(() => undefined)
        return
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
        const page = await this.ensure()
        await this.settle(page)
        return `Opened a new tab${op.group ? ` in "${op.group}"` : ''}${op.pin ? ' (pinned)' : ''}.\n${this.describe(await this.read(page), false)}`
      }
      case 'switch': {
        const t = order[op.n - 1]
        if (!t) return `There is no tab ${op.n}. ${this.listTabs()}`
        this.activate(t.id)
        const page = await this.ensure()
        await this.settle(page, 6_000)
        return `Switched to tab ${op.n}.\n${this.describe(await this.read(page), false)}`
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

  /** The tab shown, with its page loaded; the owner's page shows the browser (in the corner if it was put away). */
  private async ensure(): Promise<Page> {
    if (!this.activeTab()) this.newTab(BROWSER_HOME, { byAtlas: true })
    if (this.deps.mode() === 'hidden') this.deps.command({ browser: { mode: 'mini' } })
    this.touch()
    return this.pageFor(this.tabs.active!)
  }

  /** Wait for the page to finish loading (or give up after a while), then a moment for scripts. */
  private async settle(page: Page, ms = LOAD_TIMEOUT_MS) {
    await sleep(250)
    await page.waitForLoadState('load', { timeout: ms }).catch(() => undefined)
    await sleep(500)
  }

  private async read(page: Page): Promise<PageRead> {
    return (await page.evaluate(READ_PAGE)) as PageRead
  }

  private describe(p: PageRead, full: boolean): string {
    const n = this.tabs.tabs.length
    const lines = [`Page: ${p.title || '(no title)'}`, `URL: ${p.url}`, `Scrolled ${p.y} of ${Math.max(0, p.height - p.view)} px.${n > 1 ? ` (${n} tabs open: browser_tabs lists them.)` : ''}`]
    const text = full ? p.text : p.text.slice(0, 1800)
    lines.push('', 'Text:', text + (p.more || text.length < p.text.length ? '\n…(more: scroll or read)' : ''))
    if (p.items.length) lines.push('', 'On the page (use the numbers with browser_act):', ...(full ? p.items : p.items.slice(0, 50)))
    return lines.join('\n')
  }

  async handle(op: BrowserOp): Promise<string> {
    if (op.kind === 'view') {
      this.deps.command({ browser: { mode: op.mode } })
      return op.mode === 'hidden' ? 'The browser is put away (the pages stay open).' : `The browser now shows ${op.mode === 'pane' ? 'as a pane beside the other one' : op.mode === 'mini' ? 'as a mini view in the corner' : 'over the whole page'}.`
    }
    if (op.kind === 'state') {
      const tab = this.activeTab()
      if (!tab) return 'The browser has no tabs open.'
      const page = this.pages.get(tab.id)
      return `The browser (${this.deps.mode()}, ${this.tabs.tabs.length} tab${this.tabs.tabs.length === 1 ? '' : 's'}) shows "${(await page?.title().catch(() => null)) ?? tab.title}" at ${page?.url() ?? tab.url}.`
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
      const page = await this.ensure()
      switch (op.kind) {
        case 'open': {
          const url = toUrl(op.target)
          if (!url) throw new Error('That is not a web address.')
          if (!op.newTab && page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS }).catch(() => undefined)
          await this.settle(page)
          return (op.newTab ? 'Opened in a new tab.\n' : '') + this.describe(await this.read(page), false)
        }
        case 'read':
          return this.describe(await this.read(page), true)
        case 'scroll': {
          await page.evaluate(`window.scrollBy({ top: ${op.dir === 'up' ? -1 : 1} * innerHeight * 0.85 })`)
          await sleep(400)
          return this.describe(await this.read(page), false)
        }
        case 'back':
        case 'forward': {
          const moved = await (op.kind === 'back' ? page.goBack({ timeout: LOAD_TIMEOUT_MS }) : page.goForward({ timeout: LOAD_TIMEOUT_MS })).catch(() => null)
          if (!moved) return `Nothing to go ${op.kind} to.`
          await this.settle(page)
          return this.describe(await this.read(page), false)
        }
        case 'click': {
          const at = (await page.evaluate(LOCATE(op.n ?? null, op.text ?? null))) as { x: number; y: number; label: string } | null
          if (!at) throw new Error(`Could not find ${op.n ? `[${op.n}]` : `"${op.text}"`} on the page. Read the page again for fresh numbers.`)
          await sleep(250)
          const again = ((await page.evaluate(LOCATE(op.n ?? null, op.text ?? null))) as { x: number; y: number } | null) ?? at
          const before = this.tabs.tabs.length
          await page.mouse.click(again.x, again.y)
          await this.settle(page, 8_000)
          // The click opened a new tab (a link with target=_blank): read that one.
          if (this.tabs.tabs.length > before) {
            const fresh = await this.ensure()
            await this.settle(fresh, 8_000)
            return `Clicked ${op.n ? `[${op.n}] ` : ''}"${at.label}"; it opened in a new tab. Now:\n${this.describe(await this.read(fresh), false)}`
          }
          return `Clicked ${op.n ? `[${op.n}] ` : ''}"${at.label}". Now:\n${this.describe(await this.read(page), false)}`
        }
        case 'type': {
          if (op.n !== undefined) {
            const at = (await page.evaluate(LOCATE(op.n, null))) as { x: number; y: number; editable: boolean } | null
            if (!at) throw new Error(`Could not find [${op.n}] on the page. Read the page again for fresh numbers.`)
            await sleep(200)
            await page.mouse.click(at.x, at.y)
            await sleep(150)
            // Replace what was there.
            await page.keyboard.press('Control+A')
          }
          await page.keyboard.insertText(op.text)
          if (op.enter) {
            await sleep(120)
            await page.keyboard.press('Enter')
            await this.settle(page, 10_000)
            return `Typed and pressed Enter. Now:\n${this.describe(await this.read(page), false)}`
          }
          return `Typed "${op.text.slice(0, 60)}${op.text.length > 60 ? '…' : ''}"${op.n ? ` into [${op.n}]` : ''}.`
        }
        case 'key': {
          await page.keyboard.press(KEY_NAMES[op.key] ?? op.key)
          await this.settle(page, 6_000)
          return `Pressed ${op.key}. Now:\n${this.describe(await this.read(page), false)}`
        }
      }
    } finally {
      this.deps.command({ browser: { driving: false } })
    }
  }
}
