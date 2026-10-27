import { describe, expect, it } from 'vitest'

import { dayContext, sessionContext, startOfLocalDay, toTurns, type DayMessage } from './day.ts'

const m = (speaker: DayMessage['speaker'], content: string, at = 0): DayMessage => ({ speaker, content, at })

describe('startOfLocalDay', () => {
  it('uses the owner time zone', () => {
    // 2026-10-17 20:30 UTC is 01:30 on the 18th in Karachi (UTC+5).
    const now = Date.UTC(2026, 9, 17, 20, 30)
    expect(new Date(startOfLocalDay(now, 300)).toISOString()).toBe('2026-10-17T19:00:00.000Z')
    expect(new Date(startOfLocalDay(now, 0)).toISOString()).toBe('2026-10-17T00:00:00.000Z')
  })
})

describe('toTurns', () => {
  it('alternates roles, merges repeats and never starts with the assistant', () => {
    const turns = toTurns([m('assistant', 'Morning briefing'), m('owner', 'thanks'), m('owner', 'and the quote?'), m('assistant', 'Due today')])
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(turns[2]?.content).toBe('thanks\n\nand the quote?')
  })
})

describe('dayContext', () => {
  it('keeps short days whole', () => {
    expect(dayContext([m('owner', 'hi'), m('assistant', 'salam')], 10)).toEqual({ history: toTurns([m('owner', 'hi'), m('assistant', 'salam')]), digest: '' })
  })

  it('digests the older part of a long day and keeps a window that starts with the owner', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => m(i % 2 ? 'assistant' : 'owner', `message ${i}`))
    const { history, digest } = dayContext(msgs, 10)
    expect(history[0]?.role).toBe('user')
    expect(history.length).toBeLessThanOrEqual(10)
    expect(history.at(-1)?.content).toBe('message 29')
    expect(digest).toContain('Owner: message 0')
    expect(digest).not.toContain('message 29')
  })
})

describe('sessionContext', () => {
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ speaker: (i % 2 === 0 ? 'owner' : 'assistant') as 'owner' | 'assistant', content: `m${i}`, at: 1000 + i }))

  it('keeps a short conversation whole', () => {
    const c = sessionContext(msgs(10), { max: 24, keep: 12, summarizedThrough: 0 })
    expect(c.history).toHaveLength(10)
    expect(c.unsummarized).toEqual([])
  })

  it('cuts a long one back to the last turns, and lists what fell out', () => {
    const c = sessionContext(msgs(30), { max: 24, keep: 12, summarizedThrough: 0 })
    expect(c.history).toHaveLength(12)
    expect(c.history[0]).toEqual({ role: 'user', content: 'm18' })
    expect(c.unsummarized.map(m => m.content)).toEqual(Array.from({ length: 18 }, (_, i) => `m${i}`))
    expect(c.digest.split('\n')[0]).toBe('- Owner: m0')
  })

  it('leaves out of the digest what the summary already covers', () => {
    const c = sessionContext(msgs(30), { max: 24, keep: 12, summarizedThrough: 1009 })
    expect(c.unsummarized.map(m => m.content)).toEqual(['m10', 'm11', 'm12', 'm13', 'm14', 'm15', 'm16', 'm17'])
  })
})
