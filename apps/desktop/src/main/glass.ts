/**
 * The glass panel window: frameless, fully transparent and always on top,
 * placed by the desktop widget. Only its cards are drawn (smoky, see-through);
 * the desktop shows everywhere else and clicks there fall through to it.
 * (Windows acrylic would blur the desktop, but it turns solid whenever the
 * window is not focused, and this panel never takes focus.) It shows one view at a time (news, a story, a map, a note) and goes
 * away on "side pe karo", its own close button, or Esc.
 *
 * Sandboxed like the other windows; its IPC is accepted only from its own
 * frame, and links open in the browser only when they are https.
 */
import { BrowserWindow, ipcMain, screen, shell, type IpcMainInvokeEvent } from 'electron'

import { describeGlass, GLASS_SIZE, GLS, panelBounds, pickNews, pickStory, type GlassAlign, type GlassOp, type GlassView } from '../shared/glass.ts'
import { CATEGORY_LABEL, type Category, type Headline } from '../shared/news.ts'
import { mainWebPreferences } from './window-prefs.ts'

export class GlassPanel {
  private win: BrowserWindow | null = null
  private view: GlassView | null = null
  /** The last news list shown, so "number 2" means what the owner sees. */
  private list: Headline[] = []
  private listTitle = ''
  private listCategory: Category | null = null
  private ready = false
  private align: GlassAlign = 'bottom'

  constructor(
    private readonly deps: {
      preload: string
      isDev: boolean
      load: (win: BrowserWindow, page: string) => void
      headlines: () => Promise<Headline[]>
      /** The desktop widget's bounds, to sit beside it; null when it is hidden. */
      widget: () => Electron.Rectangle | null
      locked: () => boolean
      /** The World map's live layers (read-only). */
      world: (kind: unknown, box: unknown) => Promise<unknown>
    },
  ) {}

  get current() {
    return this.view
  }

  async handle(op: GlassOp): Promise<string> {
    if (op.kind === 'state') return describeGlass(this.win?.isVisible() ? this.view : null)
    if (op.kind === 'close') {
      this.close()
      return 'Put the glass panel away; the widget is small again.'
    }
    if (this.deps.locked()) throw new Error('The owner check is on: ask them to confirm it is them first.')
    let view: GlassView
    switch (op.kind) {
      case 'news': {
        const items = pickNews(await this.deps.headlines(), op.category, op.query)
        const title = [op.category ? CATEGORY_LABEL[op.category] : 'Today’s news', op.query ? `· ${op.query}` : ''].filter(Boolean).join(' ')
        this.list = items
        this.listTitle = title
        this.listCategory = op.category
        view = { kind: 'news', title, items, category: op.category }
        break
      }
      case 'story': {
        const found = pickStory(this.list, await this.deps.headlines(), op.n, op.query)
        if (!found) throw new Error(op.n ? `There is no story ${op.n} on the panel; show the news first.` : `No story matches "${op.query}".`)
        view = { kind: 'story', item: found.item, n: found.n, of: this.list.length || null }
        break
      }
      default:
        view = op
    }
    this.show(view)
    return describeGlass(view)
  }

  private show(view: GlassView) {
    this.view = view
    const win = this.ensure()
    const widget = this.deps.widget()
    const area = screen.getDisplayMatching(widget ?? win.getBounds()).workArea
    const b = panelBounds(widget, GLASS_SIZE[view.kind], area)
    win.setBounds(b)
    // Content hugs the edge nearest the widget, so a short list sits right by it.
    this.align = widget && b.y > widget.y ? 'top' : 'bottom'
    if (this.ready) win.webContents.send(GLS.view, { view, align: this.align })
    win.showInactive()
  }

  /** Load the (hidden) panel ahead of time, so the first "dikhao" opens at once with the map code already in. */
  prewarm() {
    this.ensure()
  }

  close() {
    this.view = null
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      width: 400,
      height: 560,
      frame: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      resizable: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'Atlas',
      webPreferences: { ...mainWebPreferences(this.deps.preload, this.deps.isDev), backgroundThrottling: false },
    })
    this.win = win
    this.ready = false
    win.setAlwaysOnTop(true, 'floating')
    // See-through space passes clicks to the desktop; the page says when the pointer is over a card.
    win.setIgnoreMouseEvents(true, { forward: true })
    if (!this.deps.isDev) win.webContents.on('devtools-opened', () => win.webContents.closeDevTools())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', e => e.preventDefault())
    win.webContents.on('did-finish-load', () => {
      this.ready = true
      win.webContents.send(GLS.view, { view: this.view, align: this.align })
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    this.deps.load(win, 'glass')
    return win
  }

  register() {
    const own = (e: IpcMainInvokeEvent) => this.win !== null && !this.win.isDestroyed() && e.sender === this.win.webContents
    const on = (channel: string, fn: (a: unknown, b: unknown) => unknown) =>
      ipcMain.handle(channel, (e, a: unknown, b: unknown) => {
        if (!own(e)) throw new Error('Rejected IPC from an unknown frame.')
        return fn(a, b)
      })
    on(GLS.close, () => this.close())
    on(GLS.world, (kind, box) => {
      if (this.deps.locked()) throw new Error('Please confirm it is you first.')
      return this.deps.world(kind, box)
    })
    ipcMain.on(GLS.hit, (e, solid: unknown) => {
      if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents) return
      if (solid === true) this.win.setIgnoreMouseEvents(false)
      else this.win.setIgnoreMouseEvents(true, { forward: true })
    })
    on(GLS.back, () => {
      if (this.list.length) this.show({ kind: 'news', title: this.listTitle, items: this.list, category: this.listCategory })
    })
    on(GLS.story, n => {
      if (typeof n !== 'number' || !this.list[n - 1]) throw new Error('No such story.')
      this.show({ kind: 'story', item: this.list[n - 1]!, n, of: this.list.length })
    })
    on(GLS.openLink, url => {
      if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) throw new Error('Only https links open.')
      void shell.openExternal(url)
    })
  }

  stop() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
