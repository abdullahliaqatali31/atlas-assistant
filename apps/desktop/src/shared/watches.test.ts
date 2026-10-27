import { describe, expect, it } from 'vitest'

import type { SystemSnapshot } from './system.ts'
import { EMPTY_STATE, holds, noticeText, step, watchOpFromTool, type Watch, type WatchState } from './watches.ts'

const MIN = 60_000
const reading = (at: number, percent: number, charging: boolean, extra: Partial<SystemSnapshot> = {}): SystemSnapshot => ({
  at,
  wifi: { on: true, connected: true, name: 'Home', internet: 'internet', signal: null, band: null, locationBlocked: false },
  ethernet: { connected: false, name: null, internet: 'none' },
  bluetooth: { on: true, devices: [{ name: 'Sony WH-1000XM4', kind: 'headphones', connected: true }] },
  battery: { percent, charging },
  vpn: null,
  airplane: false,
  ...extra,
})

const battery: Watch = { id: 'w1', label: 'Battery low', when: [{ signal: 'battery', below: 20 }, { signal: 'charging', is: false }], message: 'Battery {battery}: charger lagao', everyMin: 2, on: true, created: 0 }

describe('watches', () => {
  it('checks what the PC reports', () => {
    const s = reading(0, 15, false)
    expect(holds({ signal: 'battery', below: 20 }, s)).toBe(true)
    expect(holds({ signal: 'battery', above: 20 }, s)).toBe(false)
    expect(holds({ signal: 'charging', is: false }, s)).toBe(true)
    expect(holds({ signal: 'internet', is: false }, s)).toBe(false)
    expect(holds({ signal: 'bluetooth', device: 'sony', connected: true }, s)).toBe(true)
    // A desktop has no battery: battery conditions never hold there.
    expect(holds({ signal: 'battery', below: 20 }, { ...s, battery: null })).toBe(false)
  })

  it('reminds every 2 minutes while the battery is low, and stops when the charger goes in', () => {
    let st: WatchState = EMPTY_STATE
    const sent: number[] = []
    const at = (t: number, percent: number, charging: boolean) => {
      const r = step(battery, st, reading(t, percent, charging), t)
      st = r.state
      if (r.send) sent.push(t / MIN)
    }
    at(0, 25, false) // fine
    at(1 * MIN, 19, false) // low: first notice
    at(2 * MIN, 18, false) // a minute later: not yet
    at(3 * MIN, 17, false) // two minutes: again
    at(4 * MIN, 16, false)
    at(5 * MIN, 16, false) // again
    at(6 * MIN, 16, true) // charger in: stops
    at(8 * MIN, 17, true)
    at(9 * MIN, 17, false) // unplugged while still low: starts over at once
    expect(sent).toEqual([1, 3, 5, 9])
    expect(st.sent).toBe(1)
  })

  it('stays quiet while asked, then goes on if it still holds', () => {
    let st: WatchState = { since: 0, lastSent: 0, sent: 1, quietUntil: 15 * MIN }
    expect(step(battery, st, reading(10 * MIN, 10, false), 10 * MIN).send).toBe(false)
    const r = step(battery, st, reading(16 * MIN, 10, false), 16 * MIN)
    expect(r.send).toBe(true)
    st = r.state
    expect(st.sent).toBe(2)
  })

  it('a stale reading (the PC asleep) decides nothing', () => {
    expect(step(battery, EMPTY_STATE, reading(0, 10, false), 30 * MIN).send).toBe(false)
  })

  it('once-only watches speak once each time they start holding', () => {
    const w: Watch = { ...battery, everyMin: 0 }
    let st = step(w, EMPTY_STATE, reading(0, 10, false), 0)
    expect(st.send).toBe(true)
    st = step(w, st.state, reading(10 * MIN, 10, false), 10 * MIN)
    expect(st.send).toBe(false)
  })

  it('fills in the battery level', () => {
    expect(noticeText(battery, reading(0, 14, false))).toBe('Battery 14%: charger lagao')
  })

  it('checks the tool input', () => {
    expect(watchOpFromTool('watch_set', { label: 'Battery low', when: [{ signal: 'battery', below: 20 }, { signal: 'charging', is: false }], message: 'Charger lagao', every_minutes: 2 })).toMatchObject({ kind: 'set', everyMin: 2 })
    expect(watchOpFromTool('watch_set', { label: 'x', when: [{ signal: 'cpu', above: 90 }], message: 'hot' })).toMatch(/Unknown signal/)
    expect(watchOpFromTool('watch_set', { label: 'x', when: [{ signal: 'battery' }], message: 'm' })).toMatch(/below or above/)
    expect(watchOpFromTool('watch_set', { label: 'x', when: [{ signal: 'battery', below: 20 }], message: 'm', every_minutes: 0.2 })).toMatchObject({ everyMin: 1 })
    expect(watchOpFromTool('notify_me', { text: 'Meeting in 5' })).toEqual({ kind: 'notify', title: '', text: 'Meeting in 5' })
    expect(watchOpFromTool('watch_remove', {})).toMatch(/Which watch/)
  })
})
