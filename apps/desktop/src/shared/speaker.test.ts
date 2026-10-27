import { describe, expect, it } from 'vitest'

import { averagePrint, bytesToSamples, consistent, cosine, judge, samplesToBytes, speakerNote } from './speaker.ts'

const v = (...xs: number[]) => xs

describe('voice ID', () => {
  it('measures and averages prints', () => {
    expect(cosine(v(1, 0), v(1, 0))).toBe(1)
    expect(cosine(v(1, 0), v(0, 1))).toBe(0)
    const avg = averagePrint([v(1, 0), v(0.9, 0.1)])
    expect(Math.hypot(...avg)).toBeCloseTo(1)
    expect(consistent([v(1, 0), v(0.95, 0.05)])).toBe(true)
    expect(consistent([v(1, 0), v(0, 1)])).toBe(false)
  })

  it('tells the owner, a known person, a guest and an unsure match apart', () => {
    const people = [
      { name: 'Hamza', owner: true, print: v(1, 0, 0) },
      { name: 'Sara', owner: false, print: v(0, 1, 0) },
    ]
    expect(judge(v(0.95, 0.1, 0), people)).toMatchObject({ name: 'Hamza', verdict: 'owner' })
    expect(judge(v(0.1, 0.95, 0), people)).toMatchObject({ name: 'Sara', verdict: 'known' })
    expect(judge(v(0, 0.1, 1), people)).toMatchObject({ name: null, verdict: 'guest' })
    expect(judge(v(0.3, 0, 0.7), people).verdict).toBe('unsure')
    expect(judge(v(1, 0, 0), []).verdict).toBe('unsure')
  })

  it('warns Atlas only about someone else, never about the owner or an unsure voice', () => {
    expect(speakerNote({ name: 'Hamza', verdict: 'owner', score: 0.8 }, 'Hamza')).toBe('')
    expect(speakerNote({ name: null, verdict: 'unsure', score: 0.4 }, 'Hamza')).toBe('')
    expect(speakerNote({ name: null, verdict: 'guest', score: 0.1 }, 'Hamza')).toMatch(/not Hamza’s/)
    expect(speakerNote({ name: 'Sara', verdict: 'known', score: 0.7 }, 'Hamza')).toMatch(/Sara/)
  })

  it('carries samples as bytes and back', () => {
    const s = Float32Array.from([0.5, -0.25, 1])
    expect([...bytesToSamples(samplesToBytes(s))]).toEqual([0.5, -0.25, 1])
  })
})
