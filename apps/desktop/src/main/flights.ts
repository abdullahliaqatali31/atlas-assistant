/**
 * Every aircraft over a wide map view, and where a picked one is going.
 *
 * adsb.lol answers one 1000 nm circle at a time, so a wide view (a continent,
 * the world) is swept area by area on a fixed grid: one call every 1.5 s,
 * nearest the centre first, while the map keeps asking. Areas with aircraft
 * are refreshed after 45 s, empty ones (open ocean) after 10 minutes, and a
 * "slow down" from adsb.lol pauses the sweep for a minute.
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

const inBox = (f: { lat: number; lon: number }, b: GeoBox) => f.lat >= b.south && f.lat <= b.north && f.lon >= b.west && f.lon <= b.east

export class FlightSweep {
  private cells = new Map<string, { at: number; flights: Flight[] }>()
  private wanted: GeoBox | null = null
  private lastAsked = 0
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private pausedUntil = 0

  constructor(private readonly deps: { getJson: GetJson; log?: (level: 'info' | 'warn', message: string) => void }) {}

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
    const seen = new Set<string>()
    const flights: Flight[] = []
    let loaded = 0
    for (const c of list) {
      const hit = this.cells.get(c.id)
      if (!hit) continue
      loaded++
      for (const f of hit.flights) {
        if (seen.has(f.hex) || !inBox(f, box)) continue
        seen.add(f.hex)
        flights.push(f)
        if (flights.length >= MAX_FLIGHTS) break
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
      const raw = await this.deps.getJson(`https://api.adsb.lol/v2/lat/${next.lat.toFixed(3)}/lon/${next.lon.toFixed(3)}/dist/${SWEEP_RADIUS_NM}`)
      this.cells.set(next.id, { at: Date.now(), flights: parseFlights(raw) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (/HTTP (420|429)/.test(msg)) {
        this.pausedUntil = Date.now() + BACKOFF_MS
        this.deps.log?.('info', 'Flights: adsb.lol asked to slow down; the sweep pauses a minute.')
      } else {
        // Try this area again later, keeping what it showed before.
        const prev = this.cells.get(next.id)
        this.cells.set(next.id, { at: Date.now() - BUSY_TTL + 10_000, flights: prev?.flights ?? [] })
      }
    } finally {
      this.busy = false
    }
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
