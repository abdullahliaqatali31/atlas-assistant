/**
 * Ships for the World map, from AISStream (free key, owner's own account).
 * One WebSocket, opened only while the map's ships layer is on and closed a
 * minute and a half after the map stops asking; it subscribes to the area on
 * screen (a little wider) and keeps the latest position of each vessel seen
 * there. A dropped or silent connection is retried with backoff while the map
 * is looking, keeping the last positions; only a refused key stops it. The key
 * lives in the Windows credential store, never in a file, a log or the AI's
 * context.
 */
import type { CredentialStore } from '@assistant/runtime'

import { parseAisMessage, shipCategory, type Ship, type ShipsResult } from '../shared/world.ts'

const URL = 'wss://stream.aisstream.io/v0/stream'
const IDLE_MS = 90_000
const STALE_MS = 30 * 60_000
const MAX_SHIPS = 4000
/** Ships dropped at once when the list is full, so it is not re-sorted on every message. */
const EVICT_BATCH = 500
/** An open socket with nothing on it for this long is treated as dead. */
const SILENT_MS = 45_000
/** Waits before reconnecting after a drop; the last one repeats. */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
/** This long open counts as a good connection: the backoff starts over. */
const HEALTHY_MS = 60_000
const KEY_NAME = 'AISSTREAM_API_KEY' as const

type Box = { south: number; west: number; north: number; east: number }

const contains = (outer: Box, inner: Box) => inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east

export class ShipFeed {
  private socket: WebSocket | null = null
  private subscribed: Box | null = null
  /** The area the map asked for last, subscribed to again after a reconnect. */
  private wanted: Box | null = null
  private ships = new Map<number, Ship>()
  private idle: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private attempts = 0
  private openedAt = 0
  private lastMessage = 0
  /** AISStream refused the key: no retries until a new one. */
  private keyRefused = false
  private status: ShipsResult['status'] = 'off'
  private message: string | null = null

  constructor(
    private readonly deps: {
      secrets: CredentialStore
      log: (level: 'info' | 'warn', message: string) => void
      /** A WebSocket constructor (Node 22's global; injectable for tests). */
      WebSocketImpl?: typeof WebSocket
    },
  ) {}

  get hasKey() {
    return Boolean(this.deps.secrets.get(KEY_NAME))
  }

