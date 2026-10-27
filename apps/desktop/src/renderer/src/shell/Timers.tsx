/**
 * Timers and alarms in the page: the card that rings (Stop, Snooze) over
 * everything, and the list in Today. The sound itself plays on the PC (the
 * tray helper), so it rings even with no page open.
 */
import { AlarmClock, BellOff, Repeat, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { repeatText, whenText, type TimersView } from '../../../shared/timers.ts'
import { nameOf } from '../ui/assistantName.ts'

const useTimers = () => {
  const [view, setView] = useState<TimersView | null>(null)
  useEffect(() => {
    void window.timers.state().then(setView, () => undefined)
    return window.timers.onChanged(setView)
  }, [])
  return [view, setView] as const
}

/** The ringing card, top centre over the whole page. */
export function TimerRing() {
  const [view, setView] = useTimers()
  const t = view?.ringing
  if (!t) return null
  return (
    <div role="alertdialog" aria-label={`${t.label} is ringing`} className="fixed left-1/2 top-14 z-[90] w-[min(380px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-warm/60 bg-solid p-4 shadow-2xl ring-1 ring-black/20">
      <div className="flex items-center gap-3">
        <span className="grid size-11 shrink-0 animate-pulse place-items-center rounded-full bg-warm/20 text-warm">
          <AlarmClock className="size-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">{t.label}</p>
          <p className="text-xs text-muted">{t.repeat ? `Rings ${repeatText(t.repeat)}` : `${nameOf()}'s timer`}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" autoFocus className="btn btn-primary flex-1 justify-center" onClick={() => void window.timers.stop().then(setView)}>
          <BellOff className="size-4" aria-hidden /> Stop
        </button>
        <button type="button" className="btn flex-1 justify-center" onClick={() => void window.timers.snooze(5).then(setView)}>
          Snooze 5 min
        </button>
      </div>
    </div>
  )
}

/** What is set, soonest first, each with a cancel button (in Today). */
export function TimersCard() {
  const [view, setView] = useTimers()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  if (!view || !view.timers.length) return null
  return (
    <section className="tile space-y-2 p-3">
      <h3 className="hud-label flex items-center gap-1.5">
        <AlarmClock className="size-3.5" aria-hidden /> Timers and alarms
      </h3>
      {view.timers.map(t => (
        <div key={t.id} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{t.label}</span>
          {t.repeat && <Repeat className="size-3 text-muted" aria-label={repeatText(t.repeat)} />}
          <span className="shrink-0 text-xs text-muted">{whenText(t.at, now)}</span>
          <button type="button" className="text-muted hover:text-danger" title="Cancel" aria-label={`Cancel ${t.label}`} onClick={() => void window.timers.cancel(t.id).then(setView)}>
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </section>
  )
}
