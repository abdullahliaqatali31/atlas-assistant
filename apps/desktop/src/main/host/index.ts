/**
 * What Atlas needs from the machine, in plain Node: where its data lives,
 * opening links and files, the Recycle Bin, Windows' own file pickers,
 * lock / sleep / idle, starting with Windows, and the network. The names
 * follow the calls the services already made (app, shell, dialog,
 * powerMonitor, net), so they read the same; nothing here needs Electron.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { lookup } from 'node:dns/promises'

import DIALOG_PS1 from './dialog.ps1?raw'

const run = promisify(execFile)
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

/** Same folder the desktop app used, so memory, keys' settings and history carry over. */
const DATA_DIR = process.env.ATLAS_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Personal Assistant')
/** The installed copy's root (where package.json, renderer/ and resources/ sit). */
const ROOT = process.env.ATLAS_ROOT ?? resolve(import.meta.dirname, '..', '..')

type PathName = 'userData' | 'documents' | 'downloads' | 'home' | 'desktop' | 'temp' | 'music' | 'pictures' | 'videos'

const userFolder = (name: 'Documents' | 'Downloads' | 'Desktop' | 'Music' | 'Pictures' | 'Videos') => join(process.env.USERPROFILE ?? homedir(), name)

const quitHandlers: (() => void)[] = []

export const app = {
  getPath(name: PathName): string {
    switch (name) {
      case 'userData':
        mkdirSync(DATA_DIR, { recursive: true })
        return DATA_DIR
      case 'documents':
        return userFolder('Documents')
      case 'downloads':
        return userFolder('Downloads')
      case 'desktop':
        return userFolder('Desktop')
      case 'music':
        return userFolder('Music')
      case 'pictures':
        return userFolder('Pictures')
      case 'videos':
        return userFolder('Videos')
      case 'home':
        return homedir()
      case 'temp':
        return tmpdir()
    }
  },
  getAppPath: () => ROOT,
  /** An installed copy, not the repo (the dev command sets ATLAS_DEV). */
  get isPackaged() {
    return process.env.ATLAS_DEV !== '1'
  },
  getVersion(): string {
    try {
      return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
    } catch {
      return '0.0.0'
    }
  },
  /** Runs before Atlas exits (stop dev servers and the like). */
  on(event: 'before-quit', fn: () => void) {
    if (event === 'before-quit') quitHandlers.push(fn)
  },
  /** Starts Atlas again (after a restore) and ends this process. */
  relaunch() {
    const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
    child.unref()
  },
  exit(code = 0) {
    app.quitting()
    process.exit(code)
  },
  /** Called once on the way out. */
  quitting() {
    for (const fn of quitHandlers.splice(0)) {
      try {
        fn()
      } catch {
        // Leaving anyway.
      }
    }
  },
  getLoginItemSettings: ({ args }: { args: string[] }) => ({ openAtLogin: loginItem.has(args) }),
  setLoginItemSettings: ({ openAtLogin, args }: { openAtLogin: boolean; args: string[] }) => loginItem.set(openAtLogin, args),
}

// ── start with Windows: one value under HKCU\…\Run ─────────

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'Atlas'
/** The command Windows runs at login: the launcher that starts Atlas without a console window, plus the args. */
const loginCommand = (args: string[]) => {
  const launcher = join(ROOT, 'bin', 'atlas-start.vbs')
  return existsSync(launcher) ? [`wscript.exe "${launcher}"`, ...args].join(' ') : [`"${process.execPath}"`, `"${resolve(process.argv[1] ?? '')}"`, ...args].join(' ')
}

const loginItem = {
  read(): string | null {
    try {
      const out = reg(['query', RUN_KEY, '/v', RUN_NAME])
      const m = /REG_SZ\s+(.+)$/m.exec(out)
      return m ? m[1]!.trim() : null
    } catch {
      return null
    }
  },
  has(args: string[]) {
    const v = this.read()
    return v !== null && args.every(a => v.includes(a))
  },
  set(on: boolean, args: string[]) {
    try {
      if (on) reg(['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', loginCommand(args), '/f'])
      else if (this.has(args)) reg(['delete', RUN_KEY, '/v', RUN_NAME, '/f'])
    } catch {
      // Not fatal: the switch shows the real state next time.
    }
  },
}

const reg = (args: string[]) => execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })

/** A helper script written beside Atlas's data (bundled as text), rewritten when it changed. */
export const scriptFile = (name: string, content: string) => {
  const dir = join(app.getPath('userData'), 'workers')
  const file = join(dir, name)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content)
  return file
}

// ── opening things ─────────────────────────────────────────

