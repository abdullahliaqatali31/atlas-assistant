/**
 * The desktop widget: a small frameless, transparent, always-on-top window
 * that carries Atlas's presence onto the desktop while its main window is out
 * of sight (or always, if the owner wants). It shows a dot when idle, a pill
 * with a caption while Atlas listens, thinks or speaks, and a card when Atlas
 * speaks up or needs a yes. The page sizes itself; main grows the window
 * away from the screen edge it sits near and remembers where it was dragged.
 *
 * Its page is sandboxed and its IPC is accepted only from its own frame.
 * Approvals and initiative choices go through the same checks as the main
 * window; while the owner check is on, the card says only that something is
 * waiting.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { BrowserWindow, ipcMain, Menu, screen, type IpcMainInvokeEvent, type Rectangle } from 'electron'

import type { ApprovalRequest, InitiativeAction, InitiativeItem } from '../shared/ipc.ts'
import { INITIATIVE_ACTIONS } from '../shared/ipc.ts'
import {
  growFrom,
  parsePresenceUpdate,
  parseWidgetSize,
  PRS,
  startBounds,
  WIDGET_SCALES,
  WIDGET_WHEN,
  widgetVisible,
  type PresenceCard,
  type PresenceCommand,
  type PresenceState,
  type PresenceUpdate,
  type WidgetScale,
  type WidgetWhen,
} from '../shared/presence.ts'
import { mainWebPreferences } from './window-prefs.ts'

/** An initiative card stays this long unless the owner answers it sooner. */
const CARD_MS = 3 * 60_000
const DOT = { width: 64, height: 64 }

interface Saved {
  when: WidgetWhen
  scale: WidgetScale
  /** Where the owner put it, per display. */
  at: Record<string, { x: number; y: number }>
}

export class PresenceWidget {
  private win: BrowserWindow | null = null
  private saved: Saved
  private live: PresenceUpdate = { activity: 'idle', caption: '', level: 0 }
  private initiative: { item: InitiativeItem; until: number } | null = null
  private mainInView = true
  private lastSent = ''

  constructor(
    private readonly deps: {
      file: string
      preload: string
      isDev: boolean
      load: (win: BrowserWindow, page: string) => void
      /** Open (or reopen) Atlas's main window. */
      openMain: () => void
      /** Tell the main window's conversation to stop or to start talking. */
      command: (c: PresenceCommand) => boolean
      answerApproval: (id: string, approved: boolean) => void
      initiativeAction: (id: string, action: InitiativeAction) => void
      approvals: () => ApprovalRequest[]
      locked: () => boolean
      name: () => string
    },
  ) {
    this.saved = this.read()
  }

  private read(): Saved {
    const base: Saved = { when: 'background', scale: 'm', at: {} }
    try {
      const raw = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<Saved>
      return {
        when: WIDGET_WHEN.includes(raw.when as WidgetWhen) ? (raw.when as WidgetWhen) : base.when,
        scale: WIDGET_SCALES.includes(raw.scale as WidgetScale) ? (raw.scale as WidgetScale) : base.scale,
        at: raw.at && typeof raw.at === 'object' ? raw.at : {},
      }
    } catch {
      return base
    }
  }

  private save() {
    try {
      writeFileSync(this.deps.file, JSON.stringify(this.saved, null, 2))
    } catch {
      // Not fatal: the choice lasts until restart.
    }
  }

  get when() {
    return this.saved.when
  }

  setWhen(when: WidgetWhen) {
    this.saved.when = when
    this.save()
    this.sync()
  }

  /** The main window was shown, hidden, minimised, focused or closed. */
  mainWindow(inView: boolean) {
    this.mainInView = inView
    this.sync()
  }

  /** What the conversation is doing, from the main window. */
  update(raw: unknown) {
    const u = parsePresenceUpdate(raw)
    if (!u) return
    this.live = u
    this.push()
  }

  /** Atlas spoke up on its own: show it as a card until answered or a few minutes pass. */
  spokeUp(item: InitiativeItem) {
    this.initiative = { item, until: Date.now() + CARD_MS }
    this.push()
  }

  /** Approvals or the owner check changed. */
  refresh() {
    this.push()
  }

  private card(): PresenceCard | null {
    const approval = this.deps.approvals()[0]
    if (this.initiative && Date.now() > this.initiative.until) this.initiative = null
    if (!approval && !this.initiative) return null
    if (this.deps.locked()) return { kind: 'locked' }
    if (approval) return { kind: 'approval', id: approval.id, tool: approval.tool, summary: (approval.question ?? approval.reason).slice(0, 240) }
    const { item } = this.initiative!
    return { kind: 'initiative', id: item.id, text: item.title.slice(0, 240), canMute: item.canMute }
  }

  private state(): PresenceState {
    const locked = this.deps.locked()
    return {
      // Nothing Atlas says is shown on the desktop while the owner check is on.
      activity: this.live.activity,
      caption: locked ? '' : this.live.caption,
      level: this.live.level,
      card: this.card(),
      name: this.deps.name(),
      scale: this.saved.scale,
    }
  }

