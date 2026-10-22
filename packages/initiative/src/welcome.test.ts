import { DAY, HOUR, type InitiativeEvent } from '@assistant/shared'
import { describe, expect, it } from 'vitest'

import { decide, DEFAULT_PREFS } from './index.ts'
import { QUIET_BELOW, recordWelcome, welcomeChance, welcomeContext, type WelcomeTable } from './welcome.ts'

// 10:00 local in Karachi (UTC+5).
const at = Date.UTC(2026, 9, 22, 5, 0)
const prefs = { ...DEFAULT_PREFS, utcOffsetMin: 300 }
const nudge: Extract<InitiativeEvent, { type: 'agenda' }> = { type: 'agenda', at, key: 'nudge:water', kind: 'question', title: 'Paani piya?', instruction: '', evidence: '', expectsAnswer: false }
const history = { handled: new Map<string, number>(), routineDeliveredAt: [] }

describe('learning when speaking up is welcome', () => {
  it('judges routine speak-ups by kind and time of day, and leaves reminders and urgent things alone', () => {
    expect(welcomeContext(nudge, 300)).toBe('agenda:question@morning')
    expect(welcomeContext({ type: 'commitment.due', at, commitmentId: 'c', title: 'x' }, 300)).toBeNull()
    expect(welcomeContext({ ...nudge, key: 'skill:report' }, 300)).toBeNull()
  })

  it('starts out allowing, goes quiet after a few "not now"s, and comes back with welcome replies', () => {
    let t: WelcomeTable = {}
    expect(welcomeChance(t, 'agenda:question@morning', at)).toBeGreaterThan(QUIET_BELOW)
    expect(decide(nudge, 'companion', history, prefs, t).channel).toBe('speak')
    for (let i = 0; i < 3; i++) t = recordWelcome(t, 'agenda:question@morning', false, at)
    const quiet = decide(nudge, 'companion', history, prefs, t)
    expect(quiet.channel).toBe('notify')
    expect(quiet.reason).toMatch(/usually pass/)
    // Another time of day is its own context.
    expect(decide({ ...nudge, at: at + 8 * HOUR }, 'companion', history, prefs, t).channel).toBe('speak')
    for (let i = 0; i < 4; i++) t = recordWelcome(t, 'agenda:question@morning', true, at)
    expect(decide(nudge, 'companion', history, prefs, t).channel).toBe('speak')
  })

  it('forgets slowly: a "no" fades over weeks, so it is tried again', () => {
    let t: WelcomeTable = {}
    for (let i = 0; i < 3; i++) t = recordWelcome(t, 'welcome-back@evening', false, at)
    expect(welcomeChance(t, 'welcome-back@evening', at)).toBeLessThan(QUIET_BELOW)
    expect(welcomeChance(t, 'welcome-back@evening', at + 30 * DAY)).toBeGreaterThan(QUIET_BELOW)
  })

  it('never overrides the owner’s rules', () => {
    expect(decide(nudge, 'focus', history, prefs, {}).channel).toBe('queue')
  })
})
