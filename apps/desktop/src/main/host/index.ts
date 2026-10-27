/**
 * What Atlas needs from the machine, in plain Node: where its data lives,
 * opening links and files, the Recycle Bin (the Trash on a Mac), the
 * system's own file pickers, lock / sleep / idle, starting at login, and the
 * network. The names follow the calls the services already made (app,
 * shell, dialog, powerMonitor, net), so they read the same; nothing here
 * needs Electron. Windows, macOS and Linux each have their branch (on a
 * Linux server, with no desktop, the pickers and "open" say so plainly).
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { lookup } from 'node:dns/promises'

import DIALOG_PS1 from './dialog.ps1?raw'

const run = promisify(execFile)
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
export const MAC = process.platform === 'darwin'
export const LINUX = process.platform === 'linux'

/** Same folder the desktop app used, so memory, keys' settings and history carry over (on a Mac, where Mac apps keep theirs; on Linux, under XDG_DATA_HOME). */
const DATA_DIR =
  process.env.ATLAS_DATA_DIR ??
  (MAC
    ? join(homedir(), 'Library', 'Application Support', 'Personal Assistant')
    : LINUX
      ? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'atlas')
      : join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Personal Assistant'))
/** The installed copy's root (where package.json, renderer/ and resources/ sit). */
const ROOT =
  process.env.ATLAS_ROOT ??
  (() => {
    // The nearest folder up with a package.json: out/gateway in a full install, out/gateway/assets for a chunk of the hands.
    let dir = import.meta.dirname
    for (let i = 0; i < 5; i++) {
      dir = resolve(dir, '..')
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'bin'))) return dir
    }
    return resolve(import.meta.dirname, '..', '..')
  })()

type PathName = 'userData' | 'documents' | 'downloads' | 'home' | 'desktop' | 'temp' | 'music' | 'pictures' | 'videos'

const userFolder = (name: 'Documents' | 'Downloads' | 'Desktop' | 'Music' | 'Pictures' | 'Videos') =>
  join(process.env.USERPROFILE ?? homedir(), MAC && name === 'Videos' ? 'Movies' : name)

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

// ── start at login: one value under HKCU\…\Run on Windows, a LaunchAgent on a Mac ─────────

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'Atlas'
/** The command Windows runs at login: the launcher that starts Atlas without a console window, plus the args. */
const loginCommand = (args: string[]) => {
  const launcher = join(ROOT, 'bin', 'atlas-start.vbs')
  return existsSync(launcher) ? [`wscript.exe "${launcher}"`, ...args].join(' ') : [`"${process.execPath}"`, `"${resolve(process.argv[1] ?? '')}"`, ...args].join(' ')
}

