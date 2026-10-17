import { Bot, Code2, ExternalLink, FileText, FolderPlus, GitBranch, Play, Plus, RefreshCw, ScrollText, Square, Terminal, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { ACCESS_LABEL, ACCESS_LEVELS, type Access, type CodeProjectView, type CodeState, type DayStats, type RunProfile, type RunView } from '../../shared/code.ts'
import { Select } from './ui/Select.tsx'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

const ago = (t: number | null) => {
  if (!t) return 'no activity yet'
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 36 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const dayLine = (d: DayStats) =>
  [d.commits ? `${d.commits} commit${d.commits === 1 ? '' : 's'}` : '', d.files ? `${d.files} files` : '', d.sessions ? `${d.sessions} Claude session${d.sessions === 1 ? '' : 's'}` : '', d.minutes ? `${d.minutes}m in VS Code` : '']
    .filter(Boolean)
    .join(' · ') || 'quiet'

const RUN_TONE: Record<RunView['state'], string> = { starting: 'bg-warm thinking-dot', running: 'bg-ok', exited: 'bg-muted', crashed: 'bg-danger' }

type Tab = 'overview' | 'running' | 'folders'
type Run = (fn: () => Promise<CodeState>) => Promise<void>

/**
 * Your coding projects: what you worked on (measured from git, edited files,
 * Claude Code sessions and VS Code time), what Atlas is running for you, and
 * which folders it may follow. Nothing is followed until you add it.
 */
export function CodeProjects() {
  const [state, setState] = useState<CodeState | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.code.state().then(setState, err => setError(cleanError(err)))
    return window.code.onChanged(setState)
  }, [])

  const run: Run = useCallback(async fn => {
    setError('')
    try {
      setState(await fn())
    } catch (err) {
      setError(cleanError(err))
    }
  }, [])

  if (!state) return <p className="p-6 text-sm text-muted">{error || 'Loading…'}</p>
  const live = state.running.filter(r => !r.endedAt)
  const project = state.projects.find(p => p.id === selected) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="flex rounded-xl border border-border bg-bg p-0.5" role="tablist" aria-label="Code views">
          {(
            [
              ['overview', `Projects (${state.projects.length})`],
              ['running', `Running (${live.length})`],
              ['folders', 'Folders & agents'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${tab === id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted">{state.scanning ? 'Scanning…' : state.lastScanAt ? `Updated ${ago(state.lastScanAt)}` : ''}</span>
        <button type="button" className="btn" onClick={() => void run(() => window.code.scan())} disabled={state.scanning} title="Measure activity now">
          <RefreshCw className={`size-3.5 ${state.scanning ? 'animate-spin' : ''}`} aria-hidden /> Scan
        </button>
        {live.length > 0 && (
          <button type="button" className="btn btn-danger" onClick={() => void run(() => window.code.stopAll())}>
            <Square className="size-3.5" aria-hidden /> Stop all
          </button>
        )}
      </header>
      {error && <p className="border-b border-border px-4 py-2 text-xs text-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'overview' &&
          (project ? (
            <ProjectDetail project={project} state={state} run={run} onBack={() => setSelected(null)} onError={setError} />
          ) : (
            <Overview state={state} onOpen={setSelected} onFolders={() => setTab('folders')} />
          ))}
        {tab === 'running' && <Running state={state} run={run} />}
        {tab === 'folders' && <Folders state={state} run={run} />}
      </div>
    </div>
  )
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  return (
    <span className="flex h-6 items-end gap-[2px]" aria-label="Activity, last 14 days">
      {values.map((v, i) => (
        <span key={i} className={`w-1.5 rounded-sm ${v > 0 ? 'bg-accent' : 'bg-surface-strong'}`} style={{ height: `${Math.max(8, (v / max) * 100)}%`, opacity: i === values.length - 1 ? 1 : 0.55 + (0.4 * i) / values.length }} />
      ))}
    </span>
  )
}

function Overview({ state, onOpen, onFolders }: { state: CodeState; onOpen: (id: string) => void; onFolders: () => void }) {
  if (state.projects.length === 0) {
    return (
      <div className="mx-auto max-w-md space-y-3 pt-10 text-center text-sm text-muted">
        <Code2 className="mx-auto size-8 text-accent" aria-hidden />
        <p>Add the folders you code in, and I’ll keep track of what you worked on, start your dev servers when you ask, and keep a status file your coding agents update.</p>
        <button type="button" className="btn btn-primary" onClick={onFolders}>
          <FolderPlus className="size-3.5" aria-hidden /> Choose project folders
        </button>
        {state.suggestions.length > 0 && <p className="text-xs">I found {state.suggestions.length} folders from VS Code and Claude Code you could add.</p>}
      </div>
    )
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {state.projects.map(p => {
        const live = state.running.filter(r => r.projectId === p.id && !r.endedAt)
        return (
          <button key={p.id} type="button" onClick={() => onOpen(p.id)} className="tile rise-in space-y-2 p-3 text-left transition-colors hover:border-accent/40">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate font-medium">
                  {live.length > 0 && <span className="size-2 shrink-0 rounded-full bg-ok" title={`${live.length} running`} />}
                  {p.name}
                </p>
                <p className="truncate text-[11px] text-muted">{p.exists ? (p.stack.join(' · ') || p.path) : 'Folder not found'}</p>
              </div>
              <Sparkline values={p.trend} />
            </div>
            <p className="text-xs">
              <span className="text-muted">Today:</span> {dayLine(p.today)}
            </p>
            <p className="text-[11px] text-muted">
              Week: {dayLine(p.week)} · last active {ago(p.lastActivityAt)}
            </p>
            {p.git && (
              <p className="flex items-center gap-1 truncate text-[11px] text-muted">
                <GitBranch className="size-3 shrink-0" aria-hidden /> {p.git.branch}
                {p.git.uncommitted ? ` · ${p.git.uncommitted} uncommitted` : ''}
                {p.git.lastCommit ? ` · “${p.git.lastCommit}”` : ''}
              </p>
            )}
            {p.status?.next && (
              <p className="line-clamp-2 text-xs" dir="auto">
                <span className="text-accent">Next:</span> {p.status.next.replace(/^[-*]\s*/gm, '').replace(/\n/g, ' · ')}
              </p>
            )}
          </button>
        )
      })}
    </div>
  )
}

function ProjectDetail({ project: p, state, run, onBack, onError }: { project: CodeProjectView; state: CodeState; run: Run; onBack: () => void; onError: (e: string) => void }) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const runs = state.running.filter(r => r.projectId === p.id)
  const canRun = p.access === 'run'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to all projects">
          ←
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium">{p.name}</h2>
          <p className="truncate font-mono text-[11px] text-muted" title={p.path}>
            {p.path}
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void window.code.openEditor(p.id).catch(err => onError(cleanError(err)))}>
          <Code2 className="size-3.5" aria-hidden /> Open in VS Code
        </button>
        <div className="w-48">
          <Select label="What Atlas may do" value={p.access} onChange={v => void run(() => window.code.setAccess(p.id, v as Access))} items={ACCESS_LEVELS.map(a => ({ value: a, label: ACCESS_LABEL[a] }))} className="py-1 text-xs" />
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="Today" value={dayLine(p.today)} />
        <Stat label="Last 7 days" value={dayLine(p.week)} extra={p.week.commits ? `+${p.week.added} / −${p.week.removed} lines` : undefined} />
        <Stat label="Git" value={p.git ? `${p.git.branch} · ${p.git.uncommitted} uncommitted` : 'Not a git repository'} extra={p.git?.lastCommit ? `Last: “${p.git.lastCommit}” ${ago(p.git.lastCommitAt)}` : undefined} />
      </section>

      <Card icon={<FileText className="size-3.5" />} title="Status (.atlas/STATUS.md)">
        {p.status ? (
          <div className="grid gap-3 text-xs sm:grid-cols-2">
            {(
              [
                ['now', 'Now'],
                ['next', 'Next'],
                ['recent', 'Recently changed'],
                ['issues', 'Known issues'],
              ] as const
            ).map(([k, label]) => (
              <div key={k}>
                <p className="hud-label mb-1">{label}</p>
                <p className="whitespace-pre-wrap text-sm" dir="auto">
                  {p.status![k] || <span className="text-muted">—</span>}
                </p>
              </div>
            ))}
            <p className="text-[11px] text-muted sm:col-span-2">Updated {ago(p.status.updatedAt)}. Your coding agents keep it current; you can also tell me (“CSi ka next step login fix hai”).</p>
          </div>
        ) : (
          <div className="space-y-2 text-xs text-muted">
            <p>
              No status file yet. It lives in <span className="font-mono">.atlas/STATUS.md</span>, stays out of git (added to the repo’s private exclude list), and your coding agents update it
              when the agent instructions are on (Folders & agents).
            </p>
            <button type="button" className="btn" disabled={p.access === 'see'} onClick={() => void run(() => window.code.createStatus(p.id))} title={p.access === 'see' ? 'Allow “status file” access first' : undefined}>
              <FileText className="size-3.5" aria-hidden /> Create status file
            </button>
          </div>
        )}
      </Card>

      <Card icon={<Terminal className="size-3.5" />} title="Run commands">
        {!canRun && <p className="text-xs text-warm">Set access to “See + status + run” to let Atlas start these.</p>}
        {p.profiles.map(prof => {
          const r = runs.find(x => x.profile === prof.name && !x.endedAt)
          return (
            <div key={prof.id} className="flex items-center gap-2 text-sm">
              <span className={`size-2 rounded-full ${r ? RUN_TONE[r.state] : 'bg-surface-strong'}`} aria-hidden />
              <span className="w-24 truncate font-medium">{prof.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                {prof.command}
                {prof.cwd ? `  (in ${prof.cwd})` : ''}
              </span>
              {r?.url && (
                <button type="button" className="btn" onClick={() => void window.code.openUrl(r.id)}>
                  <ExternalLink className="size-3.5" aria-hidden /> Open
                </button>
              )}
              {r ? (
                <button type="button" className="btn" onClick={() => void run(() => window.code.stop(r.id))}>
                  <Square className="size-3.5" aria-hidden /> Stop
                </button>
              ) : (
                <button type="button" className="btn btn-primary" disabled={!canRun} onClick={() => void run(() => window.code.start(p.id, prof.id))}>
                  <Play className="size-3.5" aria-hidden /> Start
                </button>
              )}
              <button type="button" className="icon-btn size-7" aria-label={`Remove ${prof.name}`} onClick={() => void run(() => window.code.removeProfile(p.id, prof.id))}>
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          )
        })}
        {p.suggestedProfiles.length > 0 && (
          <div className="space-y-1">
            <p className="hud-label">Found in the project</p>
            {p.suggestedProfiles.map(s => (
              <div key={`${s.cwd}|${s.command}`} className="flex items-center gap-2 text-xs">
                <span className="w-24 truncate">{s.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted">
                  {s.command}
                  {s.cwd ? `  (in ${s.cwd})` : ''}
                </span>
                <button type="button" className="btn" onClick={() => void run(() => window.code.addProfile(p.id, s))}>
                  <Plus className="size-3.5" aria-hidden /> Approve
                </button>
              </div>
            ))}
          </div>
        )}
        <AddProfile projectId={p.id} run={run} />
        <p className="text-[11px] text-muted">Atlas only ever runs commands you approved here, one at a time (no &, | or redirection), and stops them all when it quits.</p>
      </Card>

      {p.sessionTitles.length > 0 && (
        <Card icon={<Bot className="size-3.5" />} title="Recent Claude Code sessions">
          <ul className="space-y-1 text-sm">
            {p.sessionTitles.map((t, i) => (
              <li key={i} dir="auto">
                {t}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex justify-end">
        {confirmRemove ? (
          <span className="flex items-center gap-2 text-xs">
            Stop following {p.name}? Its history here is deleted; nothing in the folder changes.
            <button type="button" className="btn btn-danger" onClick={() => void run(() => window.code.remove(p.id)).then(onBack)}>
              Remove
            </button>
            <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="btn text-muted" onClick={() => setConfirmRemove(true)}>
            <Trash2 className="size-3.5" aria-hidden /> Stop following
          </button>
        )}
      </div>
    </div>
  )
}

function AddProfile({ projectId, run }: { projectId: string; run: Run }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Omit<RunProfile, 'id'>>({ name: '', command: '', cwd: '' })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(() => window.code.addProfile(projectId, form)).then(() => {
      setForm({ name: '', command: '', cwd: '' })
      setOpen(false)
    })
  }
  if (!open)
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden /> Add your own command
      </button>
    )
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 text-xs">
      <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="name (web)" className="field w-24 py-1 text-xs" aria-label="Command name" />
      <input value={form.command} onChange={e => setForm({ ...form, command: e.target.value })} placeholder="npm run dev" className="field min-w-0 flex-1 py-1 font-mono text-xs" aria-label="Command" />
      <input value={form.cwd} onChange={e => setForm({ ...form, cwd: e.target.value })} placeholder="folder (optional)" className="field w-32 py-1 text-xs" aria-label="Folder inside the project" />
      <button type="submit" className="btn btn-primary" disabled={!form.name.trim() || !form.command.trim()}>
        Save
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  )
}

function Running({ state, run }: { state: CodeState; run: Run }) {
  const [open, setOpen] = useState<string | null>(null)
  if (state.running.length === 0) return <p className="pt-10 text-center text-sm text-muted">Nothing running. Say “Atlas, CSi web start karo”, or press Start on a project.</p>
  return (
    <div className="space-y-2">
      {state.running.map(r => (
        <article key={r.id} className="tile space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`size-2 rounded-full ${RUN_TONE[r.state]}`} aria-hidden />
            <span className="font-medium">{r.projectName}</span>
            <span className="text-xs text-muted">
              {r.profile} · {r.state}
              {r.endedAt ? ` ${ago(r.endedAt)}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}` : ` · since ${ago(r.startedAt)}`}
            </span>
            <span className="flex-1" />
            {r.url && !r.endedAt && (
              <button type="button" className="btn" onClick={() => void window.code.openUrl(r.id)}>
                <ExternalLink className="size-3.5" aria-hidden /> {r.url.replace(/^https?:\/\//, '')}
              </button>
            )}
            <button type="button" className="btn" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <ScrollText className="size-3.5" aria-hidden /> Log
            </button>
            {!r.endedAt && (
              <button type="button" className="btn" onClick={() => void run(() => window.code.stop(r.id))}>
                <Square className="size-3.5" aria-hidden /> Stop
              </button>
            )}
          </div>
          {r.lastError && <p className="truncate font-mono text-[11px] text-danger" title={r.lastError}>{r.lastError}</p>}
          {open === r.id && <Log runId={r.id} live={!r.endedAt} />}
        </article>
      ))}
    </div>
  )
}

function Log({ runId, live }: { runId: string; live: boolean }) {
  const [lines, setLines] = useState<string[]>([])
  const end = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const load = () => void window.code.logs(runId).then(setLines, () => undefined)
    load()
    if (!live) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [runId, live])
  useEffect(() => {
    if (end.current) end.current.scrollTop = end.current.scrollHeight
  }, [lines])
  return (
    <pre ref={end} className="max-h-64 overflow-auto rounded-lg bg-bg p-2 font-mono text-[11px] leading-relaxed">
      {lines.length ? lines.join('\n') : 'No output yet.'}
    </pre>
  )
}

function Folders({ state, run }: { state: CodeState; run: Run }) {
  return (
    <div className="space-y-5">
      <Card icon={<FolderPlus className="size-3.5" />} title="Projects I follow">
        {state.projects.length === 0 && <p className="text-xs text-muted">None yet. Add one below or choose any folder.</p>}
        {state.projects.map(p => (
          <div key={p.id} className="flex items-center gap-2 text-sm">
            <span className="w-40 truncate font-medium">{p.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={p.path}>
              {p.path}
            </span>
            <div className="w-48">
              <Select label={`Access for ${p.name}`} value={p.access} onChange={v => void run(() => window.code.setAccess(p.id, v as Access))} items={ACCESS_LEVELS.map(a => ({ value: a, label: ACCESS_LABEL[a] }))} className="py-1 text-xs" />
            </div>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => void run(() => window.code.pick())}>
          <FolderPlus className="size-3.5" aria-hidden /> Choose a folder…
        </button>
        <p className="text-[11px] text-muted">
          I read git history, file dates, package.json and Claude Code session titles. Never your source code, .env files or conversations; only summaries reach the AI.
        </p>
      </Card>

      <Card icon={<Code2 className="size-3.5" />} title="Found on this PC">
        {state.suggestions.length === 0 && <p className="text-xs text-muted">Nothing new from VS Code or Claude Code.</p>}
        {state.suggestions.map(s => (
          <div key={s.path} className="flex items-center gap-2 text-sm">
            <span className="w-40 truncate font-medium">{s.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={s.path}>
              {s.path}
            </span>
            <span className="text-[11px] text-muted">
              {s.source === 'claude' ? 'Claude Code' : 'VS Code'} · {ago(s.lastUsedAt)}
            </span>
            <button type="button" className="btn btn-primary" onClick={() => void run(() => window.code.add(s.path))}>
              <Plus className="size-3.5" aria-hidden /> Follow
            </button>
            <button type="button" className="icon-btn size-7" aria-label={`Hide ${s.name}`} title="Don’t suggest again" onClick={() => void run(() => window.code.dismiss(s.path))}>
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </Card>

      <Card icon={<Bot className="size-3.5" />} title="Coding agents keep STATUS.md current">
        <p className="text-xs text-muted">
          Adds one short, clearly marked instruction to your agent’s global instructions: “if the project has .atlas/STATUS.md, update it when you finish a task.” One block covers every
          project; no repo files change. Turn it off to remove exactly that block.
        </p>
        {(
          [
            ['claude', 'Claude Code'],
            ['codex', 'Codex'],
          ] as const
        ).map(([k, label]) => {
          const a = state.agents[k]
          return (
            <label key={k} className={`flex items-center gap-2 text-sm ${a.available ? '' : 'opacity-50'}`}>
              <input type="checkbox" checked={a.enabled} disabled={!a.available} onChange={e => void run(() => window.code.setAgent(k, e.target.checked))} />
              <span className="w-28">{label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{a.available ? a.file : 'not installed'}</span>
            </label>
          )
        })}
      </Card>
    </div>
  )
}

function Stat({ label, value, extra }: { label: string; value: string; extra?: string | undefined }) {
  return (
    <div className="tile p-3">
      <p className="hud-label">{label}</p>
      <p className="mt-1 text-sm">{value}</p>
      {extra && <p className="mt-0.5 truncate text-[11px] text-muted">{extra}</p>}
    </div>
  )
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="tile space-y-2 p-3">
      <h3 className="hud-label flex items-center gap-1.5 text-accent">
        {icon} {title}
      </h3>
      {children}
    </section>
  )
}
