/**
 * Builds and keeps the system map (shared/sysmap.ts) once the owner turns it
 * on: Start-menu apps, the owner's own folders two levels down, git projects
 * under the home folder, VS Code and Cursor recent workspaces (WSL ones
 * too), Claude Code project folders, and git projects inside WSL distros
 * that are already running (indexing never boots one). Rebuilt daily.
 * Names and paths only; Windows, Program Files, AppData and excluded folders
 * are never walked.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { app } from '../host/index.ts'

import { EMPTY_MAP, isProtectedPath, mapCounts, parseWorkspaceUri, SKIP_DIRS, type MapEntry, type MapKind, type SystemMap } from '../../shared/sysmap.ts'
import { claudeSessions } from '../code/discover.ts'

const DAY_MS = 24 * 60 * 60_000
const MAX_FOLDERS = 4000
const MAX_PROJECTS = 800
const WALK_BUDGET_MS = 25_000

interface Saved {
  enabled: boolean
  excluded: string[]
  map: SystemMap
}

const id = (kind: MapKind, key: string) => `${kind[0]}${createHash('sha1').update(key.toLowerCase()).digest('hex').slice(0, 7)}`

const run = (file: string, args: string[], timeoutMs: number, utf16 = false) =>
  new Promise<string>(resolve => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, WSL_UTF8: '1' } }, (_err, stdout) => {
      const buf = stdout as unknown as Buffer
      // wsl.exe writes UTF-16 unless WSL_UTF8 is honoured (older WSL).
      const text = utf16 && buf.length > 1 && buf[1] === 0 ? buf.toString('utf16le') : buf.toString('utf8')
      resolve(text.replace(/\0/g, ''))
    })
  })

export class SystemMapService {
  private saved: Saved
  private building: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly deps: {
      file: string
      apps: () => Promise<{ name: string; id: string }[]>
      /** Atlas's approved code projects, as extra projects. */
      codeProjects: () => { name: string; path: string }[]
      log: (level: 'info' | 'warn', message: string) => void
      onChange: () => void
    },
  ) {
    this.saved = this.read()
  }

  private read(): Saved {
    try {
      const raw = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<Saved>
      return {
        enabled: raw.enabled === true,
        excluded: Array.isArray(raw.excluded) ? raw.excluded.filter((x): x is string => typeof x === 'string') : [],
        map: raw.map && Array.isArray(raw.map.entries) ? raw.map : EMPTY_MAP,
      }
    } catch {
      return { enabled: false, excluded: [], map: EMPTY_MAP }
    }
  }

  private save() {
    try {
      writeFileSync(this.deps.file, JSON.stringify(this.saved))
    } catch (e) {
      this.deps.log('warn', `System map not saved: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  get enabled() {
    return this.saved.enabled
  }

  get map() {
    return this.saved.map
  }

  view() {
    return { enabled: this.saved.enabled, building: this.building !== null, builtAt: this.saved.map.builtAt, counts: mapCounts(this.saved.map), excluded: this.saved.excluded }
  }

  setEnabled(on: boolean) {
    this.saved.enabled = on
    if (!on) this.saved.map = EMPTY_MAP
    this.save()
    this.deps.onChange()
    if (on) void this.build()
    this.schedule()
  }

  setExcluded(paths: string[]) {
    this.saved.excluded = [...new Set(paths.map(p => p.trim()).filter(Boolean))].slice(0, 100)
    this.save()
    this.deps.onChange()
    if (this.saved.enabled) void this.build()
  }

  start() {
    this.schedule()
    if (this.saved.enabled && (!this.saved.map.builtAt || Date.now() - this.saved.map.builtAt > DAY_MS)) void this.build()
  }

  private schedule() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.saved.enabled) return
    this.timer = setInterval(() => void this.build(), DAY_MS)
    this.timer.unref?.()
  }

  private skip(path: string) {
    const p = path.toLowerCase()
    return isProtectedPath(path, homedir()) || this.saved.excluded.some(x => p === x.toLowerCase() || p.startsWith(`${x.toLowerCase()}\\`))
  }

  build(): Promise<void> {
    this.building ??= (async () => {
      this.deps.onChange()
      const started = Date.now()
      const entries = new Map<string, MapEntry>()
      const add = (e: Omit<MapEntry, 'id'>) => {
        const key = `${e.kind}|${e.wsl ?? ''}|${(e.path ?? e.appId ?? e.name).toLowerCase()}`
        const prev = entries.get(key)
        if (prev) {
          if (e.usedAt > prev.usedAt) entries.set(key, { ...prev, usedAt: e.usedAt })
          return
        }
        entries.set(key, { ...e, id: id(e.kind, key) })
      }

      // Apps from the Start menu (Win32 and Store).
      try {
        for (const a of await this.deps.apps()) if (a.name && a.id) add({ kind: 'app', name: a.name, path: null, wsl: null, appId: a.id, source: 'start-menu', usedAt: 0 })
      } catch (e) {
        this.deps.log('warn', `System map: apps unavailable (${e instanceof Error ? e.message : String(e)})`)
      }

      // The owner's own places, two levels down.
      const known = [...new Set(['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'].map(k => app.getPath(k as 'desktop')).concat(process.env.OneDrive ? [process.env.OneDrive] : []))]
      let folders = 0
      const walkFolders = async (dir: string, depth: number) => {
        if (folders >= MAX_FOLDERS || this.skip(dir) || Date.now() - started > WALK_BUDGET_MS) return
        add({ kind: 'folder', name: basename(dir), path: dir, wsl: null, appId: null, source: 'known-folder', usedAt: 0 })
        folders++
        if (depth === 0) return
        const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const c of children) if (c.isDirectory() && !c.name.startsWith('.') && !SKIP_DIRS.has(c.name.toLowerCase())) await walkFolders(join(dir, c.name), depth - 1)
      }
      for (const k of known) if (existsSync(k)) await walkFolders(k, 2)

      // Git projects under the home folder (stops at each project; skips system and tool folders).
      let projects = 0
      const walkProjects = async (dir: string, depth: number) => {
        if (projects >= MAX_PROJECTS || this.skip(dir) || Date.now() - started > WALK_BUDGET_MS) return
        const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
        if (children.some(c => c.name === '.git')) {
          const st = await stat(dir).catch(() => null)
          add({ kind: 'project', name: basename(dir), path: dir, wsl: null, appId: null, source: 'scan', usedAt: st?.mtimeMs ?? 0 })
          projects++
          return
        }
        if (depth === 0) return
        for (const c of children) if (c.isDirectory() && !c.name.startsWith('.') && !SKIP_DIRS.has(c.name.toLowerCase())) await walkProjects(join(dir, c.name), depth - 1)
      }
      await walkProjects(homedir(), 4)

      // Editors' recent workspaces, WSL ones included.
      for (const editor of ['Code', 'Cursor'] as const) {
        const root = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), editor, 'User', 'workspaceStorage')
        const dirs = await readdir(root).catch(() => [] as string[])
        for (const d of dirs) {
          try {
            const meta = JSON.parse(readFileSync(join(root, d, 'workspace.json'), 'utf8')) as { folder?: string }
            const w = meta.folder ? parseWorkspaceUri(meta.folder) : null
            if (!w || (!w.wsl && (this.skip(w.path) || !existsSync(w.path)))) continue
            const st = await stat(join(root, d)).catch(() => null)
            add({ kind: 'project', name: basename(w.path.replace(/[\\/]+$/, '')), path: w.path, wsl: w.wsl, appId: null, source: editor === 'Code' ? 'vscode' : 'cursor', usedAt: st?.mtimeMs ?? 0 })
          } catch {
            // Not a folder workspace.
          }
        }
      }

      // Folders Claude Code worked in, and Atlas's own code projects.
      for (const s of claudeSessions(60)) if (!this.skip(s.cwd) && existsSync(s.cwd)) add({ kind: 'project', name: basename(s.cwd), path: s.cwd, wsl: null, appId: null, source: 'claude', usedAt: s.lastAt })
      for (const p of this.deps.codeProjects()) if (!this.skip(p.path)) add({ kind: 'project', name: p.name, path: p.path, wsl: null, appId: null, source: 'code-project', usedAt: 0 })

      // Git projects inside WSL distros that are already running.
      try {
        const running = (await run('wsl.exe', ['--list', '--running', '--quiet'], 8_000, true)).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        for (const distro of running.slice(0, 4)) {
          const out = await run('wsl.exe', ['-d', distro, '-e', 'sh', '-c', 'cd ~ && echo "HOME=$HOME" && find . -maxdepth 4 -name .git -prune -type d 2>/dev/null | head -300'], 25_000, true)
          const home = /HOME=(\S+)/.exec(out)?.[1] ?? '/root'
          for (const line of out.split(/\r?\n/)) {
            const m = /^\.\/(.+)\/\.git$/.exec(line.trim())
            if (!m) continue
            const path = `${home}/${m[1]}`
            add({ kind: 'project', name: basename(m[1]!), path, wsl: distro, appId: null, source: 'wsl-scan', usedAt: 0 })
          }
        }
      } catch {
        // No WSL here.
      }

      this.saved.map = { builtAt: Date.now(), entries: [...entries.values()] }
      this.save()
      const c = mapCounts(this.saved.map)
      this.deps.log('info', `System map: ${c.apps} apps, ${c.projects} projects, ${c.folders} folders in ${Math.round((Date.now() - started) / 1000)} s.`)
    })()
      .catch(e => this.deps.log('warn', `System map: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.building = null
        this.deps.onChange()
      })
    return this.building
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }
}
