import { AlertTriangle, Bell, CircleX, Clock3, Globe2, ShieldQuestion, type LucideIcon } from 'lucide-react'
import { useState } from 'react'

import type { AlertItem, AlertKind } from './alerts.ts'

const KIND: Record<AlertKind, { label: string; icon: LucideIcon; dot: string; text: string }> = {
  question: { label: 'Questions', icon: ShieldQuestion, dot: 'bg-warm', text: 'text-warm' },
  world: { label: 'World', icon: Globe2, dot: 'bg-orange-400', text: 'text-orange-300' },
  failure: { label: 'Failures', icon: CircleX, dot: 'bg-danger', text: 'text-danger' },
  task: { label: 'Overdue', icon: Clock3, dot: 'bg-warm', text: 'text-warm' },
  notice: { label: 'Atlas', icon: Bell, dot: 'bg-accent', text: 'text-accent' },
}

type Filter = 'all' | AlertKind

const timeOf = (at: number, now: number) => {
  const m = Math.round((now - at) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * The Alerts drawer: the last 24 hours on one line of time. What still needs
 * you is pinned at the top ("Needs you"); the rest is history, newest first.
 * Questions answer in place (Haan / Nahi); everything else opens where it lives.
 */
export function AlertsTimeline({ items, onOpen }: { items: AlertItem[]; onOpen: (target: AlertItem['target']) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const now = Date.now()
  const shown = filter === 'all' ? items : items.filter(i => i.kind === filter)
  const open = shown.filter(i => i.open)
  const past = shown.filter(i => !i.open)
  const kinds = (Object.keys(KIND) as AlertKind[]).filter(k => items.some(i => i.kind === k))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2" role="tablist" aria-label="Filter alerts">
        {(['all', ...kinds] as Filter[]).map(f => {
          const n = f === 'all' ? items.length : items.filter(i => i.kind === f).length
          return (
            <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${filter === f ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:text-text'}`}>
              {f === 'all' ? 'All' : KIND[f].label} <span className="font-mono">{n}</span>
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {shown.length === 0 && (
          <div className="grid h-full place-items-center text-center text-xs text-muted">
            <div>
              <AlertTriangle className="mx-auto mb-2 size-5 opacity-40" aria-hidden />
              Nothing in the last 24 hours. I’ll put world alerts, questions and anything that failed here.
            </div>
          </div>
        )}
        {open.length > 0 && <Section title="Needs you" items={open} now={now} onOpen={onOpen} />}
        {past.length > 0 && <Section title="Last 24 hours" items={past} now={now} onOpen={onOpen} />}
      </div>
    </div>
  )
}

function Section({ title, items, now, onOpen }: { title: string; items: AlertItem[]; now: number; onOpen: (target: AlertItem['target']) => void }) {
  return (
    <section className="mb-4">
      <h3 className="hud-label mb-2">{title}</h3>
      <ol className="relative space-y-3 border-l border-border pl-4">
        {items.map(a => {
          const k = KIND[a.kind]
          return (
            <li key={a.id} className="relative">
              <span className={`absolute -left-[21px] top-1.5 size-2.5 rounded-full ring-4 ring-[var(--solid)] ${k.dot}`} aria-hidden />
              <div className="flex items-baseline gap-2">
                <span className={`flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wider ${k.text}`}>
                  <k.icon className="size-3" aria-hidden />
                  {k.label}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">{timeOf(a.at, now)}</span>
              </div>
              <p className="mt-0.5 text-sm leading-snug" dir="auto">
                {a.title}
              </p>
              {a.detail && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted" dir="auto">
                  {a.detail}
                </p>
              )}
              <div className="mt-1.5 flex gap-1.5">
                {a.approvalId ? (
                  <>
                    <button type="button" className="btn h-6 border-accent px-2 text-[11px] text-accent" onClick={() => void window.assistant.answerApproval(a.approvalId!, true)}>
                      Haan
                    </button>
                    <button type="button" className="btn h-6 px-2 text-[11px]" onClick={() => void window.assistant.answerApproval(a.approvalId!, false)}>
                      Nahi
                    </button>
                  </>
                ) : (
                  <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => onOpen(a.target)}>
                    {a.target === 'world' ? 'Show on the map' : a.target === 'chat' ? 'Open conversation' : a.target === 'controls' ? 'Open connections' : a.target === 'projects' ? 'Open projects' : 'Open today'} →
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
