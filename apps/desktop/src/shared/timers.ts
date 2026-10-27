/**
 * Timers and alarms the owner sets ("10 minute ka timer", "subah 6 baje
 * uthana", "har weekday 9 baje standup"). They ring whatever the mode or the
 * quiet hours: the owner asked for them. Times are the PC's local time.
 */

export type Repeat = 'daily' | 'weekdays' | { everyMin: number } | null

export interface Timer {
  id: string
  label: string
  /** When it rings next (ms). */
  at: number
  repeat: Repeat
  created: number
}

export interface TimersView {
  timers: Timer[]
  /** Ringing now: Stop or Snooze answers it. */
  ringing: Timer | null
}

export type TimerOp =
  | { kind: 'set'; label: string; inMinutes?: number | undefined; at?: string | undefined; repeat?: Repeat | undefined }
  | { kind: 'list' }
  | { kind: 'cancel'; n?: number | undefined; all?: boolean | undefined }

export const TM = {
  state: 'timers:state',
  changed: 'timers:changed',
  /** The page's Stop and Snooze on a ringing timer, and cancelling one from the list. */
  stop: 'timers:stop',
  snooze: 'timers:snooze',
  cancel: 'timers:cancel',
} as const

export interface TimersBridge {
  state(): Promise<TimersView>
  stop(): Promise<TimersView>
  snooze(minutes: number): Promise<TimersView>
  cancel(id: string): Promise<TimersView>
  onChanged(cb: (v: TimersView) => void): () => void
}

export const MAX_TIMERS = 40
const MINUTE = 60_000

/** "06:30", "6:30", "18:05" → minutes after midnight, or null. */
const clock = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : null
}

const isWeekday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6

/** The next local time at this clock time, after `now` (today if still ahead, else tomorrow); weekdays skip Saturday and Sunday. */
export const nextAtClock = (now: number, minutes: number, weekdaysOnly = false): number => {
  const d = new Date(now)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  while (weekdaysOnly && !isWeekday(d)) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** When a timer that just rang rings again, or null when it was a one-off. */
export const nextAfter = (t: Timer, now: number): number | null => {
  if (!t.repeat) return null
  if (typeof t.repeat === 'object') {
    let at = t.at + t.repeat.everyMin * MINUTE
    while (at <= now) at += t.repeat.everyMin * MINUTE
    return at
  }
  const d = new Date(t.at)
  return nextAtClock(Math.max(now, t.at), d.getHours() * 60 + d.getMinutes(), t.repeat === 'weekdays')
}

/** When a new timer first rings: in N minutes, at a clock time (local), or at an ISO time. A string is the reason it cannot be set. */
export const firstAt = (op: Extract<TimerOp, { kind: 'set' }>, now: number): number | string => {
  if (op.inMinutes !== undefined) {
    if (!(op.inMinutes > 0 && op.inMinutes <= 7 * 24 * 60)) return 'A timer runs from 1 second to 7 days.'
    return now + Math.round(op.inMinutes * MINUTE)
  }
  if (op.at) {
    const c = clock(op.at)
    if (c !== null) return nextAtClock(now, c, op.repeat === 'weekdays')
    const t = Date.parse(op.at)
    if (Number.isNaN(t)) return 'Say a time like 06:30, or a full date and time.'
    if (t <= now) return 'That time has already passed.'
    if (t - now > 366 * 24 * 60 * MINUTE) return 'That is more than a year away; add it as a task instead.'
    return t
  }
  if (op.repeat && typeof op.repeat === 'object') return now + op.repeat.everyMin * MINUTE
  return 'Say when: in how many minutes, or at what time.'
}

/** The timer tools' input, checked. */
export const timerOpFromTool = (name: string, input: Record<string, unknown>): TimerOp | string => {
  if (name === 'timers_list') return { kind: 'list' }
  if (name === 'timer_cancel') {
    if (input.all === true) return { kind: 'cancel', all: true }
    const n = input.number
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? { kind: 'cancel', n } : 'Which timer? Its number from timers_list, or all.'
  }
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 120) : 'Timer'
  const minutes = typeof input.in_minutes === 'number' && Number.isFinite(input.in_minutes) ? input.in_minutes : undefined
  const at = typeof input.at === 'string' && input.at.trim() ? input.at.trim().slice(0, 40) : undefined
  const every = typeof input.every_minutes === 'number' && Number.isFinite(input.every_minutes) ? Math.round(input.every_minutes) : undefined
  let repeat: Repeat = null
  if (input.repeat === 'daily' || input.repeat === 'weekdays') repeat = input.repeat
  else if (every !== undefined) {
    if (every < 1 || every > 24 * 60) return 'every_minutes runs from 1 to 1440.'
    repeat = { everyMin: every }
  }
  if (minutes === undefined && !at && !(repeat && typeof repeat === 'object')) return 'Say when: in_minutes, or at (06:30 or a full date and time).'
  return { kind: 'set', label, inMinutes: minutes, at, repeat }
}

const pad = (n: number) => String(n).padStart(2, '0')
const timeOf = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "in 9 min (14:32)", "tomorrow 06:30", "Fri 24 Oct 09:00". */
export const whenText = (at: number, now: number): string => {
  const mins = Math.round((at - now) / MINUTE)
  if (mins < 60) return `in ${Math.max(0, mins)} min (${timeOf(at)})`
  const d = new Date(at)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(today.getDate() + 1)
  if (d.toDateString() === today.toDateString()) return `today ${timeOf(at)}`
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${timeOf(at)}`
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${timeOf(at)}`
}

export const repeatText = (r: Repeat): string => (r === null ? '' : r === 'daily' ? 'every day' : r === 'weekdays' ? 'every weekday' : `every ${r.everyMin} min`)

/** The list as Atlas reads it, soonest first, numbered for timer_cancel. */
export const describeTimers = (timers: Timer[], now: number): string => {
  if (!timers.length) return 'No timers or alarms are set.'
  return [...timers]
    .sort((a, b) => a.at - b.at)
    .map((t, i) => `${i + 1}. ${t.label}: ${whenText(t.at, now)}${t.repeat ? `, ${repeatText(t.repeat)}` : ''}`)
    .join('\n')
}
