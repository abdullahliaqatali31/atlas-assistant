import { describe, expect, it } from 'vitest'

import type { Flight } from '../../../shared/world.ts'
import { createGlide } from './geo.ts'

const plane = (lat: number, lon: number, seen = 0): Flight => ({ hex: 'abc', lat, lon, seen, track: 90, speed: 0, altitude: 30000 }) as unknown as Flight

describe('planes glide instead of jumping', () => {
  it('fades a small jump out over a couple of seconds', () => {
    const g = createGlide(2500, 25)
    expect(g.place(plane(10, 10), 0, 0).lon).toBe(10)
    // A new fix 0.05° (~5 km) east: shown where it was, then easing over.
    expect(g.place(plane(10, 10.05), 100, 0).lon).toBeCloseTo(10, 2)
    const mid = g.place(plane(10, 10.05), 1000, 0).lon
    expect(mid).toBeGreaterThan(10)
    expect(mid).toBeLessThan(10.05)
    expect(g.place(plane(10, 10.05), 4000, 0).lon).toBeCloseTo(10.05, 3)
  })

  it('snaps a jump too big to be real', () => {
    const g = createGlide(2500, 25)
    g.place(plane(10, 10), 0, 0)
    expect(g.place(plane(10, 12), 100, 0).lon).toBe(12)
  })
})
