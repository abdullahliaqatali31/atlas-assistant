import { Brain, Check, GraduationCap, Lightbulb, ListChecks, MessageCircleQuestion, RefreshCw, Repeat, Sparkles, Trash2, UserCog, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { LearningView, ProposalView } from '../../shared/learning.ts'
import { Skills } from './Skills.tsx'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

const KIND: Record<ProposalView['kind'], { label: string; icon: ReactNode; accept: string }> = {
  personality: { label: 'How I talk', icon: <UserCog className="size-4" />, accept: 'Yes, always' },
  lesson: { label: 'Lesson from your correction', icon: <GraduationCap className="size-4" />, accept: 'Remember this' },
  memory: { label: 'Something I noticed', icon: <Lightbulb className="size-4" />, accept: 'That’s right' },
  workflow: { label: 'Routine', icon: <Repeat className="size-4" />, accept: 'Save routine' },
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** "today 17:00", "tomorrow 09:30", "Mon 14:00". */
const when = (t: number) => {
  const d = new Date(t)
  const day = new Date(d).setHours(0, 0, 0, 0)
  const today = new Date().setHours(0, 0, 0, 0)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const diff = Math.round((day - today) / 86_400_000)
  const label = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff === -1 ? 'yesterday' : d.toLocaleDateString([], { weekday: 'short' })
  return `${label} ${time}`
}

/**
 * What the assistant is learning about you. Nothing here changes how it
 * behaves until you say yes, except facts you stated yourself, which you
 * can forget with one click.
 */
export function Learning({ onTalk }: { /** Teach and Run now continue in the conversation. */ onTalk?: () => void } = {}) {
  const [view, setView] = useState<LearningView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.learning.get().then(setView, err => setError(cleanError(err)))
    return window.learning.onChanged(setView)
  }, [])

  const run = async (fn: () => Promise<LearningView>) => {
    setError('')
    try {
      setView(await fn())
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const learnNow = async () => {
    setBusy(true)
    await run(() => window.learning.runNow())
    setBusy(false)
  }

  if (!view) return <p className="p-6 text-sm text-muted">{error || 'Loading…'}</p>

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Brain className="size-4 text-accent" aria-hidden />
        <h1 className="flex-1 text-sm font-semibold">Learning</h1>
        <span className="text-[11px] text-muted">{view.running ? 'Learning…' : view.lastRunAt ? `Last learned ${ago(view.lastRunAt)}` : 'Not run yet'}</span>
        <button type="button" className="btn" onClick={() => void learnNow()} disabled={busy || view.running} title="Read today’s conversation now">
          <RefreshCw className={`size-3.5 ${busy || view.running ? 'animate-spin' : ''}`} aria-hidden /> Learn now
        </button>
      </header>
      {error && <p className="border-b border-border px-4 py-2 text-xs text-danger">{error}</p>}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p className="text-xs text-muted">
          While you’re away, I read today’s conversation and keep what lasts. Facts you stated are saved right away; anything that would change how I behave
          waits for your yes. {view.lastResult && <span className="text-text">{view.lastResult}</span>}
        </p>

        <Skills skills={view.skills} run={run} onTalk={onTalk} />

        <Section icon={<Sparkles className="size-3.5" />} title="Waiting for you" aside={view.pending.length ? String(view.pending.length) : undefined}>
          {view.pending.length === 0 && <Empty>No suggestions right now.</Empty>}
          {view.pending.map(p => (
            <article key={p.id} className="tile rise-in space-y-2 p-3">
              <p className="flex items-center gap-1.5 text-accent">
                {KIND[p.kind].icon}
                <span className="hud-label !text-accent">{KIND[p.kind].label}</span>
                <span className="ml-auto text-[11px] text-muted">{ago(p.createdAt)}</span>
              </p>
              <p className="text-sm font-medium">{p.title}</p>
              <p className="text-xs text-muted">{p.evidence}</p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" onClick={() => void run(() => window.learning.decide(p.id, false))}>
                  <X className="size-3.5" aria-hidden /> No
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void run(() => window.learning.decide(p.id, true))}>
                  <Check className="size-3.5" aria-hidden /> {KIND[p.kind].accept}
                </button>
              </div>
            </article>
          ))}
        </Section>

        <Section icon={<Lightbulb className="size-3.5" />} title="What I’ve learned" aside={view.learned.length ? String(view.learned.length) : undefined}>
          {view.learned.length === 0 && <Empty>Nothing yet. Talk to me for a while, then press Learn now or step away.</Empty>}
          {view.learned.map(m => (
            <div key={m.id} className="group flex items-start gap-2 rounded-lg px-1 py-1.5">
              <span className={`hud-label mt-0.5 w-20 shrink-0 ${m.kind === 'lesson' ? '!text-warm' : ''}`}>{m.kind}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{m.statement}</p>
                {m.evidence && <p className="truncate text-[11px] text-muted">from: {m.evidence}</p>}
              </div>
              <button type="button" className="icon-btn size-7 opacity-60 group-hover:opacity-100" aria-label={`Forget: ${m.statement}`} title="Forget this" onClick={() => void run(() => window.learning.forget(m.id))}>
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </Section>

        <Section icon={<MessageCircleQuestion className="size-3.5" />} title="I’ll ask you about">
          {view.followups.length === 0 && <Empty>When you mention a meeting, call or visit with a time, I’ll ask how it went afterwards.</Empty>}
          {view.followups.map(f => (
            <div key={f.id} className="group flex items-start gap-2 rounded-lg px-1 py-1.5">
              <span className="hud-label mt-0.5 w-20 shrink-0">{when(f.dueAt)}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{f.about}</p>
                <p className="truncate text-[11px] text-muted">you said: “{f.quote}”</p>
              </div>
              <button type="button" className="icon-btn size-7 opacity-60 group-hover:opacity-100" aria-label={`Don't ask about ${f.about}`} title="Don’t ask about this" onClick={() => void run(() => window.learning.dropFollowup(f.id))}>
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </Section>

        <Section icon={<ListChecks className="size-3.5" />} title="Routines">
          {view.workflows.length === 0 && <Empty>When you repeat the same steps on different days, I’ll suggest saving them as a routine.</Empty>}
          {view.workflows.map(w => (
            <div key={w.id} className="flex items-center gap-2 px-1 py-1.5">
              <Repeat className="size-4 text-accent" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm">{w.name}</span>
              <button type="button" className="icon-btn size-7" aria-label={`Remove routine ${w.name}`} onClick={() => void run(() => window.learning.removeWorkflow(w.id))}>
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </Section>

        <Section icon={<UserCog className="size-3.5" />} title="Personality changes I made">
          {view.personalityChanges.length === 0 && <Empty>Say things like “hamesha chhote jawab do” or “from now on, English” and I’ll adapt. Undo any change in Setup › Personality.</Empty>}
          {view.personalityChanges.map(c => (
            <p key={c.version} className="px-1 py-1 text-sm">
              <span className="font-mono text-[11px] text-muted">v{c.version} · {ago(c.at)}</span> {c.reason.replace(/^learned( \(you confirmed\))?: /, '')}
            </p>
          ))}
        </Section>
      </div>
    </div>
  )
}

function Section({ icon, title, aside, children }: { icon: ReactNode; title: string; aside?: string | undefined; children: ReactNode }) {
  return (
    <section className="tile p-3">
      <header className="mb-2 flex items-center gap-1.5 text-muted">
        {icon}
        <h2 className="hud-label flex-1">{title}</h2>
        {aside && <span className="rounded-full bg-accent-soft px-2 font-mono text-[11px] text-accent">{aside}</span>}
      </header>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

const Empty = ({ children }: { children: ReactNode }) => <p className="px-1 text-xs text-muted">{children}</p>