/** Opens with whatever Windows uses for it, without a shell parsing the text. */
const openWithWindows = (target: string) =>
  new Promise<string>(res => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target], { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', e => res(e.message))
    child.once('spawn', () => {
      child.unref()
      res('')
    })
  })

export const shell = {
  /** Web and mail links only. */
  async openExternal(url: string): Promise<void> {
    if (!/^(https?:|mailto:|ms-settings:|vscode:|cursor:|windsurf:)/i.test(url)) throw new Error('Only web, mail and settings links open from here.')
    const err = await openWithWindows(url)
    if (err) throw new Error(err)
  },
  /** Opens a file or folder; '' when it worked, else the reason (as Electron did). */
  async openPath(path: string): Promise<string> {
    if (!existsSync(path)) return `${path} does not exist.`
    return openWithWindows(path)
  },
  showItemInFolder(path: string) {
    spawn('explorer.exe', [`/select,${path}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  },
  /** To the Recycle Bin, never deleted outright. */
  async trashItem(path: string): Promise<void> {
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:ATLAS_TRASH; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`
    await run('powershell.exe', [...PS, '-Command', script], { windowsHide: true, env: { ...process.env, ATLAS_TRASH: path } })
  },
}

// ── Windows' file pickers, shown on the PC ─────────────────

export interface FileFilter {
  name: string
  extensions: string[]
}
export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  properties?: ('openFile' | 'openDirectory' | 'multiSelections')[]
  filters?: FileFilter[]
}
export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: FileFilter[]
}


const pick = async (request: Record<string, unknown>): Promise<string[]> => {
  const { stdout } = await run('powershell.exe', [...PS, '-STA', '-File', scriptFile('dialog.ps1', DIALOG_PS1)], {
    windowsHide: false,
    maxBuffer: 1 << 20,
    env: { ...process.env, ATLAS_DIALOG: JSON.stringify(request) },
  })
  const out = JSON.parse(stdout.trim() || '[]') as unknown
  return Array.isArray(out) ? out.filter((p): p is string => typeof p === 'string') : []
}

const filterText = (filters?: FileFilter[]) => (filters ?? []).map(f => `${f.name}|${f.extensions.map(e => `*.${e}`).join(';')}`).concat('All files|*.*').join('|')

/** The first argument may be a window (ignored: the picker comes up on top of everything). */
const optionsOf = <T>(a: unknown, b?: T): T => (b ?? a) as T

export const dialog = {
  async showOpenDialog(a: unknown, b?: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }> {
    const o = optionsOf<OpenDialogOptions>(a, b)
    const props = o.properties ?? ['openFile']
    const filePaths = await pick({
      kind: props.includes('openDirectory') ? 'folder' : 'open',
      title: o.title ?? '',
      multi: props.includes('multiSelections'),
      filter: filterText(o.filters),
      initial: o.defaultPath ?? '',
    })
    return { canceled: filePaths.length === 0, filePaths }
  },
  async showSaveDialog(a: unknown, b?: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }> {
    const o = optionsOf<SaveDialogOptions>(a, b)
    const [filePath] = await pick({ kind: 'save', title: o.title ?? '', filter: filterText(o.filters), initial: o.defaultPath ?? '' })
    return filePath ? { canceled: false, filePath } : { canceled: true }
  },
}

// ── lock, sleep, idle ──────────────────────────────────────

/**
 * Lock and unlock, sleep and resume, and idle time, told by the tray helper
 * (one small PowerShell process for the tray, the shortcuts and this).
 */
class PowerMonitor extends EventEmitter {
  private idleSec = 0
  private locked = false

  /** One line from the helper: lock, unlock, resume or "idle <seconds>". */
  feed(line: string) {
    if (line.startsWith('idle ')) this.idleSec = Number(line.slice(5)) || 0
    else if (line === 'lock' && !this.locked) {
      this.locked = true
      this.emit('lock-screen')
    } else if (line === 'unlock' && this.locked) {
      this.locked = false
      this.emit('unlock-screen')
    } else if (line === 'resume') {
      this.emit('suspend')
      this.emit('resume')
    }
  }

  /** Seconds since the last keyboard or mouse input. */
  getSystemIdleTime() {
    return this.idleSec
  }

  stop() {
    this.removeAllListeners()
  }
}

export const powerMonitor = new PowerMonitor()

// ── network ────────────────────────────────────────────────

let online = true
let lastCheck = 0
export const net = {
  fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  /** A cached guess (checked at most every 30 s): the DNS resolver answers. */
  isOnline() {
    if (Date.now() - lastCheck > 30_000) {
      lastCheck = Date.now()
      void lookup('dns.msftncsi.com').then(
        () => (online = true),
        () => (online = false),
      )
    }
    return online
  },
}

