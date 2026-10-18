/**
 * The live world, main side: keeps the runtime's latest snapshot for the
 * World page and relays the page's requests (add or remove a place, refresh).
 */
import { randomUUID } from 'node:crypto'

import type { HostEvent, HostRequest } from '../shared/ipc.ts'
import { osCredentialStore } from '@assistant/runtime'

import { EMPTY_WORLD, parseFlights, WLD, type Flight, type SatelliteElements, type WorldOp, type WorldSnapshot } from '../shared/world.ts'
import { ShipFeed } from './ships.ts'

const TIMEOUT_MS = 60_000
const FLIGHTS_TTL = 15_000
const FLIGHTS_GAP = 5_000
const FLIGHTS_BACKOFF = 60_000
const SATELLITES_TTL = 6 * 3_600_000

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
  private satellites: { at: number; list: SatelliteElements[] } | null = null
  readonly ships = new ShipFeed({ secrets: osCredentialStore(), log: (level, message) => this.deps.log?.(level, message) })

  constructor(
    private readonly deps: {
      handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
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
  async flights(lat: unknown, lon: unknown, dist: number): Promise<Flight[]> {
    if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Bad position.')
    const key = `${Math.round(lat)},${Math.round(lon)}`
    const hit = this.flightCache.get(key)
    const now = Date.now()
    if (hit && now - hit.at < FLIGHTS_TTL) return hit.flights
    if (now < this.flightsPausedUntil || now - this.lastFlightCall < FLIGHTS_GAP) return hit?.flights ?? this.lastFlights
    this.lastFlightCall = now
    let raw: unknown
    try {
      raw = await getJson(`https://api.adsb.lol/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${Math.min(250, Math.max(10, dist))}`)
    } catch (e) {
      if (/HTTP (420|429)/.test(e instanceof Error ? e.message : '')) this.flightsPausedUntil = Date.now() + FLIGHTS_BACKOFF
      if (hit || this.lastFlights.length) return hit?.flights ?? this.lastFlights
      throw e
    }
    const flights = parseFlights(raw)
    this.lastFlights = flights
    this.flightCache.set(key, { at: Date.now(), flights })
    if (this.flightCache.size > 50) this.flightCache.delete(this.flightCache.keys().next().value!)
    return flights
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
    handle(WLD.flights, (lat, lon) => this.flights(lat, lon, 250))
    handle(WLD.satellites, () => this.satelliteList())
    handle(WLD.ships, raw => {
      const b = raw as { south?: unknown; west?: unknown; north?: unknown; east?: unknown } | null
      const ok = (v: unknown, max: number) => typeof v === 'number' && Math.abs(v) <= max
      if (!b || !ok(b.south, 90) || !ok(b.north, 90) || !ok(b.west, 180) || !ok(b.east, 180)) throw new Error('Bad map area.')
      return this.ships.view({ south: b.south as number, north: b.north as number, west: b.west as number, east: b.east as number })
    })
    handle(WLD.shipsKey, owner(key => {
      if (key !== null && typeof key !== 'string') throw new Error('Paste the key.')
      this.ships.setKey(key as string | null)
      return { hasKey: this.ships.hasKey }
    }))
  }
}
