/**
 * Atlas's own window, main side: what it shows (reported by the page), its
 * size and place, compact mode (a small chat-only window in the corner that
 * remembers the full size), keeping it on top, and the same changes for the
 * owner's buttons and for Atlas's tools.
 */
import { ipcMain, screen, type BrowserWindow, type Rectangle } from 'electron'

import { describeUi, layoutFor, parseUiChange, UC, isView, type PageCommand, type PageUi, type UiChange, type UiOp, type UiState } from '../shared/ui.ts'

const COMPACT = { width: 400, height: 640 }
const NORMAL = { width: 1180, height: 760 }
const LARGE = { width: 1480, height: 920 }
const MARGIN = 16

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class UiService {
  private page: PageUi = { view: 'home', chatOpen: true, compact: false }
  /** The full-size bounds to come back to from compact mode. */
  private fullBounds: Rectangle | null = null
  private waiters: (() => void)[] = []

  constructor(
    private readonly deps: {
      window: () => BrowserWindow | null
      /** Opens (or shows) the window, waiting until the page is listening. */
      open: () => Promise<BrowserWindow>
      toRenderer: (channel: string, payload: unknown) => void
      handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
      requireOwner: () => void
      /** Called whenever the window changes, so the runtime knows. */
      onChange: (s: UiState) => void
    },
  ) {}

  state(): UiState {
    const win = this.deps.window()
    if (!win || win.isDestroyed()) return { ...this.page, width: 0, height: 0, layout: 'wide', maximized: false, minimized: false, visible: false, focused: false, pinned: false }
    const [width, height] = win.getContentSize() as [number, number]
    return {
      ...this.page,
      width,
      height,
      layout: layoutFor(width),
      maximized: win.isMaximized(),
      minimized: win.isMinimized(),
      visible: win.isVisible(),
      focused: win.isFocused(),
      pinned: win.isAlwaysOnTop(),
    }
  }

  /** Window events worth telling the runtime about. */
  watch(win: BrowserWindow) {
    let timer: NodeJS.Timeout | null = null
    const changed = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => this.deps.onChange(this.state()), 300)
    }
    for (const e of ['resize', 'maximize', 'unmaximize', 'minimize', 'restore', 'show', 'hide', 'always-on-top-changed'] as const) win.on(e as 'resize', changed)
    win.on('closed', () => this.deps.onChange(this.state()))
  }

  private command(c: PageCommand) {
    this.deps.toRenderer(UC.command, c)
  }

  /** Waits briefly for the page to confirm what it now shows. */
  private settle() {
    return Promise.race([new Promise<void>(r => this.waiters.push(r)), sleep(900)])
  }

  private workArea(win: BrowserWindow) {
    return screen.getDisplayMatching(win.getBounds()).workArea
  }

  private center(win: BrowserWindow, size: { width: number; height: number }) {
    const area = this.workArea(win)
    const width = Math.min(size.width, Math.round(area.width * 0.95))
    const height = Math.min(size.height, Math.round(area.height * 0.95))
    win.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height })
  }

  private enterCompact(win: BrowserWindow) {
    if (this.page.compact) return
    if (win.isMaximized()) win.unmaximize()
    this.fullBounds = win.getBounds()
    const area = this.workArea(win)
    win.setBounds({ x: area.x + area.width - COMPACT.width - MARGIN, y: area.y + area.height - COMPACT.height - MARGIN, ...COMPACT })
    this.command({ compact: true })
  }

  private leaveCompact(win: BrowserWindow) {
    if (!this.page.compact) return false
    if (this.fullBounds) win.setBounds(this.fullBounds)
    else this.center(win, NORMAL)
    this.fullBounds = null
    this.command({ compact: false })
    return true
  }

  async apply(change: UiChange): Promise<UiState> {
    let win = this.deps.window()
    if (change.size === 'minimized') {
      win?.minimize()
      return this.state()
    }
    if (!win || win.isDestroyed() || !win.isVisible()) win = await this.deps.open()
    if (win.isMinimized()) win.restore()
    switch (change.size) {
      case 'compact':
        this.enterCompact(win)
        break
      case 'normal':
        if (!this.leaveCompact(win)) {
          if (win.isMaximized()) win.unmaximize()
          this.center(win, NORMAL)
        }
        break
      case 'large':
        this.leaveCompact(win)
        if (win.isMaximized()) win.unmaximize()
        this.center(win, LARGE)
        break
      case 'maximized':
        this.leaveCompact(win)
        win.maximize()
        break
    }
    // Going to a page means the full window.
    if (change.view && this.page.compact) this.leaveCompact(win)
    if (change.pinned !== undefined) win.setAlwaysOnTop(change.pinned, 'floating')
    if (change.view !== undefined || change.chat !== undefined) this.command({ view: change.view, chat: change.chat })
    if (change.view !== undefined || change.chat !== undefined || change.size === 'compact' || change.size === 'normal' || change.size === 'large' || change.size === 'maximized') await this.settle()
    const s = this.state()
    this.deps.onChange(s)
    return s
  }

  /** The model's ui tools. */
  async handleOp(op: UiOp): Promise<string> {
    if (op.kind === 'state') return describeUi(this.state())
    return `Done. Now: ${describeUi(await this.apply(op.change))}`
  }

  /** One line for the assistant's context every turn, so it knows its own window. */
  contextLine(): string {
    return `Your own window (Atlas app): ${describeUi(this.state())}`
  }

  register() {
    ipcMain.on(UC.report, (event, raw: unknown) => {
      const win = this.deps.window()
      if (!win || event.sender !== win.webContents) return
      const o = raw as Partial<PageUi> | null
      if (!o || !isView(o.view) || typeof o.chatOpen !== 'boolean' || typeof o.compact !== 'boolean') return
      // A reloaded page starts full-size; the window may still be compact.
      if (this.fullBounds && !o.compact) this.command({ compact: true })
      this.page = { view: o.view, chatOpen: o.chatOpen, compact: o.compact || this.fullBounds !== null }
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
