import { Eye, EyeOff, Trash2, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import type { ActivityView } from '../../shared/activity.ts'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

/**
 * Opt-in active-window tracking: the switch, excluded apps, what was seen in
 * the last 24 hours, and delete. Off by default; titles only, no screenshots.
 */
export function WindowTracking() {
  const [view, setView] = useState<ActivityView | null>(null)
  const [app, setApp] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void window.activity.get().then(setView, () => undefined)
    return window.activity.onChanged(setView)
  }, [])

  const run = async (fn: () => Promise<ActivityView>) => {
    setError('')
    try {
      setView(await fn())
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const exclude = (e: FormEvent) => {
    e.preventDefault()
    const name = app.trim()
    if (!name) return
    void run(() => window.activity.addExcluded(name)).then(() => setApp(''))
  }

  if (!view) return null

  return (
    <section className="tile p-3" aria-labelledby="wt-title">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">
          {view.enabled ? <Eye className="size-[18px]" aria-hidden /> : <EyeOff className="size-[18px]" aria-hidden />}
        </span>
        <h3 id="wt-title" className="flex-1 font-medium">
          Window tracking
        </h3>
        <button
          type="button"
          role="switch"
          aria-checked={view.enabled}
          aria-label={view.enabled ? 'Turn off window tracking' : 'Turn on window tracking'}
          disabled={!view.available}
          onClick={() => void run(() => window.activity.setEnabled(!view.enabled))}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
            view.enabled ? 'border-transparent bg-accent shadow-[0_0_12px_rgba(34,211,238,0.45)]' : 'border-border bg-surface-strong'
          }`}
        >
          <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${view.enabled ? 'left-4' : 'left-0.5'}`} />
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">
        Records which app and window title is in front, so briefings can say what you worked on. No screenshots, no keystrokes, skipped while locked or
        idle, deleted after {view.retentionDays} days.
        {!view.available && ' Not available on this system.'}
      </p>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {view.enabled && view.summary.apps.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="hud-label">Last {view.summary.hours} hours · {formatMinutes(view.summary.totalMinutes)}</p>
          {view.summary.apps.slice(0, 6).map(a => (
            <div key={a.app} className="flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 truncate font-medium" title={a.app}>
                {a.app}
              </span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-strong" aria-hidden>
                <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, (a.minutes / Math.max(1, view.summary.totalMinutes)) * 100)}%` }} />
              </span>
              <span className="w-14 text-right text-muted">{formatMinutes(a.minutes)}</span>
              <button type="button" className="icon-btn size-6" aria-label={`Delete ${a.app} records`} title={`Delete ${a.app} records`} onClick={() => void run(() => window.activity.clear(a.app))}>
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3">
        <p className="hud-label mb-1.5">Never record</p>
        <div className="flex flex-wrap gap-1.5">
          {view.excludedApps.map(x => (
            <span key={x} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs">
              {x}
              <button type="button" aria-label={`Allow ${x} again`} className="text-muted hover:text-text" onClick={() => void run(() => window.activity.removeExcluded(x))}>
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
        <form onSubmit={exclude} className="mt-2 flex gap-2">
          <input value={app} onChange={e => setApp(e.target.value)} placeholder="App name, e.g. WhatsApp" maxLength={80} className="field py-1 text-xs" aria-label="App to never record" />
          <button type="submit" className="btn shrink-0" disabled={!app.trim()}>
            Exclude
          </button>
        </form>
      </div>

      {view.summary.totalMinutes > 0 && (
        <div className="mt-3 flex justify-end">
          <button type="button" className="btn text-danger" onClick={() => void run(() => window.activity.clear())}>
            <Trash2 className="size-3.5" aria-hidden /> Delete all records
          </button>
        </div>
      )}
    </section>
  )
}

const formatMinutes = (m: number) => (m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`)
