import { Gauge } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent } from 'react'

import type { UsageView } from '../../shared/ipc.ts'

const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
/** Inputs inside the setup form: Enter must not submit the form. */
const noSubmit = (e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.preventDefault()

/**
 * What the AI costs: today, this month, per model, and a monthly budget.
 * At the budget, Atlas stops its background work and its own speak-ups;
 * answering you keeps working.
 */
/** Start with Windows, in the tray. */
export function StartupToggle() {
  const [s, setS] = useState<{ available: boolean; enabled: boolean } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void window.assistant.startup().then(setS, () => undefined)
  }, [])
  if (!s) return null
  return (
    <section className="tile space-y-1 p-4">
      <label className={`flex items-center gap-2 text-sm ${s.available ? '' : 'opacity-60'}`}>
        <input
          type="checkbox"
          checked={s.enabled}
          disabled={!s.available}
          onChange={e =>
            void window.assistant.setStartup(e.target.checked).then(setS, err => setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'That did not work.'))
          }
        />
        Start Atlas when Windows starts (quietly, in the tray)
      </label>
      <p className="text-[11px] text-muted">
        {s.available
          ? 'Your morning briefing, reminders, wake word and scheduled skills then work without opening the app first.'
          : 'Available in the installed app (this is the development build).'}
      </p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  )
}

/** What each request was made of, in a fixed order and colour. */
const PARTS: { key: string; label: string; color: string }[] = [
  { key: 'instructions', label: 'Instructions', color: '#a78bfa' },
  { key: 'tools', label: 'Tool list', color: '#60a5fa' },
  { key: 'history', label: 'Conversation so far', color: '#34d399' },
  { key: 'turn', label: 'This message and context', color: '#fbbf24' },
  { key: 'toolResults', label: 'Tool results', color: '#f87171' },
]

/**
 * The last calls one by one: when, which model, what it cost, how much came
 * from the prompt cache, and a bar of what the request was made of.
 */
