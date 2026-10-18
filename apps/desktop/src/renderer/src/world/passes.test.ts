import * as satellite from 'satellite.js'
import { describe, expect, it } from 'vitest'

import { aboveNow, elevationAt, groundTrack, horizonKm, nextPasses, orbitFacts, ring } from './passes.ts'

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

describe('orbit drawing', () => {
  it('gives the ISS orbit its real shape: ~400 km up, ~7.7 km/s, 51.6°, ~92 min', () => {
    const f = orbitFacts(ISS, new Date(EPOCH))!
    expect(f.norad).toBe('25544')
    expect(f.altKm).toBeGreaterThan(380)
    expect(f.altKm).toBeLessThan(440)
    expect(f.speedKms).toBeCloseTo(7.66, 1)
    expect(f.inclination).toBe(51.6)
    expect(f.periodMin).toBeGreaterThan(91)
    expect(f.periodMin).toBeLessThan(94)
  })

  it('draws one orbit ahead without jumps, staying inside its inclination', () => {
    const track = groundTrack(ISS, EPOCH, 95)
    expect(track.length).toBe(96)
    for (let i = 1; i < track.length; i++) expect(Math.abs(track[i]![0] - track[i - 1]![0])).toBeLessThan(30)
    expect(Math.max(...track.map(p => Math.abs(p[1])))).toBeLessThan(52)
  })

  it('sizes the footprint from the height and closes the ring', () => {
    expect(horizonKm(420)).toBeGreaterThan(2200)
    expect(horizonKm(420)).toBeLessThan(2400)
    const r = ring([67, 24.86], 100)
    expect(r[0]![0]).toBeCloseTo(r.at(-1)![0], 6)
    expect(r[0]![1]).toBeCloseTo(r.at(-1)![1], 6)
  })
})
