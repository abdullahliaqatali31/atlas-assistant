import { describe, expect, it } from 'vitest'

import { latLonLabel, moonPhase, moonPosition, ringAngle, sunPosition, towards } from './sky.ts'

describe('sun', () => {
  it('stands over the Tropic of Cancer at the June solstice and the equator at the equinox', () => {
    expect(sunPosition(new Date('2024-06-20T20:51:00Z')).lat).toBeCloseTo(23.44, 0)
    expect(Math.abs(sunPosition(new Date('2024-03-20T03:06:00Z')).lat)).toBeLessThan(0.3)
  })
  it('is over Greenwich near noon UTC (within the equation of time)', () => {
    expect(Math.abs(sunPosition(new Date('2024-04-15T12:00:00Z')).lon)).toBeLessThan(4)
    // November: the Sun runs about 16 minutes fast, so it is already ~4° west.
    expect(sunPosition(new Date('2024-11-03T12:00:00Z')).lon).toBeCloseTo(-4.1, 0)
  })
})

describe('moon', () => {
  it('knows full and new moon', () => {
    expect(moonPhase(new Date('2024-04-23T23:49:00Z')).fraction).toBeGreaterThan(0.98)
    expect(moonPhase(new Date('2024-04-23T23:49:00Z')).name).toBe('Full moon')
    expect(moonPhase(new Date('2024-04-08T18:21:00Z')).fraction).toBeLessThan(0.02)
    const q = moonPhase(new Date('2024-04-15T19:13:00Z'))
    expect(q.name).toBe('First quarter')
    expect(q.waxing).toBe(true)
    expect(q.fraction).toBeCloseTo(0.5, 1)
  })
  it('stays within its orbit tilt of the ecliptic', () => {
    for (let day = 0; day < 30; day++) expect(Math.abs(moonPosition(new Date(Date.UTC(2024, 0, 1 + day))).lat)).toBeLessThan(29)
  })
  it('stands near the Sun at new moon (solar eclipse, 8 April 2024)', () => {
    const at = new Date('2024-04-08T18:18:00Z')
    const s = towards(sunPosition(at))
    const m = towards(moonPosition(at))
    const angle = (Math.acos(s[0] * m[0] + s[1] * m[1] + s[2] * m[2]) * 180) / Math.PI
    expect(angle).toBeLessThan(2)
  })
})

describe('ring', () => {
  it('places a direction by the camera right / up vectors and fades it along the view axis', () => {
    const right = [1, 0, 0]
    const up = [0, 1, 0]
    const fwd = [0, 0, -1]
    expect(ringAngle([0, 1, 0], right, up, fwd)).toEqual({ angle: Math.PI / 2, visibility: 1 })
    expect(ringAngle([-1, 0, 0], right, up, fwd).angle).toBeCloseTo(Math.PI)
    expect(ringAngle([0, 0, 1], right, up, fwd).visibility).toBe(0)
  })
  it('labels a point', () => {
    expect(latLonLabel({ lat: 23.44, lon: -12.05 })).toBe('23.4°N 12.1°W')
  })
})
