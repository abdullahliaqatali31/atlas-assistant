/**
 * Atlas's screen, gateway side: the page in the owner's browser reports what
 * it shows (page, panes, its size, whether it is in front); Atlas's tools
 * change the page, open it when no browser has it, and run map operations
 * on the World page. Window sizes belong to the browser, so they are the
 * owner's to set.
 */
import { randomUUID } from 'node:crypto'

import { MC, type MapOp } from '../shared/map.ts'
import { describeUi, layoutFor, parseUiChange, UC, isView, type PageCommand, type PageUi, type UiChange, type UiOp, type UiState, type VoiceChange, type WorldDataOp } from '../shared/ui.ts'
import type { SystemOp } from '../shared/system.ts'
import { isSurface, type BrowserMode, type BrowserOp } from '../shared/browser.ts'

/** How long a map op may wait for the World page, and how often it is sent again meanwhile. */
const MAP_TIMEOUT_MS = 20_000
const MAP_RESEND_MS = 1_500

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** What the page says about itself besides what it shows. */
interface PageReport extends PageUi {
  width: number
  height: number
  focused: boolean
  visible: boolean
}

export class UiService {
  private page: PageReport = { view: 'home', chatOpen: true, compact: false, width: 0, height: 0, focused: false, visible: false }
  private waiters: (() => void)[] = []
  private readonly mapWaiters = new Map<string, (r: { result?: string | undefined; error?: string | undefined }) => void>()

  constructor(
    private readonly deps: {
      /** Browsers showing Atlas right now. */
      clients: () => number
      /** Opens Atlas in the default browser (paired), waiting until the page is listening. */
      open: () => Promise<void>
      toRenderer: (channel: string, payload: unknown) => void
      handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
      /** One-way messages from the page. */
      listen: (channel: string, fn: (payload: unknown) => void) => void
      requireOwner: () => void
      /** Called whenever the screen changes, so the runtime knows. */
      onChange: (s: UiState) => void
      /** The PC itself: status, Settings pages, opening and making things. */
      system?: (op: SystemOp) => Promise<string>
      /** Atlas's own browser. */
      browser?: (op: BrowserOp) => Promise<string>
      /** Atlas's own voice settings. */
      voice?: (change: VoiceChange) => Promise<string>
      /** World data (markets, conflict events) read without switching the owner's page. */
      worldData?: (op: WorldDataOp) => Promise<string>
    },
  ) {}

  state(): UiState {
    const open = this.deps.clients() > 0
    const p = this.page
    return {
      view: p.view,
      chatOpen: p.chatOpen,
      compact: p.compact,
      map3d: p.map3d,
      side: p.side,
      browser: p.browser,
      width: open ? p.width : 0,
      height: open ? p.height : 0,
      layout: layoutFor(p.width || 1180),
      maximized: false,
      minimized: open && !p.visible,
      visible: open,
      focused: open && p.focused,
      pinned: false,
    }
  }

  /** The browsers changed (one opened or closed). */
  clientsChanged() {
    this.deps.onChange(this.state())
  }

  /** What Atlas's browser shows as now. */
  browserMode(): BrowserMode {
    return this.page.browser ?? 'hidden'
  }

  /** Page commands from other parts (the browser). */
  send(c: PageCommand) {
    this.command(c)
  }

  /** Open the News page on a tab, scrolled to one story. */
  async showNews(tab: string, focus: string | null) {
    await this.apply({ view: 'news' })
    this.command({ news: { tab, focus } })
  }

  private command(c: PageCommand) {
    this.deps.toRenderer(UC.command, c)
  }

  /** Waits briefly for the page to confirm what it now shows. */
  private settle() {
    return Promise.race([new Promise<void>(r => this.waiters.push(r)), sleep(900)])
  }

  async apply(change: UiChange): Promise<UiState> {
    // Minimising and sizes are the browser's; there is nothing to do here for them.
    if (change.size === 'minimized') return this.state()
    if (this.deps.clients() === 0) await this.deps.open()
    if (change.size === 'compact' && !this.page.compact) this.command({ compact: true })
    if ((change.size === 'normal' || change.size === 'large' || change.size === 'maximized' || change.view) && this.page.compact) this.command({ compact: false })
    if (change.view !== undefined || change.chat !== undefined || change.side !== undefined) this.command({ view: change.view, chat: change.chat, ...(change.side !== undefined ? { side: change.side === 'none' ? null : change.side } : {}) })
    if (change.view !== undefined || change.chat !== undefined || change.side !== undefined || change.size !== undefined) await this.settle()
    const s = this.state()
    this.deps.onChange(s)
    return s
  }

