import { describe, expect, it } from 'vitest'

import { parseAdsbdbRoute } from '../../../shared/world.ts'
import { routeFeatures, routeProgress } from './mapops.ts'

const FRA = { iata_code: 'FRA', icao_code: 'EDDF', name: 'Frankfurt am Main Airport', municipality: 'Frankfurt am Main', country_name: 'Germany', latitude: 50.03333, longitude: 8.57056 }
const JFK = { iata_code: 'JFK', icao_code: 'KJFK', name: 'John F Kennedy International Airport', municipality: 'New York', country_name: 'United States', latitude: 40.6398, longitude: -73.7789 }

describe('flight route on the map', () => {
  it('draws flown and ahead around the aircraft, and says how far along it is', () => {
    const route = parseAdsbdbRoute({ response: { flightroute: { callsign: 'DLH400', origin: FRA, destination: JFK } } })!
    const over = [-30, 52] as [number, number]
    const fc = routeFeatures(route, over)
    const flown = fc.features.find(f => f.properties.part === 'flown')!
    const ahead = fc.features.find(f => f.properties.part === 'ahead')!
    const close = (p: unknown) => (p as number[]).forEach((v, i) => expect(v).toBeCloseTo(over[i]!, 6))
    close(flown.geometry.coordinates.at(-1))
    close(ahead.geometry.coordinates[0])
    expect(fc.features.filter(f => f.geometry.type === 'Point').map(f => f.properties.code)).toEqual(['FRA', 'JFK'])
    const at = routeProgress(route, { lat: 52, lon: -30 })
    expect(at.fraction).toBeGreaterThan(0.4)
    expect(at.fraction).toBeLessThan(0.7)
    expect(at.kmLeft).toBeGreaterThan(2000)
    expect(routeFeatures(null, over).features).toEqual([])
  })
})