  setKey(key: string | null) {
    if (key === null) {
      this.deps.secrets.delete(KEY_NAME)
      this.close()
      this.status = 'no-key'
      return
    }
    const k = key.trim()
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(k)) throw new Error('That does not look like an AISStream API key.')
    this.deps.secrets.set(KEY_NAME, k)
    this.close()
    this.keyRefused = false
    this.attempts = 0
    this.status = 'off'
    this.message = null
  }

  private close() {
    for (const t of [this.idle, this.retry, this.watchdog]) if (t) clearTimeout(t)
    this.idle = this.retry = this.watchdog = null
    const ws = this.socket
    this.socket = null
    this.subscribed = null
    ws?.close()
  }

  private subscribe(box: Box) {
    const key = this.deps.secrets.get(KEY_NAME)
    if (!key || !this.socket || this.socket.readyState !== 1) return
    // A wider area than the screen, so small pans need no new subscription.
    const padLat = Math.max(1, (box.north - box.south) * 0.25)
    const padLon = Math.max(1, (box.east - box.west) * 0.25)
    const wide: Box = {
      south: Math.max(-90, box.south - padLat),
      north: Math.min(90, box.north + padLat),
      west: Math.max(-180, box.west - padLon),
      east: Math.min(180, box.east + padLon),
    }
    this.socket.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[wide.south, wide.west], [wide.north, wide.east]]], FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'] }))
    this.subscribed = wide
  }

  private connect() {
    this.retry = null
    const Impl = this.deps.WebSocketImpl ?? WebSocket
    const ws = new Impl(URL)
    this.socket = ws
    this.openedAt = 0
    this.status = this.attempts ? 'reconnecting' : 'connecting'
    ws.addEventListener('open', () => {
      if (this.socket !== ws) return
      this.openedAt = this.lastMessage = Date.now()
      if (this.wanted) this.subscribe(this.wanted)
      this.watch(ws)
    })
    ws.addEventListener('message', ev => {
      if (this.socket === ws) void this.onMessage(ev.data)
    })
    // Any drop (network, AISStream restarting, a slow moment) is retried; only a refused key stops.
    ws.addEventListener('close', () => this.dropped(ws))
    ws.addEventListener('error', () => this.dropped(ws))
  }

  /** AISStream sometimes stops sending without closing: a quiet socket is replaced. */
  private watch(ws: WebSocket) {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      if (this.socket !== ws) return
      if (Date.now() - this.lastMessage < SILENT_MS) return this.watch(ws)
      this.deps.log('info', 'Ships: AISStream went quiet; reconnecting.')
      this.dropped(ws)
      ws.close()
    }, SILENT_MS)
    this.watchdog.unref?.()
  }

  private dropped(ws: WebSocket) {
    if (this.socket !== ws) return
    this.socket = null
    this.subscribed = null
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    if (this.keyRefused) return
    // Nobody is looking any more: stay off until the map asks again.
    if (!this.idle) {
      this.status = 'off'
      return
    }
    if (this.openedAt && Date.now() - this.openedAt >= HEALTHY_MS) this.attempts = 0
    const wait = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]!
    this.attempts++
    this.status = 'reconnecting'
    this.message = this.ships.size ? 'Reconnecting to AISStream… showing the last positions.' : 'Reconnecting to AISStream…'
    if (this.attempts === 3) this.deps.log('warn', 'Ships: AISStream keeps dropping the connection; still retrying.')
    this.retry = setTimeout(() => this.connect(), wait)
    this.retry.unref?.()
  }

  private async onMessage(data: unknown) {
    this.lastMessage = Date.now()
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : data instanceof Blob ? await data.text() : String(data)
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const err = (msg as { error?: unknown }).error
    if (typeof err === 'string') {
      if (/api ?key/i.test(err)) {
        this.status = 'error'
        this.keyRefused = true
        // AISStream's reason, without the key.
        this.message = 'AISStream did not accept the key.'
        this.deps.log('warn', `Ships: ${this.message}`)
        this.close()
        return
      }
      // Anything else (too many connections, a bad area): note it and reconnect.
      this.deps.log('warn', `Ships: AISStream: ${err.replace(/[A-Za-z0-9_-]{20,}/g, '…').slice(0, 120)}`)
      const ws = this.socket
      if (ws) {
        this.dropped(ws)
        ws.close()
      }
      return
    }
    const update = parseAisMessage(msg)
    if (!update) return
    this.status = 'live'
    this.message = null
    const prev = this.ships.get(update.mmsi)
    this.ships.set(update.mmsi, { ...(prev ?? { mmsi: update.mmsi, name: '', lat: 0, lon: 0, speed: 0, course: 0, heading: null, type: null, category: 'Other', destination: '', length: null, at: 0 }), ...update.fields, category: shipCategory(update.fields.type ?? prev?.type ?? null) })
    if (this.ships.size > MAX_SHIPS + EVICT_BATCH) {
      const oldest = [...this.ships.values()].sort((a, b) => a.at - b.at).slice(0, this.ships.size - MAX_SHIPS)
      for (const s of oldest) this.ships.delete(s.mmsi)
    }
  }

  /** Ships in the area on screen; keeps the feed open while the map keeps asking. */
  view(box: Box): ShipsResult {
    if (!this.hasKey) return { status: 'no-key', ships: [], message: null }
    this.wanted = box
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      this.close()
      this.status = 'off'
    }, IDLE_MS)
    this.idle.unref?.()
    // A refused key waits for a new one rather than hammering.
    if (this.keyRefused) return { status: 'error', ships: [], message: this.message }
    if (!this.socket && !this.retry) {
      this.attempts = 0
      this.connect()
    } else if (this.socket && (!this.subscribed || !contains(this.subscribed, box))) this.subscribe(box)
    const now = Date.now()
    const ships = [...this.ships.values()].filter(s => s.at && now - s.at < STALE_MS && s.lat >= box.south && s.lat <= box.north && s.lon >= box.west && s.lon <= box.east && s.lat !== 0).slice(0, 2000)
    return { status: this.status, ships, message: this.message }
  }

  stop() {
    this.close()
  }
}
