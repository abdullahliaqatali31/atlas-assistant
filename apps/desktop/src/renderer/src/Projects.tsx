import { Check, CheckCircle2, Circle, Clock3, FolderKanban, Handshake, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'

import { PROJECT_STATUSES, type ProjectDetailView, type ProjectStatus, type ProjectSummary, type ProjectTaskView } from '../../shared/projects.ts'
import { Select } from './ui/Select.tsx'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

const STATUS_TONE: Record<ProjectStatus, string> = {
  active: 'text-accent border-accent/40',
  paused: 'text-warm border-warm/40',
  done: 'text-ok border-ok/40',
  archived: 'text-muted border-border',
}

const OPEN = new Set(['proposed', 'ready', 'running', 'waiting', 'failed'])

const fmtDue = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

/** Parses a datetime-local value into epoch ms, or null when empty/invalid. */
const parseLocal = (v: string) => {
  const t = v ? new Date(v).getTime() : Number.NaN
  return Number.isNaN(t) ? null : t
}

/** Projects with their tasks and commitments; the same data the assistant briefs from. */
export function Projects() {
  const [list, setList] = useState<ProjectSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProjectDetailView | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const loadList = useCallback(async () => {
    const l = await window.projects.list().catch(() => null)
    setList(l)
    if (l && l.length > 0) setSelected(s => s ?? l[0]!.id)
  }, [])

  useEffect(() => {
    void loadList()
    return window.projects.onChanged(id => {
      void loadList()
      setSelected(s => {
        if (s === id) void window.projects.get(id).then(setDetail, () => undefined)
        return s
      })
    })
  }, [loadList])

  useEffect(() => {
    if (selected) void window.projects.get(selected).then(setDetail, () => setDetail(null))
    else setDetail(null)
  }, [selected])

  /** Runs a change and shows the refreshed project, or main's refusal. */
  const run = async (fn: () => Promise<ProjectDetailView | null>) => {
    setError('')
    try {
      const d = await fn()
      if (d) setDetail(d)
      void loadList()
      return true
    } catch (err) {
      setError(cleanError(err))
      return false
    }
  }

  if (list === null) {
    return <p className="p-6 text-sm text-muted">Projects appear once the assistant's runtime is ready.</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-end gap-2 border-b border-border px-3 py-1.5">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" aria-hidden /> New project
        </button>
      </header>
      {error && (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @2xl:flex-row @2xl:overflow-hidden">
        <nav className="max-h-56 shrink-0 space-y-1.5 overflow-y-auto border-b border-border p-3 @2xl:max-h-none @2xl:w-60 @2xl:border-b-0 @2xl:border-r" aria-label="Project list">
          {creating && (
            <NewProject
              onCancel={() => setCreating(false)}
              onCreate={async (name, goals) => {
                const ok = await run(async () => {
                  const d = await window.projects.create({ name, goals })
                  setSelected(d.id)
                  return d
                })
                if (ok) setCreating(false)
              }}
            />
          )}
          {list.length === 0 && !creating && <p className="px-1 text-xs text-muted">No projects yet. Create one, or tell the assistant about your work.</p>}
          {list.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelected(p.id)}
              aria-current={p.id === selected ? 'page' : undefined}
              className={`tile block w-full p-2.5 text-left transition-colors ${p.id === selected ? '!border-accent bg-accent-soft' : 'hover:bg-surface-strong'}`}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                <span className={`hud-label rounded-md border px-1.5 py-px ${STATUS_TONE[p.status]}`}>{p.status}</span>
              </span>
              <span className="mt-1 flex gap-3 text-[11px] text-muted">
                <span>{p.openTasks} open tasks</span>
                {p.openCommitments > 0 && <span className="text-warm">{p.openCommitments} promises</span>}
              </span>
            </button>
          ))}
        </nav>

        <section className="min-w-0 flex-1 px-3 py-3 @2xl:overflow-y-auto @2xl:px-5 @2xl:py-4" aria-live="polite">
          {detail ? <Detail key={detail.id} project={detail} run={run} /> : <p className="text-sm text-muted">Pick a project.</p>}
        </section>
      </div>
    </div>
  )
}

type Run = (fn: () => Promise<ProjectDetailView | null>) => Promise<boolean>

