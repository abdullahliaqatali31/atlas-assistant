/**
 * The live world, main side: keeps the runtime's latest snapshot for the
 * World page and relays the page's requests (add or remove a place, refresh).
 */
import { randomUUID } from 'node:crypto'

import type { HostEvent, HostRequest } from '../shared/ipc.ts'
import { osCredentialStore } from '@assistant/runtime'

import { EMPTY_WORLD, parseFlights, parseLaunches, parseOpenSky, parseRadio, WLD, type Flight, type Launch, type RadioStation, type FlightsArea, type GeoBox, type SatelliteElements, type WorldOp, type WorldSnapshot } from '../shared/world.ts'
import { CameraDirectory } from './cameras.ts'
import { FlightSweep, RouteBook } from './flights.ts'
import { ShipFeed } from './ships.ts'
import { WebcamService } from './webcams.ts'

const TIMEOUT_MS = 60_000
const FLIGHTS_TTL = 15_000
const FLIGHTS_GAP = 5_000
const FLIGHTS_BACKOFF = 60_000
/** adsb.lol answers for up to 1000 nautical miles around a point. */
const FLIGHTS_MAX_NM = 1000
const MILITARY_TTL = 60_000
/** OpenSky fills in only where adsb.lol sees fewer aircraft than this, every 3 minutes at most, up to 120 calls a day. */
const OPENSKY_WHEN_FEWER = 40
const OPENSKY_GAP = 3 * 60_000
const OPENSKY_DAILY = 120
const SATELLITES_TTL = 6 * 3_600_000

/** A map area from the page, checked. */
const toBox = (raw: unknown): GeoBox => {
  const b = raw as { south?: unknown; west?: unknown; north?: unknown; east?: unknown } | null
  const ok = (v: unknown, max: number) => typeof v === 'number' && Math.abs(v) <= max
  if (!b || !ok(b.south, 90) || !ok(b.north, 90) || !ok(b.west, 180) || !ok(b.east, 180)) throw new Error('Bad map area.')
  return { south: b.south as number, north: b.north as number, west: b.west as number, east: b.east as number }
}

const getJson = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Atlas personal assistant (open source)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<unknown>
}

export class WorldService {
  private snapshot: WorldSnapshot = EMPTY_WORLD
  private readonly pending = new Map<string, (error?: string) => void>()
  private flightCache = new Map<string, { at: number; flights: Flight[] }>()
  private lastFlightCall = 0
  private flightsPausedUntil = 0
  private lastFlights: Flight[] = []
  private militaryCache: { at: number; flights: Flight[] } | null = null
  private openSkyCache: { at: number; lat: number; lon: number; flights: Flight[] } | null = null
  private openSkyDay = { day: '', calls: 0 }
  private openSkyPausedUntil = 0
  private satellites: { at: number; list: SatelliteElements[] } | null = null
  private readonly cams = new CameraDirectory((level, message) => this.deps.log?.(level, message))
  readonly webcams = new WebcamService({ secrets: osCredentialStore(), log: (level, message) => this.deps.log?.(level, message) })
  private readonly sweep = new FlightSweep({ getJson, log: (level, message) => this.deps.log?.(level, message) })
  private readonly routes = new RouteBook({ getJson })
  readonly ships = new ShipFeed({ secrets: osCredentialStore(), log: (level, message) => this.deps.log?.(level, message) })

