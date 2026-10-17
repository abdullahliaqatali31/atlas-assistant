/**
 * Dev servers Atlas starts for the owner: only commands they approved as run
 * profiles, in the project's own folder. Keeps the last lines of output,
 * notices the local URL and errors, tells when one crashes, and stops the
 * whole process tree. Everything stops when Atlas quits.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { commandProblem, findLocalUrl, looksLikeError, stripAnsi, type RunProfile, type RunView } from '../../shared/code.ts'

const MAX_LINES = 500
/** Treated as up once alive this long, even if it never prints a URL. */
const UP_AFTER_MS = 6_000
/** Finished runs stay visible this long, so a crash can be read. */
const KEEP_FINISHED_MS = 30 * 60_000

interface Run {
  view: RunView
  child: ChildProcess
  lines: string[]
  stopping: boolean
}

export class Runner {
  private readonly runs = new Map<string, Run>()

  constructor(private readonly deps: { onChange: () => void; onCrash: (run: RunView) => void }) {}

  list(): RunView[] {
    const now = Date.now()
    for (const [id, r] of this.runs) if (r.view.endedAt && now - r.view.endedAt > KEEP_FINISHED_MS) this.runs.delete(id)
    return [...this.runs.values()].map(r => ({ ...r.view })).sort((a, b) => b.startedAt - a.startedAt)
  }

  /** The run of this profile that is still going, if any. */
  active(projectId: string, profileId?: string) {
    return [...this.runs.values()].filter(r => r.view.projectId === projectId && !r.view.endedAt && (!profileId || r.view.profile === profileId))
  }

  start(project: { id: string; name: string; path: string }, profile: RunProfile): RunView {
    const problem = commandProblem(profile.command)
    if (problem) throw new Error(problem)
    const already = [...this.runs.values()].find(r => r.view.projectId === project.id && r.view.profile === profile.name && !r.view.endedAt)
    if (already) return { ...already.view }
    const cwd = profile.cwd ? join(project.path, ...profile.cwd.split('/')) : project.path
    // One approved command line through cmd.exe (npm and friends are .cmd files on Windows).
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', profile.command], {
      cwd,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' },
    })
    const view: RunView = {
      id: randomUUID(),
      projectId: project.id,
      projectName: project.name,
      profile: profile.name,
      command: profile.command,
      state: 'starting',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      url: null,
      lastError: null,
    }
    const run: Run = { view, child, lines: [], stopping: false }
    this.runs.set(view.id, run)
    const up = setTimeout(() => {
      if (view.state === 'starting') {
        view.state = 'running'
        this.deps.onChange()
      }
    }, UP_AFTER_MS)
    let pending = ''
    const onData = (b: Buffer) => {
      pending += b.toString()
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() ?? ''
      let changed = false
      for (const raw of parts) {
        const line = stripAnsi(raw).trimEnd()
        if (!line) continue
        run.lines.push(line)
        if (run.lines.length > MAX_LINES) run.lines.shift()
        const url = view.url ? null : findLocalUrl(line)
        if (url) {
          view.url = url
          view.state = 'running'
          changed = true
        }
        if (looksLikeError(line)) {
          view.lastError = line.slice(0, 300)
          changed = true
        }
      }
      if (changed) this.deps.onChange()
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', err => {
      view.lastError = err.message
    })
    child.on('exit', code => {
      clearTimeout(up)
      view.endedAt = Date.now()
      view.exitCode = code
      view.state = run.stopping || code === 0 ? 'exited' : 'crashed'
      this.deps.onChange()
      if (view.state === 'crashed') this.deps.onCrash({ ...view })
    })
    this.deps.onChange()
    return { ...view }
  }

  logs(runId: string, n = 200): string[] {
    return this.runs.get(runId)?.lines.slice(-n) ?? []
  }

  /** Stops the whole process tree (cmd.exe, npm, node and the server it spawned). */
  stop(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || run.view.endedAt || !run.child.pid) return Promise.resolve()
    run.stopping = true
    return new Promise(resolve => execFile('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
  }

  async stopAll() {
    await Promise.all([...this.runs.keys()].map(id => this.stop(id)))
  }

  /** Synchronous last resort when Atlas is quitting. */
  killAllNow() {
    for (const r of this.runs.values()) {
      if (r.view.endedAt || !r.child.pid) continue
      r.stopping = true
      try {
        execFile('taskkill', ['/PID', String(r.child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        // Already gone.
      }
    }
  }
}
