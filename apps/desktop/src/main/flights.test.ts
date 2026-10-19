import { afterEach, describe, expect, it, vi } from 'vitest'

import { kmBetween, parseAdsbdbRoute, sweepCells, SWEEP_RADIUS_NM } from '../shared/world.ts'
import { AdsbFeed, FlightSweep, RouteBook } from './flights.ts'

const WORLD = { south: -90, west: -180, north: 90, east: 180 }

const ADSBDB = {
  response: {
    flightroute: {
      callsign: 'DLH400',
      airline: { name: 'Lufthansa', icao: 'DLH' },
      origin: { iata_code: 'FRA', icao_code: 'EDDF', name: 'Frankfurt am Main Airport', municipality: 'Frankfurt am Main', country_name: 'Germany', latitude: 50.03333, longitude: 8.57056 },
      destination: { iata_code: 'JFK', icao_code: 'KJFK', name: 'John F Kennedy International Airport', municipality: 'New York', country_name: 'United States', latitude: 40.6398, longitude: -73.7789 },
    },
  },
}

const aircraft = (hex: string, lat: number, lon: number) => ({ hex, flight: hex.toUpperCase(), lat, lon, alt_baro: 30000, gs: 450, track: 90 })

afterEach(() => vi.useRealTimers())

describe('sweep grid', () => {
  it('covers every point where aircraft fly with a 1000 nm circle', () => {
    const cells = sweepCells(WORLD)
    expect(cells.length).toBeGreaterThan(60)
    expect(cells.length).toBeLessThan(130)
    const reach = SWEEP_RADIUS_NM * 1.852
    for (let lat = -60; lat <= 75; lat += 2.5)
      for (let lon = -180; lon <= 180; lon += 2.5) {
        const nearest = Math.min(...cells.map(c => kmBetween({ lat, lon }, c)))
        expect(nearest, `${lat},${lon}`).toBeLessThanOrEqual(reach)
      }
  })

  it('uses only the areas a view touches, with the same ids as the world grid', () => {
    const europe = sweepCells({ south: 35, west: -10, north: 60, east: 30 })
    expect(europe.length).toBeGreaterThan(2)
    expect(europe.length).toBeLessThan(12)
    const ids = new Set(sweepCells(WORLD).map(c => c.id))
    for (const c of europe) expect(ids.has(c.id)).toBe(true)
  })
})

