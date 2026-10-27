import { describe, expect, it } from 'vitest'

import { describeTimers, firstAt, nextAfter, nextAtClock, timerOpFromTool, type Timer } from './timers.ts'

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

describe('timers', () => {
  it('finds the next clock time: today if ahead, else tomorrow, skipping weekends when asked', () => {
    // Wednesday 22 Oct 2026, 10:00 local.
    const now = at(2026, 10, 22, 10)
    expect(nextAtClock(now, 11 * 60)).toBe(at(2026, 10, 22, 11))
    expect(nextAtClock(now, 6 * 60 + 30)).toBe(at(2026, 10, 23, 6, 30))
    // Friday 18:00, weekdays only: next is Monday.
    expect(nextAtClock(at(2026, 10, 23, 18), 9 * 60, true)).toBe(at(2026, 10, 26, 9))
  })

  it('sets one-off and repeating timers', () => {
    const now = at(2026, 10, 22, 10)
    expect(firstAt({ kind: 'set', label: 'Tea', inMinutes: 10 }, now)).toBe(now + 10 * 60_000)
    expect(firstAt({ kind: 'set', label: 'Wake', at: '06:30', repeat: 'daily' }, now)).toBe(at(2026, 10, 23, 6, 30))
    expect(firstAt({ kind: 'set', label: 'x', at: '2020-01-01T00:00:00Z' }, now)).toMatch(/passed/)
    expect(firstAt({ kind: 'set', label: 'x', inMinutes: 0 }, now)).toMatch(/7 days/)
  })

  it('rings again after a repeat, never for a one-off', () => {
    const t: Timer = { id: 'a', label: 'Standup', at: at(2026, 10, 23, 9), repeat: 'weekdays', created: 0 }
    expect(nextAfter(t, at(2026, 10, 23, 9, 1))).toBe(at(2026, 10, 26, 9))
    expect(nextAfter({ ...t, repeat: 'daily' }, at(2026, 10, 23, 9, 1))).toBe(at(2026, 10, 24, 9))
    expect(nextAfter({ ...t, repeat: { everyMin: 30 } }, at(2026, 10, 23, 9, 1))).toBe(at(2026, 10, 23, 9, 30))
    expect(nextAfter({ ...t, repeat: null }, at(2026, 10, 23, 9, 1))).toBeNull()
  })

  it('reads the tools’ input and lists soonest first', () => {
    expect(timerOpFromTool('timer_set', { label: 'Tea', in_minutes: 5 })).toEqual({ kind: 'set', label: 'Tea', inMinutes: 5, at: undefined, repeat: null })
    expect(timerOpFromTool('timer_set', { label: 'Water', every_minutes: 60 })).toMatchObject({ repeat: { everyMin: 60 } })
    expect(timerOpFromTool('timer_set', { label: 'x' })).toMatch(/Say when/)
    expect(timerOpFromTool('timer_cancel', { number: 2 })).toEqual({ kind: 'cancel', n: 2 })
    const now = at(2026, 10, 22, 10)
    expect(describeTimers([{ id: 'b', label: 'Later', at: now + 3 * 3_600_000, repeat: null, created: 0 }, { id: 'a', label: 'Soon', at: now + 5 * 60_000, repeat: null, created: 0 }], now)).toBe('1. Soon: in 5 min (10:05)\n2. Later: today 13:00')
  })
})
