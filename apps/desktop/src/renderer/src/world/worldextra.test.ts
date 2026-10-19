import { describe, expect, it } from 'vitest'

import { parseLaunches, parseRadio } from '../../../shared/world.ts'
import { deadReckon, flightLabel, launchWhen, rainTiles } from './geo.ts'
import type { Flight } from '../../../shared/world.ts'

const plane = (over: Partial<Flight> = {}): Flight => ({ hex: 'abc123', callsign: 'PIA301', registration: 'AP-BMH', type: 'B77W', lat: 25, lon: 67, altitude: 34_000, speed: 480, track: 90, military: false, squawk: '', verticalRate: 0, emergency: 'none', seen: 0, ...over })

describe('world extras', () => {
  it('labels flights the way a radar screen does', () => {
    expect(flightLabel(plane())).toBe('PIA301 FL340')
    expect(flightLabel(plane({ altitude: 9_480 }))).toBe('PIA301 9,500 ft')
    expect(flightLabel(plane({ altitude: null }))).toBe('PIA301')
  })

  it('glides a plane along its track between polls, never one on the ground, at most 90 s', () => {
    const east = deadReckon(plane(), 60)
    // 480 kt for a minute is 8 nm east: 8/(60·cos 25°) degrees of longitude.
    expect(east.lon - 67).toBeCloseTo(8 / (60 * Math.cos((25 * Math.PI) / 180)), 5)
    expect(east.lat).toBeCloseTo(25, 6)
    expect(deadReckon(plane({ altitude: null }), 60)).toEqual(plane({ altitude: null }))
    expect(deadReckon(plane(), 600).lon).toBeCloseTo(deadReckon(plane(), 90).lon, 6)
  })

  it('reads launches and radio stations, dropping ones without a place', () => {
    const launches = parseLaunches({ results: [{ id: 'x1', name: 'Falcon 9 | Starlink', net: '2026-10-21T10:00:00Z', status: { abbrev: 'Go' }, launch_service_provider: { name: 'SpaceX' }, rocket: { configuration: { name: 'Falcon 9' } }, mission: { name: 'Starlink', orbit: { name: 'LEO' } }, pad: { name: 'SLC-40', latitude: '28.56', longitude: '-80.57', location: { name: 'Cape Canaveral' } } }, { id: 'x2', net: 'soon', pad: {} }] })
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({ rocket: 'Falcon 9', status: 'Go', lat: 28.56, lon: -80.57, orbit: 'LEO' })
    const radio = parseRadio([
      { stationuuid: 'r1', name: 'City FM 89', url_resolved: 'https://stream.example/cityfm', geo_lat: 24.86, geo_long: 67.0, country: 'Pakistan', tags: 'music,urdu', codec: 'MP3', bitrate: 128, lastcheckok: 1 },
      { stationuuid: 'r2', name: 'Plain http', url_resolved: 'http://insecure.example', geo_lat: 1, geo_long: 1 },
      { stationuuid: 'r3', name: 'Nowhere', url_resolved: 'https://x.example', geo_lat: 0, geo_long: 0 },
    ])
    expect(radio.map(r => r.name)).toEqual(['City FM 89'])
  })

  it('says when a launch is, and picks the newest rain frame or yesterday', () => {
    const now = Date.parse('2026-10-20T10:00:00Z')
    expect(launchWhen(now + 2 * 86_400_000 + 4 * 3_600_000, now)).toBe('in 2 d 4 h')
    expect(launchWhen(now - 3 * 3_600_000, now)).toBe('launched 3 h 0 min ago')
    expect(rainTiles('2026-10-20T04:00:00Z')).toContain('IMERG_Precipitation_Rate_30min/default/2026-10-20T04:00:00Z/')
    expect(rainTiles(null, now)).toContain('IMERG_Precipitation_Rate/default/2026-10-19/')
  })
})
