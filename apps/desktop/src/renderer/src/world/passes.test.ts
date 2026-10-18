import * as satellite from 'satellite.js'
import { describe, expect, it } from 'vitest'

import { aboveNow, elevationAt, nextPasses } from './passes.ts'

// The ISS on 2024-01-15 (a real element set); passes are computed near its epoch.
const ISS = satellite.twoline2satrec(
  '1 25544U 98067A   24015.50000000  .00016717  00000+0  30306-3 0  9993',
  '2 25544  51.6416 295.3200 0005784  62.9876  63.8925 15.49815950434741',
)
const EPOCH = Date.UTC(2024, 0, 15, 12)
const KARACHI = { lat: 24.86, lon: 67.0 }

describe('satellite passes', () => {
  it('finds ISS passes over Karachi in the next two days, each a few minutes long and high enough', () => {
    const passes = nextPasses(ISS, KARACHI, EPOCH, { hours: 48, limit: 10 })
    expect(passes.length).toBeGreaterThanOrEqual(2)
    for (const p of passes) {
      expect(p.maxElevation).toBeGreaterThanOrEqual(10)
      expect(p.maxElevation).toBeLessThanOrEqual(90)
      const minutes = (p.set - p.rise) / 60_000
      expect(minutes).toBeGreaterThan(1)
      expect(minutes).toBeLessThan(13)
      expect(p.maxAt).toBeGreaterThanOrEqual(p.rise)
      expect(p.maxAt).toBeLessThanOrEqual(p.set)
    }
    // In time order, never overlapping.
    for (let i = 1; i < passes.length; i++) expect(passes[i]!.rise).toBeGreaterThan(passes[i - 1]!.set)
  })

  it('places rise and set on the horizon to within a few tenths of a degree', () => {
    const [p] = nextPasses(ISS, KARACHI, EPOCH)
    expect(Math.abs(elevationAt(ISS, KARACHI, new Date(p!.rise))!)).toBeLessThan(0.5)
    expect(Math.abs(elevationAt(ISS, KARACHI, new Date(p!.set))!)).toBeLessThan(0.5)
  })

  it('never finds the ISS over the poles (its orbit stays below 52° latitude)', () => {
    expect(nextPasses(ISS, { lat: 89, lon: 0 }, EPOCH, { hours: 24 })).toEqual([])
  })

  it('counts what is above the horizon', () => {
    const [p] = nextPasses(ISS, KARACHI, EPOCH)
    expect(aboveNow([{ rec: ISS }], KARACHI, new Date(p!.maxAt))).toBe(1)
  })
})