  private push() {
    if (!this.win || this.win.isDestroyed()) return
    const s = this.state()
    const key = JSON.stringify({ ...s, level: Math.round(s.level * 10) })
    if (key === this.lastSent) return
    this.lastSent = key
    this.win.webContents.send(PRS.state, s)
  }

  /** Show or hide the widget for the current setting and main window state. */
  sync() {
    const show = widgetVisible(this.saved.when, this.mainInView)
    if (!show) {
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide()
      return
    }
    if (!this.win || this.win.isDestroyed()) this.create()
    else if (!this.win.isVisible()) this.win.showInactive()
  }

  private create() {
    const display = screen.getPrimaryDisplay()
    const at = this.saved.at[String(display.id)]
    const area = display.workArea
    const bounds = at ? growFrom({ ...at, ...DOT }, DOT, area) : startBounds(area, DOT)
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: 'Atlas',
      webPreferences: { ...mainWebPreferences(this.deps.preload, this.deps.isDev), backgroundThrottling: false },
    })
    this.win = win
    this.lastSent = ''
    // Above ordinary windows, below full-screen games and video.
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true)
    if (!this.deps.isDev) win.webContents.on('devtools-opened', () => win.webContents.closeDevTools())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', e => e.preventDefault())
    win.once('ready-to-show', () => {
      this.push()
      if (widgetVisible(this.saved.when, this.mainInView)) win.showInactive()
    })
    win.on('moved', () => {
      const b = win.getBounds()
      const d = screen.getDisplayMatching(b)
      this.saved.at = { ...this.saved.at, [String(d.id)]: { x: b.x, y: b.y } }
      this.save()
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    this.deps.load(win, 'presence')
  }

  private resize(size: { width: number; height: number }) {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const prev = win.getBounds()
    if (prev.width === size.width && prev.height === size.height) return
    const area = screen.getDisplayMatching(prev).workArea
    win.setBounds(growFrom(prev, size, area) as Rectangle)
  }

  private menu() {
    const win = this.win
    if (!win) return
    const scale = (s: WidgetScale, label: string) => ({ label, type: 'radio' as const, checked: this.saved.scale === s, click: () => ((this.saved.scale = s), this.save(), this.push()) })
    const when = (w: WidgetWhen, label: string) => ({ label, type: 'radio' as const, checked: this.saved.when === w, click: () => this.setWhen(w) })
    Menu.buildFromTemplate([
      { label: 'Open Atlas', click: () => this.deps.openMain() },
      { label: 'Talk', click: () => this.talk() },
      { type: 'separator' },
      { label: 'Size', submenu: [scale('s', 'Small'), scale('m', 'Medium'), scale('l', 'Large')] },
      { label: 'Show the widget', submenu: [when('background', 'When Atlas is in the background'), when('always', 'Always'), when('off', 'Never')] },
      { label: 'Back to the corner', click: () => this.home() },
      { type: 'separator' },
      { label: 'Hide the widget', click: () => this.setWhen('off') },
    ]).popup({ window: win })
  }

  private home() {
    const win = this.win
    if (!win) return
    const d = screen.getDisplayMatching(win.getBounds())
    const { [String(d.id)]: _gone, ...rest } = this.saved.at
    this.saved.at = rest
    this.save()
    win.setBounds(startBounds(d.workArea, { width: win.getBounds().width, height: win.getBounds().height }))
  }

  private talk() {
    // The microphone lives in the main window's page: make sure it exists.
    if (!this.deps.command('talk')) this.deps.openMain()
  }

  register() {
    const own = (e: IpcMainInvokeEvent) => this.win !== null && !this.win.isDestroyed() && e.sender === this.win.webContents
    const on = (channel: string, fn: (a: unknown, b: unknown) => unknown) =>
      ipcMain.handle(channel, (e, a: unknown, b: unknown) => {
        if (!own(e)) throw new Error('Rejected IPC from an unknown frame.')
        return fn(a, b)
      })
    on(PRS.stop, () => void this.deps.command('stop'))
    on(PRS.talk, () => this.talk())
    on(PRS.open, () => this.deps.openMain())
    on(PRS.menu, () => this.menu())
    on(PRS.resize, (w, h) => {
      const size = parseWidgetSize(w, h)
      if (size) this.resize(size)
    })
    on(PRS.approval, (id, approved) => {
      if (this.deps.locked()) throw new Error('Please confirm it is you first.')
      if (typeof id !== 'string' || typeof approved !== 'boolean' || !this.deps.approvals().some(a => a.id === id)) throw new Error('No such approval request.')
      this.deps.answerApproval(id, approved)
    })
    on(PRS.initiative, (id, action) => {
      if (this.deps.locked()) throw new Error('Please confirm it is you first.')
      if (!this.initiative || id !== this.initiative.item.id || !INITIATIVE_ACTIONS.includes(action as InitiativeAction)) throw new Error('Unknown initiative action.')
      this.initiative = null
      if (action !== 'dismiss') this.deps.initiativeAction(id, action as InitiativeAction)
      this.push()
    })
  }

  stop() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
