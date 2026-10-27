import { HOUR, MINUTE } from '@assistant/shared'
import { describe, expect, it } from 'vitest'

import { decide, DEFAULT_PREFS, type InitiativeHistory } from './index.ts'

const empty: InitiativeHistory = { handled: new Map(), routineDeliveredAt: [] }
const AT = Date.UTC(2026, 9, 17, 4, 0) // 09:00 in Asia/Karachi
const PKT = { ...DEFAULT_PREFS, utcOffsetMin: 300 }

describe('decide', () => {
  it('greets once on the first session of the day', () => {
    const e = { type: 'session.first-of-day', at: AT } as const
    expect(decide(e, 'companion', empty, PKT).channel).toBe('speak')
    expect(decide(e, 'companion', { ...empty, lastBriefingDay: '2026-10-17' }, PKT).channel).toBe('suppress')
  })

  it('suppresses duplicate events (repeated unlock)', () => {
    const e = { type: 'session.first-of-day', at: AT } as const
    const first = decide(e, 'companion', empty, PKT)
    const again = decide({ ...e, at: AT + 5 * MINUTE }, 'companion', { ...empty, handled: new Map([[first.dedupKey, AT]]) }, PKT)
    expect(again.channel).toBe('suppress')
  })

  it('never speaks while locked or away', () => {
    const e = { type: 'commitment.due', at: AT, commitmentId: 'c1', title: 'Send quote' } as const
    expect(decide(e, 'locked', empty, PKT).channel).toBe('queue')
    expect(decide(e, 'away', empty, PKT).channel).toBe('queue')
  })

  it('respects quiet hours that wrap midnight, surfacing urgent items silently', () => {
    const prefs = { ...PKT, quietHours: { startMin: 22 * 60, endMin: 7 * 60 } }
    const night = Date.UTC(2026, 9, 17, 18, 30) // 23:30 PKT
    const routine = { type: 'project.changed', at: night, projectId: 'p', summary: 'x' } as const
    const urgent = { type: 'task.failed', at: night, taskId: 't', title: 'Upload' } as const
    expect(decide(routine, 'companion', empty, prefs).channel).toBe('queue')
    expect(decide(urgent, 'companion', empty, prefs).channel).toBe('notify')
  })

  it('enforces routine cooldown and daily budget', () => {
    const e = { type: 'project.changed', at: AT, projectId: 'p', summary: 'x' } as const
    expect(decide(e, 'work', { ...empty, routineDeliveredAt: [AT - 10 * MINUTE] }, PKT).channel).toBe('queue')
    const five = [1, 2, 3, 4, 5].map(i => AT - i * 2 * HOUR + 4 * HOUR)
    const budgetHit = decide({ ...e, at: AT + 3 * HOUR }, 'work', { ...empty, routineDeliveredAt: five.sort((a, b) => a - b) }, PKT)
    expect(budgetHit.channel).toBe('queue')
  })

  it('queues routine items in focus mode', () => {
    const e = { type: 'session.return-from-idle', at: AT, idleMs: HOUR } as const
    expect(decide(e, 'focus', empty, PKT).channel).toBe('queue')
  })
})
