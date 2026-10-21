/**
 * Code projects, main side: the folders the owner approved (code.json), the
 * daily activity history (code-history.json), scans every 30 minutes, the
 * dev server runner, .atlas/STATUS.md and the global instruction blocks for
 * coding agents. The window and the runtime's tools both go through here.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'

import { app, dialog, shell, type OpenDialogOptions } from '../host/index.ts'

import {
  activityScore,
  EMPTY_DAY,
  hasAgentBlock,
  isAccess,
  isId,
  KC,
  parseProfile,
  setStatusSection,
  STATUS_FILE,
  statusTemplate,
  sumDays,
  withAgentBlock,
  type Access,
  type CodeOp,
  type CodeProjectView,
  type CodeState,
  type DayStats,
  type RunProfile,
  type RunView,
  type Suggestion,
} from '../../shared/code.ts'
import { claudeSessions, discover, notAProject } from './discover.ts'
import { Runner } from './runner.ts'
import { openInVsCode } from '../system/vscode.ts'
import { dayKey, lastDays, scanProject, type ScanResult } from './scan.ts'

const SCAN_EVERY_MS = 30 * 60_000
const HISTORY_DAYS = 90

interface StoredProject {
  id: string
  path: string
  name: string
  access: Access
  addedAt: number
  profiles: RunProfile[]
}

interface CodeFile {
  projects: StoredProject[]
  dismissed: string[]
}

export interface CodeDeps {
  handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
  toRenderer: (channel: string, payload: unknown) => void
  /** Latest projects and runs for the runtime's tools, briefing and questions. */
  toRuntime: (snapshot: { projects: CodeProjectView[]; running: RunView[] }) => void
  window: () => unknown
  requireOwner: () => void
  log: (level: 'info' | 'warn', message: string) => void
}

const AGENT_FILES = {
  claude: { dir: join(homedir(), '.claude'), file: join(homedir(), '.claude', 'CLAUDE.md') },
  codex: { dir: join(homedir(), '.codex'), file: join(homedir(), '.codex', 'AGENTS.md') },
} as const

const readText = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

const writeAtomic = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(`${p}.tmp`, text)
  renameSync(`${p}.tmp`, p)
}

export class CodeService {
  private readonly file = join(app.getPath('userData'), 'code.json')
  private readonly historyFile = join(app.getPath('userData'), 'code-history.json')
  private data: CodeFile
  private history: Record<string, Record<string, DayStats>>
  private scans = new Map<string, ScanResult>()
  private suggestions: Suggestion[] = []
  private scanning: Promise<void> | null = null
  private lastScanAt: number | null = null
  private timer: NodeJS.Timeout | null = null
  readonly runner: Runner

  constructor(private readonly deps: CodeDeps) {
    this.data = this.load()
    this.history = this.loadHistory()
    this.runner = new Runner({
      onChange: () => this.publish(),
      onCrash: run => this.deps.log('warn', `${run.projectName} (${run.profile}) stopped unexpectedly${run.lastError ? `: ${run.lastError}` : ''}`),
    })
  }

