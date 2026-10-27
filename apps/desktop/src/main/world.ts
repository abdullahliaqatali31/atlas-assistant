/**
 * The live world, main side: keeps the runtime's latest snapshot for the
 * World page and relays the page's requests (add or remove a place, refresh).
 */
import { randomUUID } from 'node:crypto'

import type { HostEvent, HostRequest } from '../shared/ipc.ts'
import { osCredentialStore } from '@assistant/runtime'

import { EMPTY_WORLD, parseFirms, type FireSpot, countryQuery, parseCountryCard, type CountryCard, isHex, isWikiId, parseWikiThing, wikiQuery, type WikiThing, parseAdsbdbAircraft, parseOpenSkyTrack, type AircraftInfo, type FlightTrack, parseFlights, parseLaunches, parseOpenSky, parseRadio, WLD, type Flight, type Launch, type RadioStation, type FlightsArea, type GeoBox, type SatelliteElements, type WorldOp, type WorldSnapshot } from '../shared/world.ts'
import { isCableId, parseCableDetail, parseCables, parseLandings, SAT_GROUPS, type CableDetail, type CablesResult } from '../shared/space.ts'
import { CameraDirectory } from './cameras.ts'
import { IntelFeed } from './intel.ts'
import { ImageCache } from './images.ts'
import { INSTRUMENTS, parseYahooChart, type Quote } from '../shared/markets.ts'
import { parsePlaneAlert, parseRichest, RICHEST_QUERY, type RichPerson, type VipCategory, type VipFlying, type VipPlane } from '../shared/vip.ts'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AdsbFeed, FlightSweep, OpenSkyBaseline, RouteBook } from './flights.ts'
import { ShipFeed } from './ships.ts'
import { TrafficService } from './traffic.ts'
import { OpenSkyAuth } from './opensky.ts'
import type { WorldDataOp } from '../shared/ui.ts'
import { WebcamService } from './webcams.ts'

