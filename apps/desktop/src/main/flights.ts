/**
 * Every aircraft over a wide map view, and where a picked one is going.
 *
 * adsb.lol answers one 1000 nm circle at a time, so a wide view (a continent,
 * the world) is swept area by area on a fixed grid: one call every 1.5 s,
 * nearest the centre first, while the map keeps asking. Areas with aircraft
 * are refreshed after 45 s, empty ones (open ocean) after 10 minutes, and a
 * "slow down" from adsb.lol pauses the sweep for a minute.
 *
 * When adsb.lol fails or throttles, adsb.fi (same community data, same
 * format, up to 250 nm) answers for a minute instead; only when both refuse
 * does anything pause.
 *
 * Routes come from adsbdb.com by callsign (free, no key), cached 30 minutes,
 * "no route known" included.
 */
import { parseAdsbdbRoute, parseFlights, sweepCells, SWEEP_RADIUS_NM, type Flight, type FlightRoute, type FlightsArea, type GeoBox } from '../shared/world.ts'

const GAP_MS = 1_500
const BUSY_TTL = 45_000
const EMPTY_TTL = 10 * 60_000
/** The sweep stops this long after the map last asked. */
const IDLE_MS = 30_000
const BACKOFF_MS = 60_000
const MAX_FLIGHTS = 15_000
const ROUTE_TTL = 30 * 60_000
const MAX_ROUTES = 500

type GetJson = (url: string) => Promise<unknown>

const SLOW = /HTTP (403|420|429)/
const ADSBFI_MAX_NM = 250

/** Aircraft around a point (adsb.lol's v2 shape): adsb.lol, or adsb.fi for a minute after adsb.lol fails. Throws adsb.fi's error when both fail. */
export class AdsbFeed {
  private lolPausedUntil = 0

  constructor(private readonly getJson: GetJson) {}

  /** Aircraft around a point, and how far the answer really reaches (adsb.fi stops at 250 nm). */
  async point(lat: number, lon: number, nm: number): Promise<{ data: unknown; coveredNm: number }> {
    const at = `lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/`
    let covered = nm
    const data = await this.get(`https://api.adsb.lol/v2/${at}${nm}`, `https://opendata.adsb.fi/api/v2/${at}${Math.min(ADSBFI_MAX_NM, nm)}`, () => (covered = Math.min(ADSBFI_MAX_NM, nm)))
    return { data, coveredNm: covered }
  }

  /** Military aircraft worldwide. */
  military(): Promise<unknown> {
    return this.get('https://api.adsb.lol/v2/mil', 'https://opendata.adsb.fi/api/v2/mil')
  }

  private async get(lol: string, fi: string, onFallback?: () => void): Promise<unknown> {
    if (Date.now() >= this.lolPausedUntil)
      try {
        return await this.getJson(lol)
      } catch {
        // Refused, throttled or down: adsb.fi for a minute.
        this.lolPausedUntil = Date.now() + BACKOFF_MS
      }
    onFallback?.()
    // adsb.fi names the list "aircraft" on point queries and "ac" on /mil.
    const j = (await this.getJson(fi)) as { ac?: unknown[]; aircraft?: unknown[] }
    return { ac: j?.ac ?? j?.aircraft ?? [] }
  }
}

const inBox = (f: { lat: number; lon: number }, b: GeoBox) => f.lat >= b.south && f.lat <= b.north && f.lon >= b.west && f.lon <= b.east
/** An area's answer older than this is not shown at all. */
const STALE_MS = 10 * 60_000
/** Nautical miles between two points. */
const nm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2
  return 2 * 3440 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * A steady worldwide baseline from OpenSky (only with the owner's own API
 * client): every aircraft OpenSky sees, once every 150 s while a map is
 * open, about 2,300 of the 4,000 daily credits. The adsb feeds' fresher,
 * richer answers win wherever they have the same aircraft; this only makes
 * sure the map is never half empty while they fill in or throttle.
 */