  private load(): CodeFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CodeFile>
      return { projects: Array.isArray(raw.projects) ? raw.projects : [], dismissed: Array.isArray(raw.dismissed) ? raw.dismissed : [] }
    } catch {
      return { projects: [], dismissed: [] }
    }
  }

  private save() {
    writeAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`)
  }

  private loadHistory(): Record<string, Record<string, DayStats>> {
    try {
      return JSON.parse(readFileSync(this.historyFile, 'utf8')) as Record<string, Record<string, DayStats>>
    } catch {
      return {}
    }
  }

  /**
   * Merges a scan into the history. File and session counts only see each
   * file's last change, so a day keeps the highest count ever measured.
   */
  private remember(id: string, days: Record<string, DayStats>) {
    const h = (this.history[id] ??= {})
    for (const [day, d] of Object.entries(days)) {
      const prev = h[day] ?? EMPTY_DAY
      h[day] = { commits: d.commits, added: d.added, removed: d.removed, files: Math.max(prev.files, d.files), sessions: Math.max(prev.sessions, d.sessions), minutes: prev.minutes }
    }
    const keep = new Set(lastDays(Date.now(), HISTORY_DAYS))
    for (const day of Object.keys(h)) if (!keep.has(day)) delete h[day]
  }

  private view(p: StoredProject): CodeProjectView {
    const scan = this.scans.get(p.id)
    const h = this.history[p.id] ?? {}
    const days = lastDays(Date.now())
    const stats = days.map(d => h[d] ?? EMPTY_DAY)
    const base: Omit<CodeProjectView, 'today' | 'week' | 'trend'> = scan?.view
      ? { ...scan.view, name: p.name, access: p.access, profiles: p.profiles }
      : { id: p.id, name: p.name, path: p.path, access: p.access, exists: existsSync(p.path), stack: [], git: null, lastActivityAt: null, sessionTitles: [], status: null, profiles: p.profiles, suggestedProfiles: [] }
    return { ...base, today: stats.at(-1) ?? EMPTY_DAY, week: sumDays(stats.slice(-7)), trend: stats.map(activityScore) }
  }

  state(): CodeState {
    const approved = new Set(this.data.projects.map(p => p.path.toLowerCase()))
    const dismissed = new Set(this.data.dismissed.map(d => d.toLowerCase()))
    const agent = (k: keyof typeof AGENT_FILES) => ({ available: existsSync(AGENT_FILES[k].dir), enabled: hasAgentBlock(readText(AGENT_FILES[k].file)), file: AGENT_FILES[k].file })
    return {
      projects: this.data.projects.map(p => this.view(p)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
      suggestions: this.suggestions.filter(s => !approved.has(s.path.toLowerCase()) && !dismissed.has(s.path.toLowerCase())).slice(0, 20),
      running: this.runner.list(),
      agents: { claude: agent('claude'), codex: agent('codex') },
      scanning: this.scanning !== null,
      lastScanAt: this.lastScanAt,
    }
  }

  /** Sent to a (re)started runtime so its tools know the projects at once. */
  snapshotMessage() {
    const s = this.state()
    return { type: 'code-snapshot' as const, projects: s.projects, running: s.running }
  }

  private publish() {
    const s = this.state()
    this.deps.toRenderer(KC.changed, s)
    this.deps.toRuntime({ projects: s.projects, running: s.running })
  }

  /** Scans every approved project and refreshes suggestions; one at a time. */
  scan(): Promise<void> {
    this.scanning ??= (async () => {
      this.publish()
      try {
        const sessions = claudeSessions()
        this.suggestions = discover(sessions)
        for (const p of this.data.projects) {
          const r = await scanProject(p, sessions)
          this.scans.set(p.id, r)
          this.remember(p.id, r.days)
        }
        writeAtomic(this.historyFile, JSON.stringify(this.history))
        this.lastScanAt = Date.now()
      } catch (error) {
        this.deps.log('warn', `Project scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })().finally(() => {
      this.scanning = null
      this.publish()
    })
    return this.scanning
  }

  start() {
    setTimeout(() => void this.scan(), 5_000)
    this.timer = setInterval(() => void this.scan(), SCAN_EVERY_MS)
    this.timer.unref()
    app.on('before-quit', () => this.runner.killAllNow())
  }

  /** VS Code window minutes measured by the runtime (window tracking), merged into today's history. */
  setMinutes(byProject: Record<string, number>) {
    const today = dayKey(Date.now())
    for (const [id, minutes] of Object.entries(byProject)) {
      const h = (this.history[id] ??= {})
      h[today] = { ...(h[today] ?? EMPTY_DAY), minutes }
    }
  }

  private project(id: unknown): StoredProject {
    const p = isId(id) ? this.data.projects.find(x => x.id === id) : undefined
    if (!p) throw new Error('No such project.')
    return p
  }

  /** By name, loosely, for the model's tools ("csi" finds "CSi-centralized-system"). */
  private byName(name: string): StoredProject {
    const n = name.trim().toLowerCase()
    const exact = this.data.projects.find(p => p.name.toLowerCase() === n)
    if (exact) return exact
    const loose = this.data.projects.filter(p => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()))
    if (loose.length === 1) return loose[0]!
    throw new Error(loose.length ? `Which one: ${loose.map(p => p.name).join(', ')}?` : `No approved project called "${name}". Approved: ${this.data.projects.map(p => p.name).join(', ') || 'none yet'}.`)
  }

  add(path: string) {
    const p = normalize(resolve(path))
    if (!existsSync(p)) throw new Error('That folder does not exist.')
    if (notAProject(p) || p.toLowerCase().startsWith(normalize(app.getPath('userData')).toLowerCase())) throw new Error('Pick a project folder, not a drive, your home folder or app data.')
    if (!this.data.projects.some(x => x.path.toLowerCase() === p.toLowerCase())) {
      this.data.projects.push({ id: randomUUID(), path: p, name: basename(p), access: 'see', addedAt: Date.now(), profiles: [] })
      this.save()
    }
    void this.scan()
  }

  private async pick() {
    const win = this.deps.window()
    const opts: OpenDialogOptions = { title: 'Project folders Atlas may follow', properties: ['openDirectory', 'multiSelections'] }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled) return
    for (const f of picked.filePaths) this.add(f)
  }

  /** Writes .atlas/STATUS.md and keeps .atlas/ out of git through the repo's private exclude file. */
  createStatus(p: StoredProject) {
    if (p.access === 'see') throw new Error('Give Atlas "status file" access to this project first.')
    const file = join(p.path, ...STATUS_FILE.split('/'))
    if (!existsSync(file)) writeAtomic(file, statusTemplate(p.name, p.profiles.map(x => `- ${x.name}: \`${x.command}\`${x.cwd ? ` (in ${x.cwd})` : ''}`).join('\n')))
    const exclude = join(p.path, '.git', 'info', 'exclude')
    if (existsSync(join(p.path, '.git')) && !readText(exclude).split(/\r?\n/).includes('.atlas/')) {
      mkdirSync(dirname(exclude), { recursive: true })
      appendFileSync(exclude, `${readText(exclude).endsWith('\n') || !readText(exclude) ? '' : '\n'}.atlas/\n`)
    }
  }

  setAgent(kind: 'claude' | 'codex', on: boolean) {
    const target = AGENT_FILES[kind]
    if (!existsSync(target.dir)) throw new Error(`${kind === 'claude' ? 'Claude Code' : 'Codex'} is not set up on this PC.`)
    const next = withAgentBlock(readText(target.file), on)
    writeAtomic(target.file, next)
  }

  /** Requests from the runtime's tools. */
  async handleOp(op: CodeOp): Promise<string> {
    switch (op.kind) {
      case 'start': {
        const p = this.byName(op.project)
        if (p.access !== 'run') return `${p.name} is not allowed to run commands yet. In Projects › Code, set its access to "See + status + run".`
        if (p.profiles.length === 0) return `${p.name} has no approved run commands yet. Approve one in Projects › Code (suggestions are listed there).`
        const wanted = op.profile?.trim().toLowerCase()
        const profile = wanted ? p.profiles.find(x => x.name.toLowerCase() === wanted) ?? p.profiles.find(x => x.name.toLowerCase().includes(wanted)) : p.profiles[0]
        if (!profile) return `No run command "${op.profile}" for ${p.name}. Approved: ${p.profiles.map(x => x.name).join(', ')}.`
        const run = this.runner.start(p, profile)
        // Give it a moment to print its address or fail.
        await new Promise(r => setTimeout(r, 4_000))
        const now = this.runner.list().find(r => r.id === run.id) ?? run
        return now.state === 'crashed'
          ? `${p.name} ${profile.name} failed to start${now.lastError ? `: ${now.lastError}` : ''}.`
          : `Started ${p.name} (${profile.name}: ${profile.command})${now.url ? ` at ${now.url}` : ''}.`
      }
      case 'stop': {
        const targets = op.project ? this.runner.list().filter(r => r.projectId === this.byName(op.project!).id && !r.endedAt) : this.runner.list().filter(r => !r.endedAt)
        if (!targets.length) return op.project ? 'Nothing of that project is running.' : 'Nothing is running.'
        await Promise.all(targets.map(r => this.runner.stop(r.id)))
        return `Stopped ${targets.map(r => `${r.projectName} (${r.profile})`).join(', ')}.`
      }
      case 'logs': {
        const p = this.byName(op.project)
        const run = this.runner.list().find(r => r.projectId === p.id)
        if (!run) return `${p.name} has not been started by Atlas.`
        return this.runner.logs(run.id, Math.min(op.lines ?? 60, 200)).join('\n') || '(no output yet)'
      }
      case 'status': {
        const p = this.byName(op.project)
        if (p.access === 'see') return `Atlas may not write in ${p.name}; its access is "see activity" only.`
        this.createStatus(p)
        const file = join(p.path, ...STATUS_FILE.split('/'))
        writeAtomic(file, setStatusSection(readText(file), op.section, op.text.slice(0, 4000)))
        void this.scan()
        return `Updated "${op.section}" in ${p.name}/${STATUS_FILE}.`
      }
      case 'brief': {
        const p = this.byName(op.project)
        if (p.access === 'see') throw new Error(`Atlas may not write in ${p.name}; give it "See + status file" access in Projects › Code.`)
        if (!/^[\w-]{1,80}\.md$/.test(op.file)) throw new Error('Invalid brief file name.')
        // Also keeps .atlas/ out of git.
        this.createStatus(p)
        const rel = `.atlas/improvements/${op.file}`
        writeAtomic(join(p.path, ...rel.split('/')), op.text.slice(0, 20_000))
        return `${p.name}/${rel}`
      }
    }
  }

  register() {
    const { handle } = this.deps
    const owner = <T>(fn: (a: unknown, b: unknown) => T | Promise<T>) => (a: unknown, b: unknown) => {
      this.deps.requireOwner()
      return fn(a, b)
    }
    const after = async (fn: () => unknown) => {
      await fn()
      this.publish()
      return this.state()
    }
    handle(KC.state, owner(() => this.state()))
    handle(KC.add, owner(path => after(() => {
      if (typeof path !== 'string') throw new Error('Expected a folder.')
      this.add(path)
    })))
    handle(KC.pick, owner(() => after(() => this.pick())))
    handle(KC.remove, owner(id => after(async () => {
      const p = this.project(id)
      await Promise.all(this.runner.active(p.id).map(r => this.runner.stop(r.view.id)))
      this.data.projects = this.data.projects.filter(x => x.id !== p.id)
      this.scans.delete(p.id)
      delete this.history[p.id]
      this.save()
    })))
    handle(KC.setAccess, owner((id, access) => after(() => {
      if (!isAccess(access)) throw new Error('Unknown access level.')
      this.project(id).access = access
      this.save()
    })))
    handle(KC.dismiss, owner(path => after(() => {
      if (typeof path !== 'string' || path.length > 500) throw new Error('Expected a folder.')
      this.data.dismissed = [...new Set([...this.data.dismissed, normalize(path)])]
      this.save()
    })))
    handle(KC.scan, owner(() => after(() => this.scan())))
    handle(KC.start, owner((id, profileId) => after(() => {
      const p = this.project(id)
      if (p.access !== 'run') throw new Error('Set this project’s access to "See + status + run" first.')
      const profile = p.profiles.find(x => x.id === profileId)
      if (!profile) throw new Error('No such run command.')
      this.runner.start(p, profile)
    })))
    handle(KC.stop, owner(runId => after(() => (typeof runId === 'string' ? this.runner.stop(runId) : undefined))))
    handle(KC.stopAll, owner(() => after(() => this.runner.stopAll())))
    handle(KC.logs, owner(runId => (typeof runId === 'string' ? this.runner.logs(runId, 400) : [])))
    handle(KC.addProfile, owner((id, raw) => after(() => {
      const p = this.project(id)
      const profile = parseProfile(raw)
      if (typeof profile === 'string') throw new Error(profile)
      if (p.profiles.some(x => x.name.toLowerCase() === profile.name.toLowerCase())) throw new Error(`There is already a "${profile.name}".`)
      p.profiles.push({ id: randomUUID(), ...profile })
      this.save()
    })))
    handle(KC.removeProfile, owner((id, profileId) => after(() => {
      const p = this.project(id)
      p.profiles = p.profiles.filter(x => x.id !== profileId)
      this.save()
    })))
    handle(KC.createStatus, owner(id => after(() => {
      this.createStatus(this.project(id))
      return this.scan()
    })))
    handle(KC.setAgent, owner((kind, on) => after(() => {
      if (kind !== 'claude' && kind !== 'codex') throw new Error('Unknown agent.')
      this.setAgent(kind, on === true)
    })))
    handle(KC.openEditor, owner(id => {
      const p = this.project(id)
      // Its own window: projects already open in VS Code stay open.
      void openInVsCode(p.path, null)
    }))
    handle(KC.openUrl, owner(runId => {
      const run = this.runner.list().find(r => r.id === runId)
      // Only the local address the server itself printed.
      if (run?.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(run.url)) void shell.openExternal(run.url)
    }))
  }
}