/** On a Mac: ~/Library/LaunchAgents, read by launchd at the next login. */
const AGENT = join(homedir(), 'Library', 'LaunchAgents', 'com.github.atlas-assistant.plist')
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const macLogin = {
  read: () => (existsSync(AGENT) ? readFileSync(AGENT, 'utf8') : null),
  set(on: boolean, args: string[]) {
    if (!on) return rmSync(AGENT, { force: true })
    const argv = [process.execPath, join(ROOT, 'bin', 'atlas.mjs'), 'start', ...args]
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(
      AGENT,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.github.atlas-assistant</string>
  <key>ProgramArguments</key>
  <array>${argv.map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`,
    )
  },
}

const loginItem = {
  read(): string | null {
    if (MAC) return macLogin.read()
    // Linux: install.sh sets up a systemd service; nothing to switch from here.
    if (LINUX) return null
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
      if (MAC) return macLogin.set(on, args)
      if (LINUX) return
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

/** A Linux machine with a desktop to show things on (a server has none). */
const hasDisplay = () => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

/** Opens with whatever the system uses for it (rundll32 on Windows, `open` on a Mac, xdg-open on Linux), without a shell parsing the text. */
const openWithWindows = (target: string) =>
  new Promise<string>(res => {
    if (LINUX && !hasDisplay()) return res('This machine has no screen to open things on (a server). Open it on a PC connected to Atlas.')
    const child = MAC
      ? spawn('open', [target], { detached: true, stdio: 'ignore' })
      : LINUX
        ? spawn('xdg-open', [target], { detached: true, stdio: 'ignore' })
        : spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target], { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', e => res(LINUX && (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'xdg-open is not installed here.' : e.message))
    child.once('spawn', () => {
      child.unref()
      res('')
    })
  })

export const shell = {
  /** Web and mail links only. */
  async openExternal(url: string): Promise<void> {
    if (!/^(https?:|mailto:|ms-settings:|x-apple\.systempreferences:|vscode:|cursor:|windsurf:)/i.test(url)) throw new Error('Only web, mail and settings links open from here.')
    const err = await openWithWindows(url)
    if (err) throw new Error(err)
  },
  /** Opens a file or folder; '' when it worked, else the reason (as Electron did). */
  async openPath(path: string): Promise<string> {
    if (!existsSync(path)) return `${path} does not exist.`
    return openWithWindows(path)
  },
  showItemInFolder(path: string) {
    if (MAC) spawn('open', ['-R', path], { detached: true, stdio: 'ignore' }).unref()
    else if (LINUX) void openWithWindows(dirname(path))
    else spawn('explorer.exe', [`/select,${path}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  },
  /** To the Recycle Bin (the Trash on a Mac), never deleted outright. */
  async trashItem(path: string): Promise<void> {
    if (MAC) return macTrash(path)
    if (LINUX) return linuxTrash(path)
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:ATLAS_TRASH; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`
    await run('powershell.exe', [...PS, '-Command', script], { windowsHide: true, env: { ...process.env, ATLAS_TRASH: path } })
  },
}

/**
 * Into ~/.Trash under a free name (no "allow controlling Finder" prompt).
 * Another disk has its own Trash: Finder moves it there.
 */
const macTrash = async (path: string) => {
  const trash = join(homedir(), '.Trash')
  const ext = extname(path)
  const stem = basename(path, ext)
  let to = join(trash, basename(path))
  for (let i = 2; existsSync(to); i++) to = join(trash, `${stem} ${i}${ext}`)
  try {
    renameSync(path, to)
  } catch {
    await run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run', path])
  }
}

/**
 * Linux: the desktop's own trash (gio, which knows every disk's trash), else
 * the freedesktop.org trash folder by hand, with its .trashinfo note so the
 * file manager can put it back.
 */
const linuxTrash = async (path: string) => {
  try {
    await run('gio', ['trash', '--', path])
    return
  } catch {
    // No gio (a bare server): by hand.
  }
  const root = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'Trash')
  mkdirSync(join(root, 'files'), { recursive: true })
  mkdirSync(join(root, 'info'), { recursive: true })
  const ext = extname(path)
  const stem = basename(path, ext)
  let name = basename(path)
  for (let i = 2; existsSync(join(root, 'files', name)); i++) name = `${stem}.${i}${ext}`
  writeFileSync(join(root, 'info', `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(resolve(path))}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`)
  renameSync(path, join(root, 'files', name))
}

// ── the system's own file pickers, shown on the PC ─────────────────

/** Linux: zenity's pickers when the desktop has it; a server has no picker (the owner types the path). */
const linuxPick = async (r: { kind: 'open' | 'folder' | 'save'; title: string; multi?: boolean; initial: string }): Promise<string[]> => {
  if (!hasDisplay()) throw new Error('This machine has no screen for a file picker (a server). Type the path, or pick it on a PC connected to Atlas.')
  const args = ['--file-selection', `--title=${r.title || 'Choose'}`, '--separator=\n']
  if (r.kind === 'folder') args.push('--directory')
  if (r.kind === 'save') args.push('--save', '--confirm-overwrite')
  if (r.multi) args.push('--multiple')
  if (r.initial) args.push(`--filename=${r.initial}`)
  try {
    const { stdout } = await run('zenity', args, { maxBuffer: 1 << 20 })
    return stdout
      .split('\n')
      .map(p => p.trim())
      .filter(Boolean)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No file picker here: install zenity, or type the path.')
    // Cancel: nothing chosen.
    return []
  }
}

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


/**
 * A Mac's own pickers (AppleScript's choose file / folder / file name). The
 * title, place and file types go in as arguments, never into the script text.
 */
const macPick = async (r: { kind: 'open' | 'folder' | 'save'; title: string; multi?: boolean; initial: string; types?: string[] }): Promise<string[]> => {
  const where = r.initial ? (r.kind === 'save' ? resolve(r.initial, '..') : r.initial) : ''
  const lines = ['on run argv', 'set t to item 1 of argv', 'set w to item 2 of argv']
  if (r.kind === 'save') {
    lines.push('set n to item 3 of argv', 'if w is not "" then', 'set f to choose file name with prompt t default name n default location (POSIX file w)', 'else', 'set f to choose file name with prompt t default name n', 'end if', 'return POSIX path of f')
  } else {
    const verb = r.kind === 'folder' ? 'choose folder' : 'choose file'
    const many = r.multi ? ' with multiple selections allowed' : ''
    const types = r.kind === 'open' && r.types?.length ? ` of type {${r.types.map(t => JSON.stringify(t)).join(', ')}}` : ''
    lines.push(
      'if w is not "" then',
      `set picked to (${verb} with prompt t default location (POSIX file w)${types}${many})`,
      'else',
      `set picked to (${verb} with prompt t${types}${many})`,
      'end if',
      'if class of picked is not list then set picked to {picked}',
      'set out to ""',
      'repeat with p in picked',
      'set out to out & POSIX path of p & linefeed',
      'end repeat',
      'return out',
    )
  }
  lines.push('end run')
  try {
    const { stdout } = await run('osascript', [...lines.flatMap(l => ['-e', l]), r.title || 'Choose', where, r.kind === 'save' ? basename(r.initial || 'Untitled') : ''], { maxBuffer: 1 << 20 })
    return stdout
      .split('\n')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => (p.length > 1 ? p.replace(/\/$/, '') : p))
  } catch {
    // Cancel (error -128) or no picker: nothing chosen.
    return []
  }
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
    if (MAC) {
      const filePaths = await macPick({ kind: props.includes('openDirectory') ? 'folder' : 'open', title: o.title ?? '', multi: props.includes('multiSelections'), initial: o.defaultPath ?? '', types: (o.filters ?? []).flatMap(f => f.extensions).filter(e => e !== '*') })
      return { canceled: filePaths.length === 0, filePaths }
    }
    if (LINUX) {
      const filePaths = await linuxPick({ kind: props.includes('openDirectory') ? 'folder' : 'open', title: o.title ?? '', multi: props.includes('multiSelections'), initial: o.defaultPath ?? '' })
      return { canceled: filePaths.length === 0, filePaths }
    }
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
    if (MAC || LINUX) {
      const [filePath] = await (MAC ? macPick : linuxPick)({ kind: 'save', title: o.title ?? '', initial: o.defaultPath ?? '' })
      return filePath ? { canceled: false, filePath } : { canceled: true }
    }
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
  private asleep = false

  /** One line from the helper: lock, unlock, resume or "idle <seconds>". */
  feed(line: string) {
    if (line.startsWith('idle ')) this.idleSec = Number(line.slice(5)) || 0
    else if (line === 'lock' && !this.locked) {
      this.locked = true
      this.emit('lock-screen')
    } else if (line === 'unlock' && this.locked) {
      this.locked = false
      this.emit('unlock-screen')
    } else if (line === 'suspend' || line === 'shutdown') {
      // Told as it goes to sleep (or shuts down): the session ends now, not when it wakes.
      if (!this.asleep) this.emit('suspend')
      this.asleep = true
    } else if (line === 'resume') {
      // Woke: a sleep nobody told of (a jump in time) ends the session first.
      if (!this.asleep) this.emit('suspend')
      this.asleep = false
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

/**
 * A Mac has no tray helper yet: idle time comes from the input system
 * (HIDIdleTime, in nanoseconds), and a jump in the clock means it slept.
 */
if (MAC && process.env.VITEST === undefined) {
  let last = Date.now()
  const tick = async () => {
    const now = Date.now()
    if (now - last > 90_000) powerMonitor.feed('resume')
    last = now
    try {
      const { stdout } = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'])
      const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout)?.[1]
      if (ns) powerMonitor.feed(`idle ${Math.floor(Number(ns) / 1e9)}`)
    } catch {
      // No reading this time.
    }
  }
  setInterval(() => void tick(), 15_000).unref()
}

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

