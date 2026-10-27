/**
 * Timers and alarms, kept by the gateway so they ring even while the model's
 * runtime restarts: saved to a file, looked at every few seconds, rung with
 * Windows' alarm sound (through the tray helper) and a card in the page,
 * answered with Stop or Snooze. Unanswered for a minute, a ring stops and
 * says it was missed.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { describeTimers, firstAt, MAX_TIMERS, nextAfter, repeatText, TM, whenText, type Timer, type TimerOp, type TimersView } from '../shared/timers.ts'

const LOOK_MS = 5_000
const RING_MS = 60_000

export class TimerService {
  private timers: Timer[] = []
  private ringing: Timer | null = null
  private ringTimer: ReturnType<typeof setTimeout> | null = null
  private look: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly deps: {
      file: string
      now: () => number
      handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      /** Start and stop the alarm sound, and show a notice (the tray helper). */
      ring: (label: string, detail: string) => void
      quiet: () => void
      notice: (title: string, text: string) => void
      log: (level: 'info' | 'warn', message: string) => void
    },
  ) {
    try {
      const raw = JSON.parse(readFileSync(deps.file, 'utf8')) as Timer[]
      this.timers = Array.isArray(raw) ? raw.filter(t => t && typeof t.id === 'string' && typeof t.at === 'number').slice(0, MAX_TIMERS) : []
    } catch {
      this.timers = []
    }
  }

  start() {
    this.look ??= setInterval(() => this.check(), LOOK_MS)
    this.look.unref?.()
    this.check()
  }

  stop() {
    if (this.look) clearInterval(this.look)
    this.look = null
    this.deps.quiet()
  }

  view(): TimersView {
    return { timers: [...this.timers].sort((a, b) => a.at - b.at), ringing: this.ringing }
  }

  private save() {
    try {
      writeFileSync(this.deps.file, JSON.stringify(this.timers))
    } catch (e) {
      this.deps.log('warn', `Timers not saved: ${(e as Error).message}`)
    }
    this.deps.toRenderer(TM.changed, this.view())
  }

  /** Rings what is due (one at a time; a second waits a few seconds for the first to be answered). */
  private check() {
    if (this.ringing) return
    const now = this.deps.now()
    const due = this.timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)[0]
    if (!due) return
    // Missed by far (the PC was off or asleep): one notice, then on to the next time.
    if (now - due.at > 30 * 60_000) {
      this.deps.notice(`Missed: ${due.label}`, `It was set for ${new Date(due.at).toLocaleString()}.`)
      this.after(due)
      return this.save()
    }
    this.ringing = due
    this.deps.ring(due.label, due.repeat ? `Again ${repeatText(due.repeat)}` : 'Stop or snooze in Atlas')
    this.ringTimer = setTimeout(() => {
      // Nobody answered: stop the sound, keep a notice.
      const t = this.ringing
      if (!t) return
      this.end()
      this.deps.notice(`Missed: ${t.label}`, 'Nobody stopped it in time.')
    }, RING_MS)
    this.save()
  }

  /** A rung timer: the next time for a repeat, gone for a one-off. */
  private after(t: Timer) {
    const next = nextAfter(t, this.deps.now())
    this.timers = next === null ? this.timers.filter(x => x.id !== t.id) : this.timers.map(x => (x.id === t.id ? { ...x, at: next } : x))
  }

  private end() {
    const t = this.ringing
    if (this.ringTimer) clearTimeout(this.ringTimer)
    this.ringTimer = null
    this.ringing = null
    this.deps.quiet()
    if (t) this.after(t)
    this.save()
  }

  /** Atlas's timer tools. */
  handle(op: TimerOp): string {
    const now = this.deps.now()
    if (op.kind === 'list') return describeTimers(this.timers, now)
    if (op.kind === 'cancel') {
      if (op.all) {
        const n = this.timers.length
        this.timers = []
        if (this.ringing) this.end()
        this.save()
        return n ? `Cancelled all ${n} timer${n === 1 ? '' : 's'}.` : 'There were no timers.'
      }
      const t = [...this.timers].sort((a, b) => a.at - b.at)[(op.n ?? 0) - 1]
      if (!t) return `There is no timer ${op.n}. ${describeTimers(this.timers, now)}`
      this.cancel(t.id)
      return `Cancelled "${t.label}".`
    }
    if (this.timers.length >= MAX_TIMERS) return `There are already ${MAX_TIMERS} timers; cancel some first.`
    const at = firstAt(op, now)
    if (typeof at === 'string') return at
    const t: Timer = { id: randomUUID().slice(0, 8), label: op.label, at, repeat: op.repeat ?? null, created: now }
    this.timers.push(t)
    this.save()
    return `Set "${t.label}" for ${whenText(at, now)}${t.repeat ? `, ${repeatText(t.repeat)}` : ''}. It rings even in quiet or focus mode.`
  }

  private cancel(id: string) {
    if (this.ringing?.id === id) {
      if (this.ringTimer) clearTimeout(this.ringTimer)
      this.ringTimer = null
      this.ringing = null
      this.deps.quiet()
    }
    this.timers = this.timers.filter(t => t.id !== id)
    this.save()
  }

  register() {
    const { handle } = this.deps
    handle(TM.state, () => this.view())
    handle(TM.stop, () => {
      if (this.ringing) this.end()
      return this.view()
    })
    handle(TM.snooze, minutes => {
      const t = this.ringing
      if (!t) return this.view()
      const m = typeof minutes === 'number' && minutes >= 1 && minutes <= 60 ? Math.round(minutes) : 5
      if (this.ringTimer) clearTimeout(this.ringTimer)
      this.ringTimer = null
      this.ringing = null
      this.deps.quiet()
      // A snoozed repeat rings in m minutes, then keeps its own schedule after that.
      this.timers = this.timers.map(x => (x.id === t.id ? { ...x, at: this.deps.now() + m * 60_000 } : x))
      if (t.repeat) {
        const next = nextAfter(t, this.deps.now())
        if (next !== null) this.timers.push({ ...t, id: randomUUID().slice(0, 8), at: next })
        this.timers = this.timers.map(x => (x.id === t.id ? { ...x, repeat: null } : x))
      }
      this.save()
      return this.view()
    })
    handle(TM.cancel, id => {
      if (typeof id === 'string') this.cancel(id)
      return this.view()
    })
  }
}