function Detail({ project: p, run }: { project: ProjectDetailView; run: Run }) {
  const [goals, setGoals] = useState(p.goals)
  const [state, setState] = useState(p.state)
  const dirty = goals !== p.goals || state !== p.state
  const open = p.tasks.filter(t => OPEN.has(t.status))
  const closed = p.tasks.filter(t => !OPEN.has(t.status))
  const promises = p.commitments.filter(c => c.resolvedAt === null)

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-base font-semibold">{p.name}</h2>
        <div className="w-36">
          <Select
            label="Project status"
            value={p.status}
            onChange={v => void run(() => window.projects.update(p.id, { status: v as ProjectStatus }))}
            items={PROJECT_STATUSES.map(s => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))}
            className="py-1 text-xs"
          />
        </div>
      </div>

      <div className="grid gap-3 @xl:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="hud-label">Goals</span>
          <textarea value={goals} onChange={e => setGoals(e.target.value)} rows={3} maxLength={2000} className="field resize-none text-sm" placeholder="What does done look like?" />
        </label>
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="hud-label">Where it stands</span>
          <textarea value={state} onChange={e => setState(e.target.value)} rows={3} maxLength={2000} className="field resize-none text-sm" placeholder="Current state, blockers…" />
        </label>
      </div>
      {dirty && (
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => (setGoals(p.goals), setState(p.state))}>
            Discard
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void run(() => window.projects.update(p.id, { goals, state }))}>
            Save
          </button>
        </div>
      )}

      <Card title="Tasks" icon={<CheckCircle2 className="size-3.5" />} aside={`${open.length} open`}>
        {open.map(t => (
          <TaskRow key={t.id} task={t} run={run} />
        ))}
        {open.length === 0 && <p className="text-xs text-muted">No open tasks.</p>}
        <AddLine
          placeholder="Add a task…"
          withDue
          onAdd={(title, dueAt) => run(() => window.projects.addTask(p.id, { title, dueAt }))}
        />
        {closed.length > 0 && (
          <details className="pt-1 text-xs">
            <summary className="cursor-pointer text-muted">{closed.length} finished or cancelled</summary>
            <ul className="mt-1.5 space-y-1">
              {closed.map(t => (
                <li key={t.id} className="flex items-start gap-2 text-muted">
                  <Check className="mt-0.5 size-3.5 text-ok" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="line-through">{t.title}</span>
                    {t.evidence && <span className="block text-[11px]">Evidence: {t.evidence}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card title="Promises" icon={<Handshake className="size-3.5" />} aside={promises.length ? `${promises.length} open` : undefined}>
        {p.commitments.length === 0 && <p className="text-xs text-muted">No promises recorded. Add who you promised what, so nothing slips.</p>}
        {p.commitments.map(c => (
          <CommitmentRow key={c.id} c={c} run={run} />
        ))}
        <AddCommitment onAdd={(what, toWhom, dueAt) => run(() => window.projects.addCommitment(p.id, { what, toWhom, dueAt }))} />
      </Card>
    </div>
  )
}

function TaskRow({ task: t, run }: { task: ProjectTaskView; run: Run }) {
  const [finishing, setFinishing] = useState(false)
  const [evidence, setEvidence] = useState('')
  const overdue = t.dueAt !== null && t.dueAt < Date.now()
  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2">
        <button type="button" className="icon-btn size-6" aria-label={`Complete ${t.title}`} title="Mark done (needs evidence)" onClick={() => setFinishing(v => !v)}>
          <Circle className="size-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
        {t.dueAt && (
          <span className={`flex items-center gap-1 text-[11px] ${overdue ? 'text-warm' : 'text-muted'}`}>
            <Clock3 className="size-3" aria-hidden />
            {fmtDue(t.dueAt)}
          </span>
        )}
        <span className="hud-label">{t.status}</span>
      </div>
      {finishing && (
        <form
          className="mt-1.5 flex gap-2 pl-8"
          onSubmit={e => {
            e.preventDefault()
            void run(() => window.projects.setTaskStatus(t.id, 'completed', evidence.trim())).then(ok => ok && setFinishing(false))
          }}
        >
          <input
            autoFocus
            value={evidence}
            onChange={e => setEvidence(e.target.value)}
            maxLength={1000}
            placeholder="How do we know it's done? e.g. quote emailed to Ahmed"
            className="field py-1 text-xs"
            aria-label="Evidence that the task is done"
          />
          <button type="submit" className="btn btn-primary shrink-0" disabled={!evidence.trim()}>
            Done
          </button>
        </form>
      )}
    </div>
  )
}

function CommitmentRow({ c, run }: { c: ProjectDetailView['commitments'][number]; run: Run }) {
  const [resolving, setResolving] = useState(false)
  const [note, setNote] = useState('')
  const resolved = c.resolvedAt !== null
  const overdue = !resolved && c.dueAt !== null && c.dueAt < Date.now()
  return (
    <div className={`rounded-lg px-1 py-1 ${resolved ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2">
        <Handshake className={`mt-0.5 size-4 ${resolved ? 'text-ok' : overdue ? 'text-warm' : 'text-muted'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${resolved ? 'line-through' : ''}`}>
            {c.who} → {c.toWhom}: {c.what}
          </p>
          <p className="text-[11px] text-muted">
            {c.dueAt ? `due ${fmtDue(c.dueAt)} · ` : ''}from {c.source}
            {resolved && c.resolution ? ` · settled: ${c.resolution}` : ''}
          </p>
        </div>
        {!resolved && (
          <button type="button" className="btn shrink-0" onClick={() => setResolving(v => !v)}>
            Settle
          </button>
        )}
      </div>
      {resolving && (
        <form
          className="mt-1.5 flex gap-2 pl-6"
          onSubmit={e => {
            e.preventDefault()
            void run(() => window.projects.resolveCommitment(c.id, note.trim())).then(ok => ok && setResolving(false))
          }}
        >
          <input autoFocus value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="How was it settled?" className="field py-1 text-xs" aria-label="How the promise was settled" />
          <button type="submit" className="btn btn-primary shrink-0" disabled={!note.trim()}>
            Save
          </button>
        </form>
      )}
    </div>
  )
}

function AddLine({ placeholder, withDue, onAdd }: { placeholder: string; withDue?: boolean; onAdd: (title: string, dueAt: number | null) => Promise<boolean> }) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    if (await onAdd(title.trim(), parseLocal(due))) {
      setTitle('')
      setDue('')
    }
  }
  return (
    <form onSubmit={e => void submit(e)} className="flex gap-2 pt-1">
      <input value={title} onChange={e => setTitle(e.target.value)} maxLength={300} placeholder={placeholder} className="field py-1 text-xs" aria-label={placeholder} />
      {withDue && <input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} className="field w-48 py-1 text-xs" aria-label="Due (optional)" />}
      <button type="submit" className="btn shrink-0" disabled={!title.trim()}>
        <Plus className="size-3.5" aria-hidden /> Add
      </button>
    </form>
  )
}

function AddCommitment({ onAdd }: { onAdd: (what: string, toWhom: string, dueAt: number | null) => Promise<boolean> }) {
  const [what, setWhat] = useState('')
  const [toWhom, setToWhom] = useState('')
  const [due, setDue] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!what.trim() || !toWhom.trim()) return
    if (await onAdd(what.trim(), toWhom.trim(), parseLocal(due))) {
      setWhat('')
      setToWhom('')
      setDue('')
    }
  }
  return (
    <form onSubmit={e => void submit(e)} className="grid grid-cols-[1fr_8rem] gap-2 pt-1 @2xl:grid-cols-[1fr_8rem_12rem_auto]">
      <input value={what} onChange={e => setWhat(e.target.value)} maxLength={500} placeholder="What was promised…" className="field py-1 text-xs" aria-label="What was promised" />
      <input value={toWhom} onChange={e => setToWhom(e.target.value)} maxLength={120} placeholder="To whom" className="field py-1 text-xs" aria-label="Promised to" />
      <input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} className="field py-1 text-xs" aria-label="Due (optional)" />
      <button type="submit" className="btn" disabled={!what.trim() || !toWhom.trim()}>
        <Plus className="size-3.5" aria-hidden /> Add
      </button>
    </form>
  )
}

function NewProject({ onCreate, onCancel }: { onCreate: (name: string, goals: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [goals, setGoals] = useState('')
  return (
    <form
      className="tile space-y-2 p-2.5"
      onSubmit={e => {
        e.preventDefault()
        if (name.trim()) void onCreate(name.trim(), goals.trim())
      }}
    >
      <input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder="Project name" className="field py-1 text-sm" aria-label="Project name" />
      <textarea value={goals} onChange={e => setGoals(e.target.value)} maxLength={2000} rows={2} placeholder="Goal (optional)" className="field resize-none py-1 text-xs" aria-label="Project goal" />
      <div className="flex justify-end gap-1.5">
        <button type="button" className="icon-btn size-7" aria-label="Cancel" onClick={onCancel}>
          <X className="size-4" aria-hidden />
        </button>
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
          Create
        </button>
      </div>
    </form>
  )
}

function Card({ title, icon, aside, children }: { title: string; icon: ReactNode; aside?: string | undefined; children: ReactNode }) {
  return (
    <section className="tile p-3">
      <header className="mb-2 flex items-center gap-1.5 text-muted">
        {icon}
        <h3 className="hud-label flex-1">{title}</h3>
        {aside && <span className="font-mono text-[11px]">{aside}</span>}
      </header>
      <div className="space-y-1">{children}</div>
    </section>
  )
}
