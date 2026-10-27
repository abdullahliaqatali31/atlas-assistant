/**
 * Atlas's watches in the page: the notice card when one fires (top right,
 * over everything, with "Quiet 15 min"), and the list in Today with a switch
 * and a remove for each. The same notice shows on the PC as a notification
 * and on Telegram (main/watches.ts).
 */
import { BellRing, Eye, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { whenText, type WatchesView, type WatchNotice } from '../../../shared/watches.ts'
import { nameOf } from '../ui/assistantName.ts'

/** Notices as they come; each stays a minute unless dismissed. */
export function WatchNotices({ compact = false }: { compact?: boolean }) {
  const [notices, setNotices] = useState<WatchNotice[]>([])
  useEffect(
    () =>
      window.watches.onFired(n => {
        setNotices(list => [...list.filter(x => x.watchId !== n.watchId || !n.watchId), n].slice(-3))
        setTimeout(() => setNotices(list => list.filter(x => x !== n)), 60_000)
      }),
    [],
  )
  if (!notices.length) return null
  const drop = (n: WatchNotice) => setNotices(list => list.filter(x => x !== n))
  return (
    <div className={`fixed z-[89] space-y-2 ${compact ? 'inset-x-2 top-2' : 'right-4 top-14 w-[min(360px,calc(100vw-2rem))]'}`}>
      {notices.map(n => (
        <div key={`${n.watchId}-${n.at}`} role="alert" className="rounded-2xl border border-warm/60 bg-solid p-3 shadow-2xl ring-1 ring-black/20">
          <div className="flex items-start gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warm/20 text-warm">
              <BellRing className="size-[18px]" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{n.label}</p>
              <p className="text-sm">{n.text}</p>
              {n.count > 1 && <p className="text-[11px] text-muted">Reminder {n.count}</p>}
            </div>
            <button type="button" onClick={() => drop(n)} className="text-muted hover:text-text" aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
          {n.watchId && (
            <div className="mt-2 flex justify-end">
              <button type="button" className="btn" onClick={() => void window.watches.quiet(n.watchId, 15).then(() => drop(n))}>
                Quiet 15 min
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** The watches Atlas set for itself (in Today). */
export function WatchesCard() {
  const [view, setView] = useState<WatchesView | null>(null)
  useEffect(() => {
    void window.watches.state().then(setView, () => undefined)
    return window.watches.onChanged(setView)
  }, [])
  if (!view || !view.watches.length) return null
  return (
    <section className="tile space-y-2 p-3">
      <h3 className="hud-label flex items-center gap-1.5">
        <Eye className="size-3.5" aria-hidden /> {nameOf()} keeps an eye on
      </h3>
      {view.watches.map(w => (
        <div key={w.id} className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={w.on} onChange={e => void window.watches.toggle(w.id, e.target.checked).then(setView)} aria-label={`${w.label} on`} />
          <div className="min-w-0 flex-1">
            <p className="truncate">
              {w.label}
              {w.state.since && <span className="ml-1.5 text-[11px] text-warm">· now</span>}
            </p>
            <p className="text-xs text-muted">
              When {whenText(w)}
              {w.everyMin ? `, every ${w.everyMin} min` : ''}: “{w.message}”
            </p>
          </div>
          <button type="button" className="text-muted hover:text-danger" title="Remove" aria-label={`Remove ${w.label}`} onClick={() => void window.watches.remove(w.id).then(setView)}>
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </section>
  )
}