export class OpenSkyBaseline {
  private planes: Flight[] = []
  private at = 0
  private lastAsked = 0
  private timer: NodeJS.Timeout | null = null
  private day = { day: '', calls: 0 }

  constructor(private readonly deps: { signedIn: () => boolean; getJson: (url: string) => Promise<unknown>; parse: (j: unknown) => Flight[]; log?: (level: 'info' | 'warn', message: string) => void }) {}

  /** The aircraft in a box (positions aged by how old the snapshot is); keeps the baseline coming while asked. */
  inBox(box: GeoBox): Flight[] {
    this.touch()
    return this.list().filter(f => inBox(f, box))
  }

  /** Within nm of a point. */
  near(p: { lat: number; lon: number }, radiusNm: number): Flight[] {
    this.touch()
    return this.list().filter(f => nm(f, p) <= radiusNm)
  }

  private list(): Flight[] {
    const age = (Date.now() - this.at) / 1000
    if (!this.at || age > 6 * 60) return []
    return age > 1 ? this.planes.map(f => ({ ...f, seen: f.seen + age })) : this.planes
  }

  private touch() {
    this.lastAsked = Date.now()
    if (this.timer || !this.deps.signedIn()) return
    this.timer = setInterval(() => void this.fetch(), 150_000)
    this.timer.unref?.()
    void this.fetch()
  }

