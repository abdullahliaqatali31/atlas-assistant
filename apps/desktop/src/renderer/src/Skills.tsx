import { ChevronDown, ChevronRight, GraduationCap, Pause, Play, Trash2, Wand2, Zap } from 'lucide-react'
import { useState } from 'react'

import type { LearningView, SkillView } from '../../shared/learning.ts'

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/**
 * Tasks you taught Atlas. It follows each one's steps with its own
 * judgement, asks before anything risky, and runs it when you ask, at the
 * time you set (asking first unless "By itself" is on), or offers it when
 * the situation you described comes up.
 */
export function Skills({ skills, run, onTalk }: { skills: SkillView[]; run: (fn: () => Promise<LearningView>) => Promise<void>; onTalk?: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const talk = (fn: () => Promise<LearningView>) => {
    void run(fn)
    onTalk?.()
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <GraduationCap className="size-3.5 text-accent" aria-hidden />
        <h2 className="hud-label flex-1">Skills you taught me</h2>
        <button type="button" className="btn btn-primary" onClick={() => talk(() => window.learning.teach())}>
          <Wand2 className="size-3.5" aria-hidden /> Teach new task
        </button>
      </div>
      {skills.length === 0 && (
        <p className="px-1 text-xs text-muted">
          Teach me anything you do often: explain it in your own words (“ek naya task seekho…”) or do it together with me once. I’ll do it when you ask, at a time you
          set, or offer it when it’s needed.
        </p>
      )}
      {skills.map(s => {
        const expanded = open === s.id
        return (
          <article key={s.id} className={`tile rise-in p-3 ${s.status === 'paused' ? 'opacity-60' : ''}`}>
            <div className="flex items-start gap-2">
              <button type="button" className="icon-btn mt-0.5 size-6" aria-expanded={expanded} aria-label={`Steps of ${s.name}`} onClick={() => setOpen(expanded ? null : s.id)}>
                {expanded ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{s.name}</p>
                <p className="text-xs text-muted">{s.goal}</p>
                <p className="mt-1 text-[11px] text-muted">
                  {s.status === 'paused' ? 'Paused' : `Runs ${s.runs}`}
                  {s.when ? ` · offered when ${s.when}` : ''}
                  {s.lastRun ? ` · last run ${ago(s.lastRun.at)}: ${s.lastRun.ok === null ? 'not finished' : s.lastRun.ok ? 'done ✓' : 'failed'}` : ' · never run'}
                </p>
              </div>
              <button type="button" className="btn" disabled={s.status === 'paused'} onClick={() => talk(() => window.learning.runSkill(s.id))} title="Atlas does it now, in the conversation">
                <Play className="size-3.5" aria-hidden /> Run now
              </button>
            </div>

            {expanded && (
              <div className="mt-3 space-y-2 border-t border-border pt-3 text-xs">
                <ol className="list-decimal space-y-0.5 ps-5">
                  {s.steps.map((step, i) => (
                    <li key={i} dir="auto">
                      {step}
                    </li>
                  ))}
                </ol>
                {s.inputs.length > 0 && <p className="text-muted">Changes each time: {s.inputs.join(', ')}</p>}
                {s.check && <p className="text-muted">Checks: {s.check}</p>}
                <p className="text-muted">Asks you before: {s.approve ? `${s.approve}, and ` : ''}anything that sends, deletes, pays or submits.</p>
                {s.lastRun?.summary && <p className="text-muted">Last result: {s.lastRun.summary}</p>}
                <p className="text-muted">To change the steps or the time, just tell me (“client email wala task Monday 10 baje kar do”).</p>
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {s.runs !== 'when you ask' && (
                <label className="flex items-center gap-2 text-xs" title="On its schedule, do it without asking first. Risky steps still ask.">
                  <input
                    type="checkbox"
                    checked={s.auto}
                    onChange={e => void run(() => window.learning.updateSkill(s.id, { auto: e.target.checked }))}
                    aria-label={`Let ${s.name} run by itself on schedule`}
                  />
                  <Zap className="size-3.5 text-warm" aria-hidden /> By itself on schedule
                </label>
              )}
              <span className="flex-1" />
              <button type="button" className="btn" onClick={() => void run(() => window.learning.updateSkill(s.id, { status: s.status === 'paused' ? 'active' : 'paused' }))}>
                {s.status === 'paused' ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
                {s.status === 'paused' ? 'Resume' : 'Pause'}
              </button>
              {confirmDelete === s.id ? (
                <>
                  <button type="button" className="btn btn-danger" onClick={() => void run(() => window.learning.deleteSkill(s.id)).then(() => setConfirmDelete(null))}>
                    Delete “{s.name}”
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className="icon-btn size-7" aria-label={`Delete ${s.name}`} title="Delete this skill" onClick={() => setConfirmDelete(s.id)}>
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          </article>
        )
      })}
    </section>
  )
}
