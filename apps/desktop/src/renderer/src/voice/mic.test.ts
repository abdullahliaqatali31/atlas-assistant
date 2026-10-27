import { describe, expect, it } from 'vitest'

import { NoiseFloor } from './mic.ts'

describe('the room noise floor', () => {
  it('drops to a quieter room at once and rises slowly, never learning speech as noise', () => {
    const f = new NoiseFloor()
    f.update(0.02, false)
    expect(f.value).toBeCloseTo(0.02)
    for (let i = 0; i < 20; i++) f.update(0.005, false)
    expect(f.value).toBeLessThan(0.006)
    // Speech (marked as such) never raises it.
    for (let i = 0; i < 50; i++) f.update(0.3, true)
    expect(f.value).toBeLessThan(0.006)
    // A fan that starts is learned over a few seconds of 40 ms frames.
    for (let i = 0; i < 100; i++) f.update(0.03, false)
    expect(f.value).toBeGreaterThan(0.02)
  })
})