  private async fetch() {
    if (Date.now() - this.lastAsked > 60_000 || !this.deps.signedIn()) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    const today = new Date().toISOString().slice(0, 10)
    if (this.day.day !== today) this.day = { day: today, calls: 0 }
    // 4 credits a call: stop at about 2,800 a day, leaving room for tracks and gap-fill.
    if (this.day.calls >= 700) return
    this.day.calls++
    try {
      const planes = this.deps.parse(await this.deps.getJson('https://opensky-network.org/api/states/all')).filter(f => f.hex && f.seen < 90)
      if (planes.length) {
        this.planes = planes
        this.at = Date.now()
      }
    } catch (e) {
      this.deps.log?.('warn', `OpenSky baseline: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

export class FlightSweep {
  private cells = new Map<string, { at: number; flights: Flight[] }>()
  private wanted: GeoBox | null = null
  private lastAsked = 0
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private pausedUntil = 0
  private readonly feed: AdsbFeed

  constructor(private readonly deps: { getJson: GetJson; feed?: AdsbFeed; log?: (level: 'info' | 'warn', message: string) => void }) {
    this.feed = deps.feed ?? new AdsbFeed(deps.getJson)
  }

  /** What is known for this view now; keeps the sweep going while the map keeps asking. */
  view(box: GeoBox): FlightsArea {
    this.wanted = box
    this.lastAsked = Date.now()
    if (!this.timer) {
      this.timer = setInterval(() => void this.step(), GAP_MS)
      this.timer.unref?.()
      void this.step()
    }
    const list = sweepCells(box)
    const now = Date.now()
    const seen = new Set<string>()
    const flights: Flight[] = []
    let loaded = 0
    cells: for (const c of list) {
      const hit = this.cells.get(c.id)
      // Too old to place a plane honestly: as good as not fetched.
      if (!hit || now - hit.at > STALE_MS) continue
      loaded++
      const age = (now - hit.at) / 1000
      for (const f of hit.flights) {
        if (seen.has(f.hex) || !inBox(f, box)) continue
        seen.add(f.hex)
        // Its position is as old as the answer plus how long ago it was seen then (for dead reckoning).
        flights.push(age > 1 ? { ...f, seen: f.seen + age } : f)
        if (flights.length >= MAX_FLIGHTS) break cells
      }
    }
    return { flights, cells: list.length, loaded }
  }

  /** Fetches the most needed area in view: never fetched first, then the most out of date, nearest the centre. */
  async step() {
    const now = Date.now()
    if (now - this.lastAsked > IDLE_MS) return this.stop()
    if (this.busy || now < this.pausedUntil || !this.wanted) return
    const box = this.wanted
    const cLat = (box.south + box.north) / 2
    const cLon = (box.west + box.east) / 2
    const due = sweepCells(box)
      .map(c => ({ c, hit: this.cells.get(c.id) }))
      .filter(({ hit }) => !hit || now - hit.at > (hit.flights.length ? BUSY_TTL : EMPTY_TTL))
      .sort((a, b) => Number(Boolean(a.hit)) - Number(Boolean(b.hit)) || (a.hit?.at ?? 0) - (b.hit?.at ?? 0) || Math.hypot(a.c.lat - cLat, a.c.lon - cLon) - Math.hypot(b.c.lat - cLat, b.c.lon - cLon))
    const next = due[0]?.c
    if (!next) return
    this.busy = true
    try {
      const { data, coveredNm } = await this.feed.point(next.lat, next.lon, SWEEP_RADIUS_NM)
      const fresh = parseFlights(data)
      if (coveredNm >= SWEEP_RADIUS_NM) this.cells.set(next.id, { at: Date.now(), flights: fresh })
      else {
        // The fallback only reaches the middle of this area: new planes there, the rest as they were, and try again soon.
        const prev = this.cells.get(next.id)
        const ids = new Set(fresh.map(f => f.hex))
        const outside = (prev?.flights ?? []).filter(f => !ids.has(f.hex) && nm(f, next) > coveredNm)
        this.cells.set(next.id, { at: Date.now() - BUSY_TTL + 15_000, flights: [...fresh, ...outside] })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (SLOW.test(msg)) {
        this.pausedUntil = Date.now() + BACKOFF_MS
        this.deps.log?.('info', 'Flights: adsb.lol and adsb.fi asked to slow down; the sweep pauses a minute.')
      } else {
        // Try this area again later, keeping what it showed before.
        const prev = this.cells.get(next.id)
        this.cells.set(next.id, { at: Date.now() - BUSY_TTL + 10_000, flights: prev?.flights ?? [] })
      }
    } finally {
      this.busy = false
    }
  }

  /** Every aircraft the sweep holds that is still fresh (for "VIP flying now"). */
  everything(maxAgeMs = 10 * 60_000): Flight[] {
    const now = Date.now()
    const out = new Map<string, Flight>()
    for (const c of this.cells.values()) if (now - c.at < maxAgeMs) for (const f of c.flights) out.set(f.hex, f)
    return [...out.values()]
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export class RouteBook {
  private cache = new Map<string, { at: number; route: FlightRoute | null }>()
  private inflight = new Map<string, Promise<FlightRoute | null>>()

  constructor(private readonly deps: { getJson: GetJson }) {}

  async get(callsign: string): Promise<FlightRoute | null> {
    const cs = callsign.trim().toUpperCase()
    if (!/^[A-Z0-9]{3,8}$/.test(cs)) return null
    const hit = this.cache.get(cs)
    if (hit && Date.now() - hit.at < ROUTE_TTL) return hit.route
    const running = this.inflight.get(cs)
    if (running) return running
    const ask = (async () => {
      let route: FlightRoute | null = null
      try {
        route = parseAdsbdbRoute(await this.deps.getJson(`https://api.adsbdb.com/v0/callsign/${cs}`))
      } catch (e) {
        // 404 means adsbdb has no route for it; anything else is not remembered.
        if (!/HTTP 404/.test(e instanceof Error ? e.message : '')) return hit?.route ?? null
      }
      this.cache.set(cs, { at: Date.now(), route })
      if (this.cache.size > MAX_ROUTES) this.cache.delete(this.cache.keys().next().value!)
      return route
    })().finally(() => this.inflight.delete(cs))
    this.inflight.set(cs, ask)
    return ask
  }
}