describe('FlightSweep', () => {
  it('fills a wide view area by area, nearest the centre first, and merges what it has', async () => {
    vi.useFakeTimers()
    const urls: string[] = []
    const getJson = vi.fn(async (url: string) => {
      urls.push(url)
      const [, lat, lon] = /lat\/(-?[\d.]+)\/lon\/(-?[\d.]+)/.exec(url)!.map(Number) as [number, number, number]
      // Each area sees one aircraft of its own, and one shared with its neighbours.
      return { ac: [aircraft(`a${urls.length}`, lat, lon), aircraft('shared', 48, 10)] }
    })
    const sweep = new FlightSweep({ getJson })
    const box = { south: 35, west: -10, north: 60, east: 30 }
    const first = sweep.view(box)
    expect(first).toMatchObject({ flights: [], loaded: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(urls[0]).toMatch(/dist\/1000$/)
    // The first area asked is the one nearest the view's centre (47.5, 10).
    const [, lat0, lon0] = /lat\/(-?[\d.]+)\/lon\/(-?[\d.]+)/.exec(urls[0]!)!.map(Number) as [number, number, number]
    const nearest = Math.min(...sweepCells(box).map(c => Math.hypot(c.lat - 47.5, c.lon - 10)))
    expect(Math.hypot(lat0 - 47.5, lon0 - 10)).toBeCloseTo(nearest)
    await vi.advanceTimersByTimeAsync(1_500 * (first.cells + 2))
    const full = sweep.view(box)
    expect(full.loaded).toBe(full.cells)
    expect(getJson).toHaveBeenCalledTimes(full.cells)
    expect(full.flights.filter(f => f.hex === 'shared')).toHaveLength(1)
    // Fresh areas are not asked again.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getJson).toHaveBeenCalledTimes(full.cells)
    sweep.stop()
  })

  it('pauses for a minute when adsb.lol and adsb.fi both say slow down, and stops when the map stops asking', async () => {
    vi.useFakeTimers()
    const getJson = vi.fn(async () => {
      throw new Error('HTTP 429')
    })
    const sweep = new FlightSweep({ getJson })
    sweep.view({ south: 35, west: -10, north: 60, east: 30 })
    await vi.advanceTimersByTimeAsync(20_000)
    // One try at each feed, then the pause.
    expect(getJson).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    // Nobody asked for 30 s: the sweep has stopped rather than retrying forever.
    expect(getJson).toHaveBeenCalledTimes(2)
  })
})

describe('AdsbFeed', () => {
  it('uses adsb.fi while adsb.lol is throttling, in the same shape, then goes back to adsb.lol', async () => {
    vi.useFakeTimers()
    const urls: string[] = []
    const getJson = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('adsb.lol') && urls.length === 1) throw new Error('HTTP 429')
      return url.includes('adsb.fi') ? { now: 1, aircraft: [aircraft('fi1', 51, 0)] } : { ac: [aircraft('lol1', 51, 0)] }
    })
    const feed = new AdsbFeed(getJson)
    expect(await feed.point(51, 0, 1000)).toEqual({ ac: [aircraft('fi1', 51, 0)] })
    // adsb.fi answers at most 250 nm.
    expect(urls[1]).toBe('https://opendata.adsb.fi/api/v2/lat/51.000/lon/0.000/dist/250')
    // Still throttled: straight to adsb.fi, no second knock on adsb.lol.
    await feed.point(51, 0, 100)
    expect(urls[2]).toBe('https://opendata.adsb.fi/api/v2/lat/51.000/lon/0.000/dist/100')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await feed.point(51, 0, 100)).toEqual({ ac: [aircraft('lol1', 51, 0)] })
  })

  it('switches on any adsb.lol failure, and reports the adsb.fi error when both fail', async () => {
    const getJson = vi.fn(async (url: string) => {
      throw new Error(url.includes('adsb.lol') ? 'HTTP 403' : 'HTTP 503')
    })
    await expect(new AdsbFeed(getJson).point(0, 0, 100)).rejects.toThrow('HTTP 503')
    expect(getJson).toHaveBeenCalledTimes(2)
  })

  it('falls back for military aircraft too', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('adsb.lol')) throw new Error('HTTP 429')
      return { ac: [aircraft('mil1', 30, 30)] }
    })
    expect(await new AdsbFeed(getJson).military()).toEqual({ ac: [aircraft('mil1', 30, 30)] })
    expect(getJson).toHaveBeenLastCalledWith('https://opendata.adsb.fi/api/v2/mil')
  })
})

describe('flight routes', () => {
  it('reads adsbdb routes and refuses half-known ones', () => {
    expect(parseAdsbdbRoute(ADSBDB)).toMatchObject({ callsign: 'DLH400', airline: 'Lufthansa', origin: { iata: 'FRA', city: 'Frankfurt am Main' }, destination: { iata: 'JFK', lat: 40.6398 } })
    expect(parseAdsbdbRoute({ response: 'unknown callsign' })).toBeNull()
    expect(parseAdsbdbRoute({ response: { flightroute: { origin: ADSBDB.response.flightroute.origin } } })).toBeNull()
  })

  it('caches answers, "no route" included, and never asks for nonsense', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.endsWith('NOPE1')) throw new Error('HTTP 404')
      return ADSBDB
    })
    const book = new RouteBook({ getJson })
    const [a, b] = await Promise.all([book.get('dlh400 '), book.get('DLH400')])
    expect(a?.destination.iata).toBe('JFK')
    expect(b).toBe(a)
    expect(await book.get('NOPE1')).toBeNull()
    expect(await book.get('NOPE1')).toBeNull()
    expect(await book.get('../x')).toBeNull()
    expect(getJson).toHaveBeenCalledTimes(2)
  })
})
