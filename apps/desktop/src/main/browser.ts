/**
 * Atlas's own browser, main side. The page hosts a <webview> in its own
 * persistent session; here every webview is hardened before it attaches
 * (no preload, no Node, sandboxed, web pages only), new windows open in the
 * same view, permission prompts are refused, and the browser looks like
 * plain Chrome to the sites it visits. Atlas drives it through the guest's
 * webContents: reading the page (text and numbered things to click or type
 * into) and clicking or typing with real input events, as a person would.
 */
import { session, type BrowserWindow, type WebContents } from 'electron'

import { BROWSER_PARTITION, toUrl, type BrowserMode, type BrowserOp } from '../shared/browser.ts'
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

export class BrowserService {
  private guest: WebContents | null = null
  private waiters: (() => void)[] = []
  private prepared = false

  constructor(
    private readonly deps: {
      /** Opens (or shows) Atlas's window. */
      ensureWindow: () => Promise<BrowserWindow>
      command: (c: PageCommand) => void
      mode: () => BrowserMode
      log: (level: 'info' | 'warn', message: string) => void
    },
  ) {}

  /** The site the browser shows (host name), for the widget. */
  site(): string | null {
    try {
      return this.guest && !this.guest.isDestroyed() ? new URL(this.guest.getURL()).hostname.replace(/^www\./, '') || null : null
    } catch {
      return null
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

  /** Watch the main window's page for the webview: harden it before it attaches, keep its contents once it does. */
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
      this.guest = wc
      wc.setWindowOpenHandler(({ url }) => {
        // Pop-ups open here instead (sign-in windows included).
        if (/^https?:/.test(url)) void wc.loadURL(url).catch(() => undefined)
        return { action: 'deny' }
      })
      wc.on('will-navigate', (e, url) => {
        if (!/^(https?:|about:blank)/.test(url)) e.preventDefault()
      })
      wc.once('destroyed', () => {
        if (this.guest === wc) this.guest = null
      })
      for (const w of this.waiters.splice(0)) w()
    })
  }

  /** The browser, opened (in the corner if it was out of sight) and attached. */
  private async ensure(): Promise<WebContents> {
    if (this.guest && !this.guest.isDestroyed()) {
      if (this.deps.mode() === 'hidden') this.deps.command({ browser: { mode: 'mini' } })
      return this.guest
    }
    await this.deps.ensureWindow()
    this.deps.command({ browser: { mode: this.deps.mode() === 'hidden' ? 'mini' : this.deps.mode() } })
    await Promise.race([new Promise<void>(r => this.waiters.push(r)), sleep(ATTACH_TIMEOUT_MS)])
    if (!this.guest || this.guest.isDestroyed()) throw new Error('The browser did not open.')
    return this.guest
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
    const lines = [`Page: ${p.title || '(no title)'}`, `URL: ${p.url}`, `Scrolled ${p.y} of ${Math.max(0, p.height - p.view)} px.`]
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
      return op.mode === 'hidden' ? 'The browser is put away (the page stays open).' : `The browser now shows ${op.mode === 'pane' ? 'as a pane beside the other one' : op.mode === 'mini' ? 'as a mini view in the corner' : 'over the whole window'}.`
    }
    if (op.kind === 'state') {
      const wc = this.guest
      if (!wc || wc.isDestroyed()) return 'The browser is not open.'
      return `The browser (${this.deps.mode()}) shows "${wc.getTitle()}" at ${wc.getURL()}${wc.isLoading() ? ', still loading' : ''}.`
    }
    const wc = await this.ensure()
    this.deps.command({ browser: { driving: true } })
    try {
      switch (op.kind) {
        case 'open': {
          const url = toUrl(op.target)
          if (!url) throw new Error('That is not a web address.')
          await wc.loadURL(url).catch((e: unknown) => {
            // A redirect aborts the first load; the page still arrives.
            if (!String(e).includes('ERR_ABORTED')) throw e
          })
          await this.settle(wc)
          return this.describe(await this.read(wc), false)
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
          await this.click(wc, again.x, again.y)
          await this.settle(wc, 8_000)
          const p = await this.read(wc)
          return `Clicked ${op.n ? `[${op.n}] ` : ''}"${at.label}". Now:\n${this.describe(p, false)}`
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