  constructor(
    private readonly deps: {
      handle: <T>(channel: string, fn: (a: unknown, b: unknown, c?: unknown, d?: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      toRuntime: (msg: Extract<HostRequest, { type: 'world-op' }>) => boolean
      requireOwner: () => void
      log?: (level: 'info' | 'warn', message: string) => void
    },
  ) {}

  onHostEvent(e: Extract<HostEvent, { type: 'world' | 'world-result' }>) {
    if (e.type === 'world') {
      this.snapshot = e.snapshot
      this.deps.toRenderer(WLD.changed, e.snapshot)
      return
    }
    this.pending.get(e.requestId)?.(e.error)
    this.pending.delete(e.requestId)
  }

  private ask(op: WorldOp): Promise<WorldSnapshot> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The assistant did not answer in time.'))
      }, TIMEOUT_MS)
      this.pending.set(requestId, error => {
        clearTimeout(timer)
        if (error) reject(new Error(error))
        else resolve(this.snapshot)
      })
      if (!this.deps.toRuntime({ type: 'world-op', requestId, op })) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error('The assistant is not ready yet.'))
      }
    })
  }

  /**
   * Aircraft near a point from adsb.lol, a community service: nearby map moves
   * share one answer, at most one call every 5 s, a minute off after it says
   * slow down (HTTP 420/429), and the last flights meanwhile.
   */
  async flights(lat: unknown, lon: unknown, dist: number, fill = false): Promise<Flight[]> {
    if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Bad position.')
    // Military aircraft come worldwide at any zoom; dist 0 asks for them alone (zoomed far out).
    const military = await this.military()
    if (dist <= 0) return military
    const radius = Math.round(Math.min(FLIGHTS_MAX_NM, Math.max(10, dist)) / 50) * 50 || 50
    const merge = async (regional: Flight[]) => {
      // Thin adsb.lol coverage here (Pakistan, much of Asia and Africa): the owner may let OpenSky fill in.
      const extra = fill && regional.length < OPENSKY_WHEN_FEWER ? await this.openSky(lat, lon, radius) : []
      const seen = new Set(regional.map(f => f.hex))
      const out = [...regional]
      for (const f of [...extra, ...military]) if (!seen.has(f.hex)) (seen.add(f.hex), out.push(f))
      return out
    }
    const key = `${Math.round(lat)},${Math.round(lon)},${radius}`
    const hit = this.flightCache.get(key)
    const now = Date.now()
    if (hit && now - hit.at < FLIGHTS_TTL) return merge(hit.flights)
    if (now < this.flightsPausedUntil || now - this.lastFlightCall < FLIGHTS_GAP) return merge(hit?.flights ?? this.lastFlights)
    this.lastFlightCall = now
    let raw: unknown
    try {
      raw = await getJson(`https://api.adsb.lol/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radius}`)
    } catch (e) {
      if (/HTTP (420|429)/.test(e instanceof Error ? e.message : '')) this.flightsPausedUntil = Date.now() + FLIGHTS_BACKOFF
      if (hit || this.lastFlights.length || military.length || fill) return merge(hit?.flights ?? this.lastFlights)
      throw e
    }
    const flights = parseFlights(raw)
    this.lastFlights = flights
    this.flightCache.set(key, { at: Date.now(), flights })
    if (this.flightCache.size > 50) this.flightCache.delete(this.flightCache.keys().next().value!)
    return merge(flights)
  }

  /**
   * OpenSky Network (non-commercial terms, so only when the owner turns it
   * on): a box around the view, at most one call every 3 minutes and at most
   * OPENSKY_DAILY a day, so the free anonymous allowance (400 credits) holds.
   */
  private async openSky(lat: number, lon: number, radiusNm: number): Promise<Flight[]> {
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    if (this.openSkyDay.day !== day) this.openSkyDay = { day, calls: 0 }
    const near = this.openSkyCache && Math.abs(this.openSkyCache.lat - lat) < 3 && Math.abs(this.openSkyCache.lon - lon) < 3
    if (near && now - this.openSkyCache!.at < OPENSKY_GAP) return this.openSkyCache!.flights
    if (this.openSkyDay.calls >= OPENSKY_DAILY || now < this.openSkyPausedUntil) return near ? this.openSkyCache!.flights : []
    // A box about the view's size, at most 20° on a side (bigger boxes cost more credits).
    const dLat = Math.min(10, radiusNm / 60)
    const dLon = Math.min(10, radiusNm / 60 / Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
    const box = `lamin=${(lat - dLat).toFixed(2)}&lomin=${(lon - dLon).toFixed(2)}&lamax=${(lat + dLat).toFixed(2)}&lomax=${(lon + dLon).toFixed(2)}`
    this.openSkyDay.calls++
    try {
      const flights = parseOpenSky(await getJson(`https://opensky-network.org/api/states/all?${box}`))
      this.openSkyCache = { at: now, lat, lon, flights }
      return flights
    } catch (e) {
      if (/HTTP 429/.test(e instanceof Error ? e.message : '')) this.openSkyPausedUntil = now + 30 * 60_000
      this.deps.log?.('warn', `OpenSky: ${e instanceof Error ? e.message : String(e)}`)
      return near ? this.openSkyCache!.flights : []
    }
  }

  /** Military aircraft worldwide (adsb.lol /v2/mil), at most once a minute; the last list on failure. */
  private async military(): Promise<Flight[]> {
    const now = Date.now()
    if (this.militaryCache && now - this.militaryCache.at < MILITARY_TTL) return this.militaryCache.flights
    if (now < this.flightsPausedUntil) return this.militaryCache?.flights ?? []
    try {
      const flights = parseFlights(await getJson('https://api.adsb.lol/v2/mil')).map(f => ({ ...f, military: true }))
      this.militaryCache = { at: now, flights }
      return flights
    } catch (e) {
      if (/HTTP (420|429)/.test(e instanceof Error ? e.message : '')) this.flightsPausedUntil = Date.now() + FLIGHTS_BACKOFF
      // Try again in a minute either way, keeping what we had.
      this.militaryCache = { at: now, flights: this.militaryCache?.flights ?? [] }
      return this.militaryCache.flights
    }
  }

  /** Space stations and the brightest satellites from CelesTrak, refreshed every 6 hours. */
  async satelliteList(): Promise<SatelliteElements[]> {
    if (this.satellites && Date.now() - this.satellites.at < SATELLITES_TTL) return this.satellites.list
    const groups = await Promise.all(['stations', 'visual'].map(g => getJson(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`).catch(() => [])))
    const seen = new Set<unknown>()
    const list = groups
      .flatMap(g => (Array.isArray(g) ? (g as SatelliteElements[]) : []))
      .filter(s => !seen.has(s.NORAD_CAT_ID) && seen.add(s.NORAD_CAT_ID))
      .slice(0, 250)
    if (list.length) this.satellites = { at: Date.now(), list }
    return list
  }

  /** Every aircraft over a wide view (swept area by area), plus military worldwide. */
  async flightsArea(box: GeoBox): Promise<FlightsArea> {
    const area = this.sweep.view(box)
    const seen = new Set(area.flights.map(f => f.hex))
    const military = (await this.military()).filter(f => !seen.has(f.hex))
    return { ...area, flights: [...area.flights, ...military] }
  }

  /**
   * The same live layers for the glass panel's map (read-only): the world
   * state, aircraft, ships, satellites and the official cameras in an area.
   */
  async glassData(kind: unknown, raw: unknown): Promise<unknown> {
    switch (kind) {
      case 'state':
        return this.snapshot
      case 'flights':
        return this.flightsArea(toBox(raw))
      case 'ships':
        return this.ships.view(toBox(raw))
      case 'satellites':
        return this.satelliteList()
      case 'cameras':
        return this.cams.cameras()
      default:
        throw new Error('Unknown map layer.')
    }
  }

  private launchCache: { at: number; list: Launch[] } | null = null
  private radioCache: { at: number; list: RadioStation[] } | null = null
  private rainCache: { at: number; time: string | null } | null = null

  /** The next 30 days of launches and the last 7, every 15 minutes at most (the keyless allowance is 15 calls an hour). */
  async launches(): Promise<Launch[]> {
    if (this.launchCache && Date.now() - this.launchCache.at < 15 * 60_000) return this.launchCache.list
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString()
    try {
      const [up, past] = await Promise.all([
        getJson(`https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=60&mode=normal&net__lte=${until}`),
        getJson(`https://ll.thespacedevs.com/2.3.0/launches/previous/?limit=30&mode=normal&net__gte=${since}`),
      ])
      const list = [...parseLaunches(up), ...parseLaunches(past)]
      this.launchCache = { at: Date.now(), list }
      return list
    } catch (e) {
      if (this.launchCache) return this.launchCache.list
      throw e
    }
  }

  /** The most-played stations with a place and a working https stream, refreshed every 6 hours. */
  async radio(): Promise<RadioStation[]> {
    if (this.radioCache && Date.now() - this.radioCache.at < 6 * 3_600_000) return this.radioCache.list
    for (const host of ['de1', 'de2', 'fi1', 'nl1']) {
      try {
        const list = parseRadio(await getJson(`https://${host}.api.radio-browser.info/json/stations/search?has_geo_info=true&is_https=true&hidebroken=true&order=clickcount&reverse=true&limit=3000`))
        if (list.length) {
          this.radioCache = { at: Date.now(), list }
          return list
        }
      } catch {
        // Next mirror.
      }
    }
    return this.radioCache?.list ?? []
  }

  /** The newest 30-minute global rain frame NASA has published (usually 4-6 hours old), looked for every 20 minutes. */
  async rain(): Promise<string | null> {
    if (this.rainCache && Date.now() - this.rainCache.at < 20 * 60_000) return this.rainCache.time
    let time: string | null = null
    const start = Math.floor(Date.now() / 1_800_000) * 1_800_000
    for (let i = 6; i <= 20 && !time; i++) {
      const t = new Date(start - i * 1_800_000).toISOString().replace('.000Z', 'Z')
      try {
        const res = await fetch(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate_30min/default/${t}/GoogleMapsCompatible_Level6/2/1/2.png`, { signal: AbortSignal.timeout(8_000) })
        if (res.ok) time = t
      } catch {
        break
      }
    }
    this.rainCache = { at: Date.now(), time }
    return time
  }

  register() {
    const { handle } = this.deps
    const owner = <T>(fn: (a: unknown) => T | Promise<T>) => (a: unknown) => {
      this.deps.requireOwner()
      return fn(a)
    }
    handle(WLD.state, owner(() => this.snapshot))
    handle(WLD.add, owner(name => {
      if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Type a city or place.')
      return this.ask({ kind: 'add', name: name.trim() })
    }))
    handle(WLD.remove, owner(id => {
      if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw new Error('Unknown place.')
      return this.ask({ kind: 'remove', id })
    }))
    handle(WLD.refresh, owner(() => this.ask({ kind: 'refresh' })))
    // Live layers for the map: fetched here (the page may only load map tiles), politely cached.
    handle(WLD.flights, (lat, lon, dist, fill) => this.flights(lat, lon, typeof dist === 'number' && Number.isFinite(dist) ? dist : 250, fill === true))
    handle(WLD.flightsArea, raw => this.flightsArea(toBox(raw)))
    handle(WLD.flightRoute, callsign => (typeof callsign === 'string' ? this.routes.get(callsign) : null))
    handle(WLD.satellites, () => this.satelliteList())
    handle(WLD.launches, () => this.launches())
    handle(WLD.radio, () => this.radio())
    handle(WLD.rain, () => this.rain())
    handle(WLD.ships, raw => {
      const b = raw as { south?: unknown; west?: unknown; north?: unknown; east?: unknown } | null
      const ok = (v: unknown, max: number) => typeof v === 'number' && Math.abs(v) <= max
      if (!b || !ok(b.south, 90) || !ok(b.north, 90) || !ok(b.west, 180) || !ok(b.east, 180)) throw new Error('Bad map area.')
      return this.ships.view({ south: b.south as number, north: b.north as number, west: b.west as number, east: b.east as number })
    })
    handle(WLD.cameras, () => this.cams.cameras())
    handle(WLD.cameraImage, id => {
      if (typeof id !== 'string' || !/^[a-z]{2,3}:[\w.-]{1,40}$/.test(id)) throw new Error('Unknown camera.')
      return id.startsWith('wc:') ? this.webcams.image(id) : this.cams.image(id)
    })
    handle(WLD.webcams, (raw, zoom) => {
      const b = raw as { south?: unknown; west?: unknown; north?: unknown; east?: unknown } | null
      const ok = (v: unknown, max: number) => typeof v === 'number' && Math.abs(v) <= max
      if (!b || !ok(b.south, 90) || !ok(b.north, 90) || !ok(b.west, 180) || !ok(b.east, 180) || typeof zoom !== 'number' || !Number.isFinite(zoom)) throw new Error('Bad map area.')
      return this.webcams.view({ south: b.south as number, north: b.north as number, west: b.west as number, east: b.east as number }, zoom)
    })
    handle(WLD.webcamsKey, owner(key => {
      if (key !== null && typeof key !== 'string') throw new Error('Paste the key.')
      return this.webcams.setKey(key as string | null)
    }))
    handle(WLD.shipsKey, owner(key => {
      if (key !== null && typeof key !== 'string') throw new Error('Paste the key.')
      this.ships.setKey(key as string | null)
      return { hasKey: this.ships.hasKey }
    }))
  }
}
