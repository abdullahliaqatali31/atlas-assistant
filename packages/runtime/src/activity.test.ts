import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import { DAY, fixedClock, HOUR, MINUTE } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { ActivityTracker, activityEvidenceSource, DEFAULT_EXCLUDED_APPS, summarizeActivity } from './activity.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-act-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 16, 4))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  const tracker = new ActivityTracker(memory, clock)
  return { clock, memory, tracker }
}

describe('ActivityTracker', () => {
  it('records nothing until the owner opts in', () => {
    const { clock, memory, tracker } = setup()
    tracker.sample({ app: 'EXCEL.EXE', title: 'Quote_v3.xlsx' })
    clock.advance(10 * MINUTE)
    tracker.flush()
    expect(memory.windowActivity(0)).toEqual([])
    memory.close()
  })

  it('turns foreground changes into spans and resumes after opt-in with the current window', () => {
    const { clock, memory, tracker } = setup()
    tracker.sample({ app: 'EXCEL.EXE', title: 'Quote_v3.xlsx' })
    tracker.configure(true, DEFAULT_EXCLUDED_APPS)
    clock.advance(20 * MINUTE)
    tracker.sample({ app: 'chrome', title: 'Client portal' })
    clock.advance(1_000)
    // An alt-tab flick is too short to keep.
    tracker.sample({ app: 'explorer', title: 'Downloads' })
    clock.advance(5 * MINUTE)
    tracker.flush()
    expect(memory.windowActivity(0).map(s => [s.app, s.title, (s.endedAt - s.startedAt) / MINUTE])).toEqual([
      ['EXCEL', 'Quote_v3.xlsx', 20],
      ['explorer', 'Downloads', 5],
    ])
    memory.close()
  })

  it('never stores excluded apps or private windows, not even their titles', () => {
    const { clock, memory, tracker } = setup()
    tracker.configure(true, [...DEFAULT_EXCLUDED_APPS, 'WhatsApp'])
    tracker.sample({ app: 'KeePassXC.exe', title: 'Passwords.kdbx' })
    clock.advance(10 * MINUTE)
    tracker.sample({ app: 'WhatsApp', title: 'Chat with client' })
    clock.advance(10 * MINUTE)
    tracker.sample({ app: 'msedge', title: 'Bank - InPrivate' })
    clock.advance(10 * MINUTE)
    tracker.sample({ app: 'Code', title: 'assistant.ts' })
    clock.advance(10 * MINUTE)
    tracker.flush()
    const stored = JSON.stringify(memory.windowActivity(0))
    expect(stored).not.toMatch(/KeePass|Passwords|WhatsApp|client|Bank/)
    expect(memory.windowActivity(0).map(s => s.app)).toEqual(['Code'])
    memory.close()
  })

  it('stops counting while locked or away and when switched off', () => {
    const { clock, memory, tracker } = setup()
    tracker.configure(true, [])
    tracker.sample({ app: 'Code', title: 'a.ts' })
    clock.advance(10 * MINUTE)
    tracker.pause()
    clock.advance(HOUR)
    tracker.sample({ app: 'chrome', title: 'News' })
    clock.advance(HOUR)
    tracker.resume()
    clock.advance(5 * MINUTE)
    tracker.configure(false, [])
    clock.advance(HOUR)
    tracker.sample({ app: 'Code', title: 'b.ts' })
    tracker.flush()
    expect(memory.windowActivity(0).map(s => [s.app, (s.endedAt - s.startedAt) / MINUTE])).toEqual([
      ['Code', 10],
      ['chrome', 5],
    ])
    memory.close()
  })

  it('keeps raw observations seven days', () => {
    const { clock, memory, tracker } = setup()
    memory.recordWindowSpan({ app: 'old', title: 'x', startedAt: clock.now() - 9 * DAY, endedAt: clock.now() - 8 * DAY })
    memory.recordWindowSpan({ app: 'recent', title: 'y', startedAt: clock.now() - 2 * DAY, endedAt: clock.now() - DAY })
    tracker.configure(true, [])
    expect(memory.windowActivity(0).map(s => s.app)).toEqual(['recent'])
    expect(memory.clearWindowActivity('RECENT')).toBe(1)
    memory.close()
  })
})

describe('activity evidence', () => {
  it('summarises the last day by app and title as an observation, clipped to the window', async () => {
    const { clock, memory } = setup()
    const now = clock.now()
    memory.recordWindowSpan({ app: 'EXCEL', title: 'Quote_v3.xlsx', startedAt: now - 3 * HOUR, endedAt: now - HOUR - 40 * MINUTE })
    memory.recordWindowSpan({ app: 'chrome', title: 'Client portal', startedAt: now - 25 * HOUR, endedAt: now - 23 * HOUR })
    const text = await activityEvidenceSource(memory).collect({ now, utcOffsetMin: 300, signal: new AbortController().signal })
    expect(text).toContain('- EXCEL: 1 h 20 min ("Quote_v3.xlsx" 1 h 20 min)')
    expect(text).toContain('- chrome: 1 h')
    expect(text).toContain('not what was finished')
    expect(summarizeActivity([], 0, 1).apps).toEqual([])
    memory.close()
  })
})