const TIMEOUT_MS = 60_000
const FLIGHTS_TTL = 15_000
const CABLES_TTL = 24 * 3600_000
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
  /** Every aircraft OpenSky sees, every 150 s while a map is open (signed-in owners only). */
  private readonly baseline: OpenSkyBaseline = new OpenSkyBaseline({
    signedIn: () => this.openSkyAuth.signedIn,
    getJson: url => this.openSkyJson(url, true),
    parse: parseOpenSky,
    log: (level, message) => this.deps.log?.(level, message),
  })
  /** The owner's OpenSky API client, when set in Power up (else anonymous). */
  private readonly openSkyAuth = new OpenSkyAuth({ client: () => osCredentialStore().get('OPENSKY_CLIENT') ?? null })

  /** OpenSky JSON, signed in when the owner has a client (and anonymous if the client is refused). */
  private async openSkyJson(url: string, signedInOnly = false): Promise<unknown> {
    const headers = await this.openSkyAuth.headers().catch((e: unknown) => {
      this.deps.log?.('warn', `OpenSky sign-in: ${e instanceof Error ? e.message : String(e)}`)
      return {}
    })
    // Worldwide calls cost 4 credits: never anonymously, where they would use up the small allowance.
    if (signedInOnly && !('Authorization' in headers)) throw new Error('Not signed in to OpenSky.')
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
  private satellites: { at: number; list: SatelliteElements[] } | null = null
  private satellitesAll: { at: number; list: SatelliteElements[] } | null = null
  private cablesCache: { at: number; data: CablesResult } | null = null
  private cableCards = new Map<string, CableDetail | null>()
  private airframes = new Map<string, { at: number; info: AircraftInfo | null }>()
  private tracks = new Map<string, { at: number; track: FlightTrack | null }>()
  private wikiCache = new Map<string, { at: number; thing: WikiThing | null }>()
  private wikiQueue: Promise<unknown> = Promise.resolve()
  private wikiPausedUntil = 0
  private quotes: { at: number; list: Quote[] } | null = null
  private quoting: Promise<Quote[]> | null = null
  private countryCards = new Map<string, { at: number; card: CountryCard | null }>()
  private vipDb: { at: number; planes: Map<string, VipPlane> } | null = null
  private vipLoading: Promise<Map<string, VipPlane>> | null = null
  private rich: { at: number; list: RichPerson[] } | null = null
  private readonly cams = new CameraDirectory((level, message) => this.deps.log?.(level, message))
  readonly webcams = new WebcamService({ secrets: osCredentialStore(), log: (level, message) => this.deps.log?.(level, message) })
  private readonly adsb = new AdsbFeed(getJson)
  private readonly sweep = new FlightSweep({ getJson, feed: this.adsb, log: (level, message) => this.deps.log?.(level, message) })
  private readonly routes = new RouteBook({ getJson })
  private readonly traffic = new TrafficService({ key: () => osCredentialStore().get('TOMTOM_API_KEY') ?? null, log: (level, message) => this.deps.log?.(level, message) })
  readonly ships = new ShipFeed({ secrets: osCredentialStore(), log: (level, message) => this.deps.log?.(level, message) })

  constructor(
    private readonly deps: {
      handle: <T>(channel: string, fn: (a: unknown, b: unknown, c?: unknown, d?: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      toRuntime: (msg: Extract<HostRequest, { type: 'world-op' }>) => boolean
      requireOwner: () => void
      log?: (level: 'info' | 'warn', message: string) => void
      /** Where shape files are kept between runs. */
      cacheDir: string
    },
  ) {
    this.intel = new IntelFeed({ cacheDir: deps.cacheDir, log: deps.log })
    this.cams.useCache(deps.cacheDir)
    this.images = new ImageCache(join(deps.cacheDir, 'images'))
  }
  private readonly intel: IntelFeed
  private readonly images: ImageCache

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
    // Rounded up, so the corners of the view are inside.
    const radius = Math.ceil(Math.min(FLIGHTS_MAX_NM, Math.max(10, dist)) / 50) * 50 || 50
    const merge = async (regional: Flight[]) => {
      // Thin adsb.lol coverage here (Pakistan, much of Asia and Africa): the owner may let OpenSky fill in.
      const extra = fill && regional.length < OPENSKY_WHEN_FEWER ? await this.openSky(lat, lon, radius) : []
      const seen = new Set(regional.map(f => f.hex))
      const out = [...regional]
      // OpenSky's worldwide baseline (signed in) fills what adsb did not send.
      const base = this.baseline.near({ lat, lon }, radius)
      for (const f of [...extra, ...military, ...base]) if (!seen.has(f.hex)) (seen.add(f.hex), out.push(f))
      return out
    }
    const key = `${Math.round(lat)},${Math.round(lon)},${radius}`
    const hit = this.flightCache.get(key)
    const now = Date.now()
    if (hit && now - hit.at < FLIGHTS_TTL) return merge(hit.flights)
    if (now < this.flightsPausedUntil || now - this.lastFlightCall < FLIGHTS_GAP) return merge(hit?.flights ?? [])
    this.lastFlightCall = now
    let raw: unknown
    let covered = radius
    try {
      const r = await this.adsb.point(lat, lon, radius)
      raw = r.data
      covered = r.coveredNm
    } catch (e) {
      if (/HTTP (403|420|429)/.test(e instanceof Error ? e.message : '')) this.flightsPausedUntil = Date.now() + FLIGHTS_BACKOFF
      return merge(hit?.flights ?? [])
    }
    const flights = parseFlights(raw)
    this.lastFlights = flights
    // A short answer (the fallback reaches 250 nm) is not remembered as the whole view.
    if (covered >= radius) this.flightCache.set(key, { at: Date.now(), flights })
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
    // Signed in, OpenSky allows about ten times more.
    if (this.openSkyDay.calls >= (this.openSkyAuth.signedIn ? OPENSKY_DAILY * 8 : OPENSKY_DAILY) || now < this.openSkyPausedUntil) return near ? this.openSkyCache!.flights : []
    // A box about the view's size, at most 20° on a side (bigger boxes cost more credits).
    const dLat = Math.min(10, radiusNm / 60)
    const dLon = Math.min(10, radiusNm / 60 / Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
    const box = `lamin=${(lat - dLat).toFixed(2)}&lomin=${(lon - dLon).toFixed(2)}&lamax=${(lat + dLat).toFixed(2)}&lomax=${(lon + dLon).toFixed(2)}`
    this.openSkyDay.calls++
    try {
      const flights = parseOpenSky(await this.openSkyJson(`https://opensky-network.org/api/states/all?${box}`))
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
    try {
      const flights = parseFlights(await this.adsb.military()).map(f => ({ ...f, military: true }))
      this.militaryCache = { at: now, flights }
      return flights
    } catch {
      // Both feeds failed: try again in a minute, keeping what we had. (Never pauses the regional flights.)
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

  /** Every group the 3D view shows (about 900 objects), each tagged with its group, every 6 hours. */
  async satelliteListAll(): Promise<SatelliteElements[]> {
    if (this.satellitesAll && Date.now() - this.satellitesAll.at < SATELLITES_TTL) return this.satellitesAll.list
    const groups = await Promise.all(SAT_GROUPS.map(g => getJson(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g.id}&FORMAT=json`).then(list => ({ id: g.id, list }), () => ({ id: g.id, list: [] }))))
    const seen = new Set<unknown>()
    const list = groups.flatMap(g => (Array.isArray(g.list) ? (g.list as SatelliteElements[]) : []).filter(s => !seen.has(s.NORAD_CAT_ID) && seen.add(s.NORAD_CAT_ID)).map(s => ({ ...s, _group: g.id })))
    if (list.length) this.satellitesAll = { at: Date.now(), list }
    return list
  }

  /** Submarine cables and landing points from TeleGeography's public map, once a day. */
  async cables(): Promise<CablesResult | null> {
    if (this.cablesCache && Date.now() - this.cablesCache.at < CABLES_TTL) return this.cablesCache.data
    try {
      const [c, l] = await Promise.all([getJson('https://www.submarinecablemap.com/api/v3/cable/cable-geo.json'), getJson('https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json')])
      const data = { cables: parseCables(c), landings: parseLandings(l) }
      if (data.cables.length) this.cablesCache = { at: Date.now(), data }
      return data
    } catch {
      return this.cablesCache?.data ?? null
    }
  }

  /** The airframe (adsbdb), remembered a day: aircraft do not change type or owner often. */
  async aircraft(hex: unknown): Promise<AircraftInfo | null> {
    if (!isHex(hex)) return null
    const key = hex.toLowerCase()
    const hit = this.airframes.get(key)
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.info
    const info = await getJson(`https://api.adsbdb.com/v0/aircraft/${key}`).then(parseAdsbdbAircraft, () => null)
    if (this.airframes.size > 500) this.airframes.delete(this.airframes.keys().next().value!)
    this.airframes.set(key, { at: Date.now(), info })
    return info
  }

  /** This flight's track (OpenSky, anonymous: a few hundred calls a day), remembered two minutes. */
  async track(hex: unknown): Promise<FlightTrack | null> {
    if (!isHex(hex)) return null
    const key = hex.toLowerCase()
    const hit = this.tracks.get(key)
    if (hit && Date.now() - hit.at < 120_000) return hit.track
    const track = await this.openSkyJson(`https://opensky-network.org/api/tracks/all?icao24=${key}&time=0`).then(parseOpenSkyTrack, () => null)
    if (this.tracks.size > 100) this.tracks.delete(this.tracks.keys().next().value!)
    this.tracks.set(key, { at: Date.now(), track })
    return track
  }

  /**
   * Wikidata on a ship or satellite, gently: one query at a time, 1.5 s apart,
   * ten minutes off after a "slow down", remembered a week.
   */
  async wiki(kind: unknown, id: unknown): Promise<WikiThing | null> {
    if (!isWikiId(kind, id)) return null
    const key = `${String(kind)}:${id}`
    const hit = this.wikiCache.get(key)
    if (hit && Date.now() - hit.at < 7 * 86_400_000) return hit.thing
    if (Date.now() < this.wikiPausedUntil) return null
    const run = this.wikiQueue.then(async () => {
      await new Promise(r => setTimeout(r, 1500))
      const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(wikiQuery(kind as 'ship' | 'satellite', id))}`
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Atlas personal assistant (open source desktop app)', accept: 'application/sparql-results+json' } })
      if (res.status === 429 || res.status === 403) {
        this.wikiPausedUntil = Date.now() + 10 * 60_000
        return null
      }
      if (!res.ok) return null
      return parseWikiThing(await res.json())
    })
    this.wikiQueue = run.catch(() => null)
    const thing = await run.catch(() => null)
    if (this.wikiCache.size > 1000) this.wikiCache.delete(this.wikiCache.keys().next().value!)
    this.wikiCache.set(key, { at: Date.now(), thing })
    return thing
  }

  /** One Wikidata query through the gentle queue (one at a time, 1.5 s apart, paused after a refusal). */
  private sparql(query: string): Promise<unknown> {
    if (Date.now() < this.wikiPausedUntil) return Promise.resolve(null)
    const run = this.wikiQueue.then(async () => {
      await new Promise(r => setTimeout(r, 1500))
      const res = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'Atlas personal assistant (open source desktop app)', accept: 'application/sparql-results+json' } })
      if (res.status === 429 || res.status === 403) {
        this.wikiPausedUntil = Date.now() + 10 * 60_000
        return null
      }
      return res.ok ? res.json() : null
    })
    this.wikiQueue = run.catch(() => null)
    return run.catch(() => null)
  }

  /** plane-alert-db (ODbL): fetched once a day, kept on disk between runs. */
  private async vipPlanes(): Promise<Map<string, VipPlane>> {
    if (this.vipDb && Date.now() - this.vipDb.at < 24 * 3600_000) return this.vipDb.planes
    this.vipLoading ??= (async () => {
      const file = join(this.deps.cacheDir, 'plane-alert-db.csv')
      let csv = ''
      try {
        const st = await stat(file)
        if (Date.now() - st.mtimeMs < 24 * 3600_000) csv = await readFile(file, 'utf8')
      } catch {
        // Not cached yet.
      }
      if (!csv) {
        const res = await fetch('https://raw.githubusercontent.com/sdr-enthusiasts/plane-alert-db/main/plane-alert-db.csv', { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'Atlas personal assistant (open source)' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        csv = await res.text()
        await mkdir(this.deps.cacheDir, { recursive: true }).catch(() => undefined)
        await writeFile(file, csv).catch(() => undefined)
      }
      const planes = parsePlaneAlert(csv)
      this.vipDb = { at: Date.now(), planes }
      return planes
    })().finally(() => {
      this.vipLoading = null
    })
    return this.vipLoading
  }

  /** VIP aircraft known, and those among the aircraft Atlas holds right now (the sweep, nearby areas, military). */
  async vip() {
    const planes = await this.vipPlanes().catch(() => new Map<string, VipPlane>())
    const counts: Partial<Record<VipCategory, number>> = {}
    for (const p of planes.values()) counts[p.category] = (counts[p.category] ?? 0) + 1
    const seen = new Map<string, Flight>()
    for (const f of this.sweep.everything()) seen.set(f.hex, f)
    for (const c of this.flightCache.values()) if (Date.now() - c.at < 10 * 60_000) for (const f of c.flights) seen.set(f.hex, f)
    for (const f of this.militaryCache?.flights ?? []) seen.set(f.hex, f)
    const flying: VipFlying[] = []
    for (const f of seen.values()) {
      const p = planes.get(f.hex.toLowerCase())
      if (p) flying.push({ ...p, callsign: f.callsign, lat: f.lat, lon: f.lon, altitude: f.altitude, speed: f.speed })
    }
    return { total: planes.size, counts, flying }
  }

  /** The richest people from Wikidata, remembered a day. */
  async richest(): Promise<RichPerson[]> {
    if (this.rich && Date.now() - this.rich.at < 24 * 3600_000) return this.rich.list
    const list = parseRichest(await this.sparql(RICHEST_QUERY))
    if (list.length) this.rich = { at: Date.now(), list }
    return list.length ? list : (this.rich?.list ?? [])
  }

  /** A country's card, remembered a week. */
  async country(iso: unknown): Promise<CountryCard | null> {
    if (typeof iso !== 'string' || !/^[A-Z]{2}$/.test(iso)) return null
    const hit = this.countryCards.get(iso)
    if (hit && Date.now() - hit.at < 7 * 86_400_000) return hit.card
    const card = parseCountryCard(iso, await this.sparql(countryQuery(iso)))
    if (card) this.countryCards.set(iso, { at: Date.now(), card })
    return card
  }

  /** Every instrument's month from Yahoo, a quarter-second apart; the last list for half an hour. */
  async markets(): Promise<Quote[]> {
    if (this.quotes && Date.now() - this.quotes.at < 30 * 60_000) return this.quotes.list
    this.quoting ??= (async () => {
      const list: Quote[] = []
      for (const ins of INSTRUMENTS) {
        const q = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ins.symbol)}?range=1mo&interval=1d`).then(j => parseYahooChart(j, ins), () => null)
        if (q) list.push(q)
        await new Promise(r => setTimeout(r, 250))
      }
      if (list.length) this.quotes = { at: Date.now(), list }
      return list.length ? list : (this.quotes?.list ?? [])
    })().finally(() => {
      this.quoting = null
    })
    return this.quoting
  }

  async cable(id: unknown): Promise<CableDetail | null> {
    if (!isCableId(id)) return null
    if (this.cableCards.has(id)) return this.cableCards.get(id) ?? null
    const card = parseCableDetail(await getJson(`https://www.submarinecablemap.com/api/v3/cable/${id}.json`).catch(() => null))
    if (this.cableCards.size > 300) this.cableCards.delete(this.cableCards.keys().next().value!)
    this.cableCards.set(id, card)
    return card
  }

  /** World data for Atlas, in words (markets, conflict events), without touching the owner's screen. */
  async worldData(op: WorldDataOp): Promise<string> {
    if (op.what === 'markets') {
      const all = await this.markets()
      if (!all.length) return 'Market data is unavailable right now.'
      const q = (op.query ?? '').toLowerCase()
      const list = q ? all.filter(x => `${x.name} ${x.symbol} ${x.group}`.toLowerCase().includes(q)) : all
      if (!list.length) return `Nothing matches "${op.query}". Groups: ${[...new Set(all.map(x => x.group))].join(', ')}.`
      const month = (x: Quote) => (x.closes.length > 1 && x.closes[0] ? ((x.price - x.closes[0]) / x.closes[0]) * 100 : null)
      return list
        .slice(0, q ? 20 : 40)
        .map(x => {
          const m = month(x)
          return `${x.name} (${x.symbol}, ${x.group}): ${x.price.toLocaleString('en-US', { maximumFractionDigits: x.price < 10 ? 4 : 2 })} ${x.currency}, ${x.changePct >= 0 ? '+' : ''}${x.changePct.toFixed(2)}% today${m === null ? '' : `, ${m >= 0 ? '+' : ''}${m.toFixed(1)}% over the month`}`
        })
        .join('\n')
    }
    const events = await this.intel.list(op.hours)
    const want = (op.country ?? '').toLowerCase()
    const list = want ? events.filter(e => e.countryName.toLowerCase().includes(want) || e.country.toLowerCase() === want) : events
    const byCountry = new Map<string, number>()
    for (const e of events) if (e.countryName) byCountry.set(e.countryName, (byCountry.get(e.countryName) ?? 0) + 1)
    const top = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    const alerts = await this.intel.ukraineAlerts().catch(() => [])
    const lines = [
      `${events.length} conflict and unrest events in the last ${op.hours} h${want ? `, ${list.length} in "${op.country}"` : ''}.`,
      top.length ? `Most active: ${top.map(([c, n]) => `${c} ${n}`).join(', ')}.` : '',
      alerts.length ? `Ukraine air-raid alerts now in ${alerts.length} regions.` : '',
      '',
      ...[...list]
        .sort((a, b) => b.severity - a.severity || b.at - a.at)
        .slice(0, 15)
        .map(e => `- [${e.category}, severity ${e.severity}] ${e.title} — ${e.place || e.countryName} (${e.source}, ${Math.max(1, Math.round((Date.now() - e.at) / 3_600_000))} h ago)`),
    ]
    return lines.filter((l, i) => l || i === 3).join('\n')
  }

  /** Every aircraft over a wide view (swept area by area), plus military worldwide. */
  async flightsArea(box: GeoBox): Promise<FlightsArea> {
    const area = this.sweep.view(box)
    const seen = new Set(area.flights.map(f => f.hex))
    const military = (await this.military()).filter(f => !seen.has(f.hex))
    for (const f of military) seen.add(f.hex)
    // OpenSky's worldwide baseline fills what the sweep has not reached yet.
    const base = this.baseline.inBox(box).filter(f => !seen.has(f.hex))
    return { ...area, flights: [...area.flights, ...military, ...base] }
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
  private fireCache: { at: number; list: FireSpot[] } | null = null
  private fireLoading: Promise<FireSpot[]> | null = null

  /** The last day's fires (NASA FIRMS VIIRS, keyless, ~9 MB): every three hours, kept on disk between runs. */
  async fires(): Promise<FireSpot[]> {
    const fresh = (c: { at: number } | null) => c && Date.now() - c.at < 3 * 3600_000
    if (fresh(this.fireCache)) return this.fireCache!.list
    const file = join(this.deps.cacheDir, 'fires.json')
    if (!this.fireCache) {
      try {
        const disk = JSON.parse(await readFile(file, 'utf8')) as { at: number; list: FireSpot[] }
        this.fireCache = disk
        if (fresh(disk)) return disk.list
      } catch {
        // First run: nothing kept yet.
      }
    }
    this.fireLoading ??= (async () => {
      try {
        const res = await fetch('https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv', { signal: AbortSignal.timeout(60_000) })
        if (!res.ok) throw new Error(`NASA FIRMS answered ${res.status}.`)
        const list = parseFirms(await res.text())
        if (!list.length) throw new Error('NASA FIRMS sent no fires.')
        this.fireCache = { at: Date.now(), list }
        await mkdir(this.deps.cacheDir, { recursive: true }).catch(() => undefined)
        await writeFile(file, JSON.stringify(this.fireCache)).catch(() => undefined)
        return list
      } catch (e) {
        this.deps.log?.('warn', `Fires: ${e instanceof Error ? e.message : String(e)}`)
        return this.fireCache?.list ?? []
      } finally {
        this.fireLoading = null
      }
    })()
    return this.fireLoading
  }
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
    handle(WLD.aircraft, hex => this.aircraft(hex))
    handle(WLD.wiki, (kind, id) => this.wiki(kind, id))
    const hours = (h: unknown) => (typeof h === 'number' && Number.isFinite(h) ? h : 24)
    handle(WLD.intelEvents, h => this.intel.list(hours(h)))
    handle(WLD.markets, () => this.markets())
    handle(WLD.image, url => this.images.get(url))
    handle(WLD.vip, () => this.vip())
    handle(WLD.richest, () => this.richest())
    handle(WLD.country, iso => this.country(iso))
    handle(WLD.intelStats, h => this.intel.stats(hours(h)))
    handle(WLD.intelCountries, async () => (await this.intel.countryShapes()).shapes)
    handle(WLD.intelAlerts, () => this.intel.ukraineAlerts())
    handle(WLD.intelUkraine, () => this.intel.ukraineShapes())
    handle(WLD.track, hex => this.track(hex))
    handle(WLD.satellites, which => (which === 'all' ? this.satelliteListAll() : this.satelliteList()))
    handle(WLD.cables, () => this.cables())
    handle(WLD.cable, id => this.cable(id))
    handle(WLD.launches, () => this.launches())
    handle(WLD.fires, () => this.fires())
    handle(WLD.trafficFlow, (box, zoom) => this.traffic.flow(box, zoom))
    handle(WLD.trafficIncidents, box => this.traffic.incidents(box))
    handle(WLD.radio, () => this.radio())
    handle(WLD.rain, () => this.rain())
    // Only the owner's own window, and only while unlocked, gets the 3D keys.
    handle(WLD.map3dKeys, owner(() => {
      const store = osCredentialStore()
      return { google: store.get('GOOGLE_MAPS_API_KEY') ?? null, ion: store.get('CESIUM_ION_TOKEN') ?? null, tomtom: store.get('TOMTOM_API_KEY') ?? null }
    }))
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
