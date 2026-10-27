/**
 * The desktop widget's window (widget.ps1: WebView2 in a frameless,
 * always-on-top window) and where it goes. The gateway owns the settings,
 * works out the place on each display (shared/widget.ts), follows a newly
 * connected display when the owner wants that, and answers the model's
 * widget tool. Windows only for now (a Mac gets it with the menu-bar helper).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { scriptFile } from '../host/index.ts'
import {
  DEFAULT_WIDGET,
  displayLabel,
  parseWidgetSettings,
  pickDisplay,
  placeWidget,
  spotOf,
  WGC,
  type Corner,
  type DisplayInfo,
  type WidgetMode,
  type WidgetOp,
  type WidgetSettings,
  type WidgetView,
} from '../../shared/widget.ts'
import WIDGET_PS1 from './widget.ps1?raw'

export interface WidgetDeps {
  dataDir: string
  /** Where the WebView2 SDK files are (resources/webview2). */
  lib: string
  /** The widget page's address with a one-time pairing ticket (asked of the brain when it runs elsewhere). */
  url: () => string | Promise<string>
  handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
  toRenderer: (channel: string, payload: unknown) => void
  openExternal: (url: string) => void
  /** The full Atlas: the open page comes forward, else the browser opens. */
  showAtlas: () => void
  log: (level: 'info' | 'warn', message: string) => void
}

/** How long a new display's card stays up before the widget goes back to how it was. */
const ANNOUNCE_MS = 8_000

export class WidgetService {
  private settings: WidgetSettings
  private child: ChildProcess | null = null
  private displays: DisplayInfo[] = []
  private newest: string | null = null
  private acrylic = false
  private running = false
  private stopping = false
  private retry = 0
  private error: string | null = null
  private announce: DisplayInfo | null = null
  private announceTimer: NodeJS.Timeout | null = null
  /** The mode before a display card took over (glass), to go back to. */
  private before: WidgetMode | null = null
  private readonly file: string

  constructor(private readonly deps: WidgetDeps) {
    this.file = join(deps.dataDir, 'widget.json')
    this.settings = { ...DEFAULT_WIDGET, ...this.load() }
  }

  get available() {
    return process.platform === 'win32' && existsSync(join(this.deps.lib, 'Microsoft.Web.WebView2.WinForms.dll'))
  }