  /** The model's ui tools. */
  async handleOp(op: UiOp): Promise<string> {
    if (op.kind === 'state') return describeUi(this.state())
    if (op.kind === 'map') return this.mapOp(op.op)
    if (op.kind === 'system') {
      if (!this.deps.system) throw new Error('PC control is not available.')
      return this.deps.system(op.op)
    }
    if (op.kind === 'voice') {
      if (!this.deps.voice) throw new Error('Voice settings are not available.')
      return this.deps.voice(op.change)
    }
    if (op.kind === 'world') {
      if (!this.deps.worldData) throw new Error('World data is not available.')
      return this.deps.worldData(op.op)
    }
    if (op.kind === 'browser') {
      if (!this.deps.browser) throw new Error('The browser is not available.')
      return this.deps.browser(op.op)
    }
    if (op.kind === 'glass') throw new Error('There is no glass panel any more: show things on the page instead (ui_show news, the World map, or say it in the reply).')
    const size = op.change.size
    const note = size && size !== 'compact' && size !== 'normal' ? ' (the browser sets its own window size; the owner can resize it)' : op.change.pinned !== undefined ? ' (keeping a browser on top is not possible from here)' : ''
    return `Done${note}. Now: ${describeUi(await this.apply(op.change))}`
  }

  /** Map ops run on the World page: open it first if something else shows. */
  private async mapOp(op: MapOp): Promise<string> {
    if ((this.page.view !== 'world' && this.page.side !== 'world') || this.page.compact || this.deps.clients() === 0) await this.apply({ view: 'world' })
    return this.askMap(op)
  }

  /**
   * The World page loads on demand and its map needs a moment; the op is
   * sent again until the map answers (it ignores repeats by request id).
   */
  private askMap(op: MapOp): Promise<string> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const send = () => this.deps.toRenderer(MC.op, { requestId, op })
      const retry = setInterval(() => {
        if (Date.now() - started > MAP_TIMEOUT_MS) {
          clearInterval(retry)
          this.mapWaiters.delete(requestId)
          reject(new Error('The World map did not answer in time.'))
        } else send()
      }, MAP_RESEND_MS)
      this.mapWaiters.set(requestId, r => {
        clearInterval(retry)
        this.mapWaiters.delete(requestId)
        if (r.error) reject(new Error(r.error))
        else resolve(r.result ?? 'Done.')
      })
      send()
    })
  }

  /** One line for the assistant's context every turn, so it knows its own screen. */
  contextLine(): string {
    return `Your own screen (Atlas in the owner's browser): ${describeUi(this.state())}`
  }

  register() {
    this.deps.listen(MC.result, raw => {
      const o = raw as { requestId?: unknown; result?: unknown; error?: unknown } | null
      if (!o || typeof o.requestId !== 'string') return
      this.mapWaiters.get(o.requestId)?.({ result: typeof o.result === 'string' ? o.result.slice(0, 8_000) : undefined, error: typeof o.error === 'string' ? o.error.slice(0, 500) : undefined })
    })
    this.deps.listen(UC.report, raw => {
      const o = raw as Partial<PageReport> | null
      if (!o || !isView(o.view) || typeof o.chatOpen !== 'boolean' || typeof o.compact !== 'boolean') return
      const modes: readonly unknown[] = ['pane', 'mini', 'full', 'hidden']
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 20_000 ? Math.round(v) : 0)
      this.page = {
        view: o.view,
        chatOpen: o.chatOpen,
        compact: o.compact,
        map3d: o.map3d === true,
        side: isSurface(o.side) ? o.side : null,
        browser: modes.includes(o.browser) ? (o.browser as BrowserMode) : 'hidden',
        width: num(o.width),
        height: num(o.height),
        focused: o.focused === true,
        visible: o.visible !== false,
      }
      for (const w of this.waiters.splice(0)) w()
      this.deps.onChange(this.state())
    })
    this.deps.handle(UC.state, () => this.state())
    this.deps.handle(UC.set, raw => {
      this.deps.requireOwner()
      const change = parseUiChange(raw)
      if (!change) throw new Error('Unknown window change.')
      return this.apply(change)
    })
  }
}