function RecentCalls({ u }: { u: UsageView }) {
  return (
    <section className="space-y-1.5">
      <p className="flex items-center justify-between text-[11px] text-muted">
        <span className="hud-label">Last calls</span>
        <span>Today {Math.round(u.cacheShare * 100)}% of input came from the cache, at a fraction of the price</span>
      </p>
      <ul className="space-y-1">
        {u.recent.map(c => {
          const total = PARTS.reduce((n, p) => n + (c.parts[p.key] ?? 0), 0) || 1
          const input = c.input + c.cached + c.cacheWrite
          return (
            <li key={c.id} className="text-[11px]">
              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 font-mono text-muted">{new Date(c.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="min-w-0 flex-1 truncate font-mono" title={c.model}>
                  {c.model.replace(/^claude-/, '')}
                  {c.purpose !== 'chat' && <span className="text-muted"> · background</span>}
                </span>
                <span className="shrink-0 text-muted" title={`${input} input (${c.cached} from cache, ${c.cacheWrite} written to cache) · ${c.output} output`}>
                  {tokens(input)} in · {input ? Math.round((c.cached / input) * 100) : 0}% cached · {tokens(c.output)} out
                </span>
                <span className="w-12 shrink-0 text-right">{c.usd === null ? '—' : usd(c.usd)}</span>
              </div>
              <div className="ml-12 mt-0.5 flex h-1 overflow-hidden rounded-full bg-surface">
                {PARTS.map(p =>
                  c.parts[p.key] ? <span key={p.key} style={{ width: `${((c.parts[p.key] ?? 0) / total) * 100}%`, background: p.color }} title={`${p.label}: about ${tokens(c.parts[p.key] ?? 0)} tokens`} /> : null,
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="flex flex-wrap gap-x-3 text-[10px] text-muted">
        {PARTS.map(p => (
          <span key={p.key}>
            <span className="mr-1 inline-block size-1.5 rounded-full" style={{ background: p.color }} />
            {p.label}
          </span>
        ))}
      </p>
    </section>
  )
}

export function UsageCard() {
  const [u, setU] = useState<UsageView | null>(null)
  const [budget, setBudget] = useState('')
  const [price, setPrice] = useState<{ model: string; input: string; output: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.assistant.usage().then(v => {
      setU(v)
      if (v) setBudget(v.budgetUsd ? String(v.budgetUsd) : '')
    }, () => undefined)
    return window.assistant.onUsage(setU)
  }, [])

  const act = async (fn: () => Promise<void>) => {
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'That did not work.')
    }
  }

  if (!u) return null
  const pct = u.budgetUsd ? Math.min(100, (u.month.usd / u.budgetUsd) * 100) : 0
  return (
    <section className="tile space-y-3 p-4">
      <h2 className="hud-label flex items-center gap-1.5 text-accent">
        <Gauge className="size-3.5" aria-hidden /> Usage & budget
      </h2>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-[11px] text-muted">Today</p>
          <p className="text-lg font-semibold">{usd(u.today.usd)}</p>
          <p className="text-[11px] text-muted">
            {tokens(u.today.tokens)} tokens · {u.today.calls} calls
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted">This month</p>
          <p className="text-lg font-semibold">{usd(u.month.usd)}</p>
          <p className="text-[11px] text-muted">
            {tokens(u.month.tokens)} tokens · {u.month.calls} calls
          </p>
        </div>
      </div>
      {u.budgetUsd > 0 && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-strong" aria-label={`${Math.round(pct)}% of the monthly budget`}>
            <div className={`h-full rounded-full ${u.overBudget ? 'bg-danger' : pct > 80 ? 'bg-warm' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
          </div>
          {u.overBudget && <p className="mt-1 text-xs text-danger">Budget reached: background learning and Atlas’s own questions are paused until next month. Replies to you still work.</p>}
        </div>
      )}
      <div className="flex items-center gap-2 text-sm">
        <span>Monthly budget $</span>
        <input value={budget} onChange={e => setBudget(e.target.value)} onKeyDown={noSubmit} inputMode="decimal" placeholder="no limit" className="field w-24 py-1 text-sm" aria-label="Monthly budget in US dollars" />
        <button type="button" className="btn" onClick={() => void act(() => window.assistant.setBudget(Number(budget || 0)))} disabled={Number.isNaN(Number(budget || 0))}>
          Save
        </button>
      </div>
      {u.byModel.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 text-left font-normal">Model</th>
              <th className="text-left font-normal">For</th>
              <th className="text-right font-normal">Tokens</th>
              <th className="text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {u.byModel.map(m => (
              <tr key={`${m.model}|${m.purpose}`} className="border-t border-border">
                <td className="py-1 font-mono">{m.model}</td>
                <td>{m.purpose === 'chat' ? 'talking to you' : 'background'}</td>
                <td className="text-right">{tokens(m.input + m.output + m.cached + m.cacheWrite)}</td>
                <td className="text-right">
                  {m.usd === null ? (
                    <button type="button" className="text-accent underline" onClick={() => setPrice({ model: m.model, input: '', output: '' })}>
                      set price
                    </button>
                  ) : (
                    usd(m.usd)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {u.recent.length > 0 && <RecentCalls u={u} />}
      {price && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono">{price.model}</span>
          <span>$ per 1M tokens: in</span>
          <input value={price.input} onChange={e => setPrice({ ...price, input: e.target.value })} onKeyDown={noSubmit} inputMode="decimal" className="field w-20 py-1 text-xs" aria-label="Input price per million tokens" />
          <span>out</span>
          <input value={price.output} onChange={e => setPrice({ ...price, output: e.target.value })} onKeyDown={noSubmit} inputMode="decimal" className="field w-20 py-1 text-xs" aria-label="Output price per million tokens" />
          <button
            type="button"
            className="btn"
            disabled={!price.input || !price.output || Number.isNaN(Number(price.input)) || Number.isNaN(Number(price.output))}
            onClick={() => void act(() => window.assistant.setPrice(price.model, { input: Number(price.input), output: Number(price.output) })).then(() => setPrice(null))}
          >
            Save
          </button>
          <span className="text-muted">From your provider’s pricing page.</span>
        </div>
      )}
      <p className="text-[11px] text-muted">Claude prices are built in. For other providers, add the price per model to see dollars; until then you see tokens.</p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  )
}