  private load(): Partial<WidgetSettings> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      const display = raw.display && typeof raw.display === 'object' ? (raw.display as { id?: unknown; name?: unknown }) : null
      const at = raw.at && typeof raw.at === 'object' ? (raw.at as { x?: unknown; y?: unknown }) : null
      return {
        ...parseWidgetSettings(raw),
        display: display && typeof display.id === 'string' ? { id: display.id, name: typeof display.name === 'string' ? display.name : '' } : null,
        at: at && typeof at.x === 'number' && typeof at.y === 'number' ? { x: at.x, y: at.y } : null,
      }
    } catch {
      return {}
    }
  }

  private save() {
    mkdirSync(this.deps.dataDir, { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2))
  }

  view(): WidgetView {
    return { ...this.settings, available: this.available, running: this.running, acrylic: this.acrylic, displays: this.displays, on: this.current()?.id ?? null, announce: this.announce, error: this.error }
  }

  private publish() {
    this.deps.toRenderer(WGC.changed, this.view())
  }

  register() {
    this.deps.handle(WGC.get, () => this.view())
    this.deps.handle(WGC.set, raw => {
      const change = parseWidgetSettings(raw)
      if (!change) throw new Error('Nothing to change.')
      this.settings = { ...this.settings, ...change }
      this.save()
      if (change.enabled === true) this.start()
      if (change.enabled === false) this.stop()
      if (change.onTop !== undefined) this.send('topmost', change.onTop ? '1' : '0')
      if (change.look) this.send('look', change.look)
      // Choosing a corner leaves the spot the owner dragged it to.
      if (change.corner) this.settings = { ...this.settings, at: null }
      if (change.mode || change.corner) this.place(true)
      this.save()
      this.publish()
      return this.view()
    })
    this.deps.handle(WGC.op, raw => this.handle(raw as WidgetOp))
  }

  // ── the window process ────────────────────────────────────

  start() {
    if (this.child || this.starting || !this.settings.enabled || !this.available) return
    this.stopping = false
    this.starting = true
    void Promise.resolve()
      .then(() => this.deps.url())
      .then(
        url => {
          this.starting = false
          if (!this.stopping && !this.child) this.launch(url)
        },
        e => {
          this.starting = false
          this.error = e instanceof Error ? e.message : String(e)
          this.publish()
        },
      )
  }

  private starting = false

  private launch(url: string) {
    const data = join(this.deps.dataDir, 'widget-webview')
    mkdirSync(data, { recursive: true })
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptFile('widget.ps1', WIDGET_PS1), '-Url', url, '-Data', data, '-Lib', this.deps.lib, '-Look', this.settings.look], {
      windowsHide: true,
      // Development: the widget page can be inspected (DevTools protocol on port 9555).
      env: process.env.ATLAS_DEV === '1' ? { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9555' } : process.env,
    })
    this.child = child
    // The window closed while a command was on its way: nothing to tell it any more (never an unhandled error).
    child.stdin?.on('error', () => undefined)
    createInterface({ input: child.stdout! }).on('line', line => this.onLine(line))
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      if (text) this.deps.log('warn', `Widget: ${text.split('\n')[0]}`)
    })
    child.on('exit', code => {
      this.child = null
      this.running = false
      this.publish()
      if (this.stopping || !this.settings.enabled) return
      // It closed by itself: start again after a pause that grows (a few times at most).
      if (this.retry++ < 5) setTimeout(() => this.start(), 2_000 * this.retry).unref()
      else this.error = `The widget window stopped (${code ?? 'no code'}).`
    })
  }

  stop() {
    this.stopping = true
    this.send('exit')
    const c = this.child
    setTimeout(() => c?.kill(), 1_500).unref()
  }

  private send(...fields: string[]) {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${fields.map(f => f.replace(/[\t\r\n]/g, ' ')).join('\t')}\n`)
  }

  private onLine(line: string) {
    const [kind, ...rest] = line.split('\t')
    switch (kind) {
      case 'ready':
        this.running = true
        this.retry = 0
        this.error = null
        this.acrylic = rest[0] === '1'
        this.send('topmost', this.settings.onTop ? '1' : '0')
        this.publish()
        break
      case 'look':
        this.acrylic = rest[0] === '1'
        this.publish()
        break
      case 'displays':
        this.onDisplays(rest.join('\t'))
        break
      case 'moved':
        this.onDragged(rest.map(Number) as [number, number, number, number])
        break
      case 'page':
        this.onPage(rest.join('\t'))
        break
      case 'error':
        this.error = rest.join(' ')
        this.deps.log('warn', `Widget: ${this.error}`)
        this.publish()
        break
    }
  }

  private onDisplays(json: string) {
    let list: DisplayInfo[]
    try {
      list = JSON.parse(json) as DisplayInfo[]
    } catch {
      return
    }
    const first = this.displays.length === 0
    const added = first ? [] : list.filter(d => !this.displays.some(x => x.id === d.id))
    this.displays = list
    if (added[0]) {
      this.newest = added[0].id
      this.deps.log('info', `Widget: a display connected: ${displayLabel(added[0], list)}.`)
      if (this.settings.followNewDisplays) return this.showDisplay(added[0])
    }
    // Its display went away (unplugged): back to one that is there.
    this.place(!first)
    if (first) this.send('show')
    this.publish()
  }

  /** A display card: the widget glides to it as the glass, shows its name and size, then settles there. */
  private showDisplay(d: DisplayInfo) {
    this.before ??= this.settings.mode
    this.announce = d
    this.settings = { ...this.settings, display: { id: d.id, name: d.name }, mode: 'glass' }
    this.place(true, 'center')
    this.send('show')
    this.publish()
    if (this.announceTimer) clearTimeout(this.announceTimer)
    this.announceTimer = setTimeout(() => {
      this.announce = null
      this.settings = { ...this.settings, mode: this.before ?? 'bar' }
      this.before = null
      this.save()
      this.place(true)
      this.publish()
    }, ANNOUNCE_MS)
    this.announceTimer.unref()
  }

  /** The display the widget belongs on: the chosen one if it is connected (by id, then by name), else the main one. */
  private current(): DisplayInfo | null {
    const want = this.settings.display
    return (want && (this.displays.find(d => d.id === want.id) ?? (want.name ? this.displays.find(d => d.name === want.name) : undefined))) || this.displays.find(d => d.primary) || this.displays[0] || null
  }

  /** Into its place: the owner's own spot when there is one (unless a corner is asked for), else its corner. */
  private place(animate: boolean, corner?: Corner) {
    const d = this.current()
    if (!d) return
    const r = placeWidget(d, this.settings.mode, corner ?? this.settings.corner, corner ? null : this.settings.at)
    // Its shape first (the page's own corners), so it changes size already cut to it.
    const mode = this.settings.mode
    this.send('shape', mode === 'orb' ? 'ellipse' : 'round', String(Math.round((mode === 'glass' ? 26 : 22) * d.scale)))
    this.send('bounds', String(r.x), String(r.y), String(r.w), String(r.h), animate ? '1' : '0')
  }

  /**
   * The owner dragged it: it stays exactly there (on the display under its middle), and keeps that spot
   * as it grows or shrinks. Only a part dragged off the screen is brought back in.
   */
  private onDragged([x, y, w, h]: [number, number, number, number]) {
    const cx = x + w / 2
    const cy = y + h / 2
    const d = this.displays.find(s => cx >= s.x && cx < s.x + s.w && cy >= s.y && cy < s.y + s.h) ?? this.current()
    if (!d) return
    const at = spotOf(d, { x, y, w, h })
    this.settings = { ...this.settings, display: { id: d.id, name: d.name }, at }
    this.save()
    const r = placeWidget(d, this.settings.mode, this.settings.corner, at)
    if (Math.abs(r.x - x) > 2 || Math.abs(r.y - y) > 2) this.place(true)
    this.publish()
  }

  /** Messages from the widget page (WebView2's own channel): its size, links, hiding. */
  private onPage(json: string) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(json) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof msg.open === 'string' && /^https?:\/\//.test(msg.open)) this.deps.openExternal(msg.open)
  }

  // ── what the owner and the model ask ─────────────────────

  async handle(op: WidgetOp): Promise<string> {
    if (!this.available) return 'The desktop widget works on Windows for now.'
    switch (op.kind) {
      case 'state': {
        const d = this.current()
        return `Widget ${this.running ? 'showing' : this.settings.enabled ? 'starting' : 'off'}, ${this.settings.mode} size, ${this.settings.corner}${d ? ` of ${displayLabel(d, this.displays)}` : ''}${this.settings.onTop ? ', above other windows' : ''}. Displays: ${this.displays.map((x, i) => `${i + 1}. ${displayLabel(x, this.displays)}`).join('; ') || 'not known yet'}.`
      }
      case 'show':
        if (!this.settings.enabled) {
          this.settings = { ...this.settings, enabled: true }
          this.save()
          this.start()
        }
        this.send('show')
        this.publish()
        return 'The widget is showing.'
      case 'open-atlas':
        this.deps.showAtlas()
        return 'Atlas is opening in the browser.'
      case 'hide':
        this.send('hide')
        return 'The widget is hidden (it comes back when you ask, or from Settings › Appearance).'
      case 'mode':
        this.settings = { ...this.settings, mode: op.mode }
        this.save()
        this.place(true)
        this.send('show')
        this.publish()
        return `The widget is now the ${op.mode}.`
      case 'pin':
        this.settings = { ...this.settings, onTop: op.on }
        this.save()
        this.send('topmost', op.on ? '1' : '0')
        this.publish()
        return op.on ? 'The widget stays above other windows.' : 'The widget no longer stays on top.'
      case 'move': {
        const d = op.display ? pickDisplay(this.displays, op.display, this.current()?.id ?? null, this.newest) : this.current()
        if (!d) return `There is no display like "${op.display}". Displays: ${this.displays.map((x, i) => `${i + 1}. ${displayLabel(x, this.displays)}`).join('; ')}.`
        const fresh = d.id === this.newest && op.display && /new|latest|external|connected/i.test(op.display)
        this.settings = { ...this.settings, display: { id: d.id, name: d.name }, corner: op.corner ?? this.settings.corner, at: op.corner ? null : this.settings.at }
        this.save()
        if (fresh) this.showDisplay(d)
        else {
          this.place(true)
          this.send('show')
          this.publish()
        }
        return `Moved the widget to ${displayLabel(d, this.displays)}${op.corner ? `, ${op.corner}` : ''}.`
      }
    }
  }
}
