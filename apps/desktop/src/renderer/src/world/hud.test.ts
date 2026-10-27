import { describe, expect, it } from 'vitest'

import { dms, groundResolution, metres, MODE_FILTER, DISPLAY_MODES, sunElevation } from './hud.ts'

describe('World HUD', () => {
  it('works out ground resolution like a map scale', () => {
    // Zoom 0 at the equator: one 512 px tile spans the whole Earth.
    expect(groundResolution(0, 0)).toBeCloseTo(40_075_016.686 / 512, 3)
    // Every zoom level halves it; latitude shrinks it by cos(lat).
    expect(groundResolution(60, 10)).toBeCloseTo(groundResolution(0, 10) / 2, 6)
    expect(metres(1500)).toBe('1.5 km')
    expect(metres(340.4)).toBe('340 m')
    expect(metres(2.14)).toBe('2.1 m')
  })

  it('knows where the sun is', () => {
    // Equinox noon on the equator: overhead. Midnight: well below.
    expect(sunElevation(0, 0, new Date('2026-03-20T12:00:00Z'))).toBeGreaterThan(85)
    expect(sunElevation(0, 0, new Date('2026-03-20T00:00:00Z'))).toBeLessThan(-80)
    // Karachi, 9 pm local (16:00 UTC) in October: night.
    expect(sunElevation(24.86, 67.0, new Date('2026-10-20T16:00:00Z'))).toBeLessThan(-6)
  })

  it('writes coordinates the military way, and has a filter for every mode', () => {
    expect(dms(24.86, 67.01)).toBe('24°51′36″N 67°00′36″E')
    expect(dms(-33.8568, -151.2153)).toBe('33°51′24″S 151°12′55″W')
    for (const m of DISPLAY_MODES) expect(MODE_FILTER[m]).toBeTruthy()
  })
})
