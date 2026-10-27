/**
 * The tray icon, its menu, balloon notices and the global shortcuts, kept by
 * a small PowerShell helper (tray.ps1): Windows' own notify icon and hotkeys,
 * no browser engine. Restarts by itself if it ever exits.
 */
import { spawn, type ChildProcess } from 'node:child_process'

import { scriptFile } from './index.ts'
import TRAY_PS1 from './tray.ps1?raw'

export interface TrayItem {
  id?: string
  label?: string
  checked?: boolean
  enabled?: boolean
  separator?: boolean
}

const MODS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, CommandOrControl: 2, Shift: 4, Super: 8 }
const NAMED_KEYS: Record<string, number> = { Space: 0x20, '/': 0xbf, Enter: 0x0d, Escape: 0x1b, Tab: 0x09, ',': 0xbc, '.': 0xbe, ';': 0xba, '-': 0xbd, '=': 0xbb }

/** "CommandOrControl+Alt+Space" → Windows modifier bits and virtual key, or null. */
export const toHotkey = (accelerator: string): { mods: number; vk: number } | null => {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  let mods = 0
  for (const p of parts) {
    if (!(p in MODS)) return null
    mods |= MODS[p]!
  }
  const vk = NAMED_KEYS[key] ?? (/^[A-Z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : /^F([1-9]|1[0-2])$/.test(key) ? 0x6f + Number(key.slice(1)) : null)
  return vk === null || mods === 0 ? null : { mods, vk }
}

const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ').slice(0, 200)

export class Tray {
  private child: ChildProcess | null = null
  private menu: { tooltip: string; items: TrayItem[] } | null = null
  private readonly hotkeys = new Map<string, { accelerator: string; fn: () => void }>()
  private readonly ok = new Set<string>()
  private stopped = false
  /** The helper is up and listening; until then everything waits and is sent once it says so. */
  private ready = false

  constructor(
    private readonly deps: {
      icon: string
      onClick: (id: string) => void
      onBalloonClick: () => void
      /** Lock, unlock, resume and idle time, from the same helper. */
      onSession: (line: string) => void
      log: (level: 'info' | 'warn', message: string) => void
    },
  ) {}

  start() {
    if (this.child || this.stopped || process.platform !== 'win32') return
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptFile('tray.ps1', TRAY_PS1), '-Icon', this.deps.icon], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // A write after the tray helper exited is dropped, never an unhandled error that stops Atlas.
    child.stdin?.on('error', () => undefined)
    this.child = child
    let buf = ''
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        this.line(buf.slice(0, i).trim())
        buf = buf.slice(i + 1)
      }
    })
    child.stderr!.on('data', (d: Buffer) => this.deps.log('warn', `Tray: ${d.toString().trim().slice(0, 300)}`))
    child.once('exit', () => {
      this.child = null
      this.ready = false
      this.ok.clear()
      if (!this.stopped) setTimeout(() => this.start(), 3_000).unref()
    })
  }

  private line(line: string) {
    const [kind, id = ''] = line.split('\t')
    if (kind === 'ready') {
      // The helper is listening (first start or a restart): the menu and every shortcut, once.
      this.ready = true
      if (this.menu) this.setMenu(this.menu.tooltip, this.menu.items)
      for (const [hid, h] of this.hotkeys) this.sendHotkey(hid, h.accelerator)
    } else if (kind === 'click') this.deps.onClick(id)
    else if (kind === 'hotkey') this.hotkeys.get(id)?.fn()
    else if (kind === 'hotkey-ok') this.ok.add(id)
    else if (kind === 'hotkey-fail') this.deps.log('warn', `The shortcut ${this.hotkeys.get(id)?.accelerator ?? id} is taken by another app.`)
    else if (kind === 'balloon-click') this.deps.onBalloonClick()
    else if (kind === 'session') this.deps.onSession(line.split('	').slice(1).join(' '))
  }

  private write(fields: string[]) {
    if (this.ready && this.child?.stdin?.writable) this.child.stdin.write(`${fields.map(clean).join('\t')}\n`)
  }

  setMenu(tooltip: string, items: TrayItem[]) {
    this.menu = { tooltip, items }
    this.write(['menu', tooltip])
    for (const it of items) this.write(['item', it.id ?? '-', it.label ?? '', `${it.separator ? 's' : ''}${it.checked ? 'c' : ''}${it.enabled === false ? 'd' : ''}`])
    this.write(['endmenu'])
  }

  balloon(title: string, text: string) {
    this.write(['balloon', title, text])
  }

  /** Windows' alarm sound, looping until quiet() (a timer ringing). */
  alarm(wav = `${process.env.WINDIR ?? 'C:\\Windows'}\\Media\\Alarm01.wav`) {
    this.write(['sound', wav])
  }

  quiet() {
    this.write(['sound-stop'])
  }

  /** Registers a global shortcut; true when the accelerator is valid (whether Windows granted it shows in isRegistered). */
  register(accelerator: string, fn: () => void, id = accelerator): boolean {
    const hk = toHotkey(accelerator)
    if (!hk) return false
    this.hotkeys.set(id, { accelerator, fn })
    this.sendHotkey(id, accelerator)
    return true
  }

  private sendHotkey(id: string, accelerator: string) {
    const hk = toHotkey(accelerator)
    if (hk) this.write(['hotkey', id, String(hk.mods), String(hk.vk)])
  }

  isRegistered(id: string) {
    return this.ok.has(id)
  }

  stop() {
    this.stopped = true
    this.write(['exit'])
    setTimeout(() => this.child?.kill(), 1_000).unref()
  }
}

