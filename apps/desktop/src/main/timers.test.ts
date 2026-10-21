import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TM, type TimersView } from '../shared/timers.ts'
import { TimerService } from './timers.ts'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-timers-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const setup = () => {
  let now = new Date(2026, 9, 22, 10, 0).getTime()
  const calls: string[] = []
  const handlers = new Map<string, (a: unknown, b: unknown) => unknown>()
  const svc = new TimerService({
    file: join(dir, 'timers.json'),
    now: () => now,
    handle: (ch, fn) => void handlers.set(ch, fn as (a: unknown, b: unknown) => unknown),
    toRenderer: () => undefined,
    ring: label => calls.push(`ring ${label}`),
    quiet: () => calls.push('quiet'),
    notice: title => calls.push(`notice ${title}`),
    log: () => undefined,
  })
  svc.register()
  // The clock and the timers move together, a second at a time.
  const advance = (ms: number) => {
    for (let left = ms; left > 0; left -= 1_000) {
      const step = Math.min(1_000, left)
      now += step
      vi.advanceTimersByTime(step)
    }
  }
  return { svc, calls, advance, call: (ch: string, a?: unknown) => handlers.get(ch)!(a, undefined) as TimersView, file: join(dir, 'timers.json') }
}

describe('timer service', () => {
  it('rings when due, stops on Stop, and a one-off is gone after', () => {
    const { svc, calls, advance, call, file } = setup()
    svc.start()
    expect(svc.handle({ kind: 'set', label: 'Tea', inMinutes: 1 })).toMatch(/Set "Tea" for in 1 min/)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1)
    advance(65_000)
    expect(calls).toEqual(['ring Tea'])
    expect(call(TM.state).ringing?.label).toBe('Tea')
    const after = call(TM.stop)
    expect(after.ringing).toBeNull()
    expect(after.timers).toHaveLength(0)
    expect(calls).toEqual(['ring Tea', 'quiet'])
  })

  it('snoozes for five minutes, and a repeat keeps its own schedule too', () => {
    const { svc, calls, advance, call } = setup()
    svc.start()
    svc.handle({ kind: 'set', label: 'Water', repeat: { everyMin: 60 } })
    advance(60 * 60_000 + 5_000)
    expect(calls[0]).toBe('ring Water')
    const v = call(TM.snooze, 5)
    // The snoozed one-off in 5 min, plus the hourly one going on.
    expect(v.timers.map(t => t.label)).toEqual(['Water', 'Water'])
    expect(v.timers.filter(t => t.repeat === null)).toHaveLength(1)
  })

  it('stops ringing after a minute and says it was missed', () => {
    const { svc, calls, advance } = setup()
    svc.start()
    svc.handle({ kind: 'set', label: 'Call', inMinutes: 0.1 })
    advance(10_000)
    advance(61_000)
    expect(calls).toEqual(['ring Call', 'quiet', 'notice Missed: Call'])
  })

  it('cancels by number and all', () => {
    const { svc } = setup()
    svc.handle({ kind: 'set', label: 'A', inMinutes: 5 })
    svc.handle({ kind: 'set', label: 'B', inMinutes: 2 })
    expect(svc.handle({ kind: 'cancel', n: 1 })).toBe('Cancelled "B".')
    expect(svc.handle({ kind: 'cancel', all: true })).toBe('Cancelled all 1 timer.')
    expect(svc.handle({ kind: 'list' })).toBe('No timers or alarms are set.')
  })
})
