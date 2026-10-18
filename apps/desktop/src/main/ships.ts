/**
 * Ships for the World map, from AISStream (free key, owner's own account).
 * One WebSocket, opened only while the map's ships layer is on and closed a
 * minute and a half after the map stops asking; it subscribes to the area on
 * screen (a little wider) and keeps the latest position of each vessel seen
 * there. The key lives in the Windows credential store, never in a file, a
 * log or the AI's context.
 */
import type { CredentialStore } from '@assistant/runtime'

import { parseAisMessage, shipCategory, type Ship, type ShipsResult } from '../shared/world.ts'

const URL = 'wss://stream.aisstream.io/v0/stream'
const IDLE_MS = 90_000
const STALE_MS = 30 * 60_000
const MAX_SHIPS = 4000
const KEY_NAME = 'AISSTREAM_API_KEY' as const

type Box = { south: number; west: number; north: number; east: number }

const contains = (outer: Box, inner: Box) => inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east

export class ShipFeed {
  private socket: WebSocket | null = null
  private subscribed: Box | null = null
  private ships = new Map<number, Ship>()
  private idle: NodeJS.Timeout | null = null
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
    this.message = null
  }

  private close() {
    this.socket?.close()
    this.socket = null
    this.subscribed = null
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
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

  private connect(box: Box) {
    const Impl = this.deps.WebSocketImpl ?? WebSocket
    const ws = new Impl(URL)
    this.socket = ws
    this.status = 'connecting'
    ws.addEventListener('open', () => this.subscribe(box))
    ws.addEventListener('message', ev => void this.onMessage(ev.data))
    ws.addEventListener('close', () => {
      if (this.socket === ws) {
        this.socket = null
        this.subscribed = null
        if (this.status !== 'error') this.status = 'off'
      }
    })
    ws.addEventListener('error', () => {
      this.status = 'error'
      this.message = this.message ?? 'Could not reach AISStream.'
    })
  }

  private async onMessage(data: unknown) {
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : data instanceof Blob ? await data.text() : String(data)
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const err = (msg as { error?: unknown }).error
    if (typeof err === 'string') {
      this.status = 'error'
      // AISStream's reason, without the key.
      this.message = /api ?key/i.test(err) ? 'AISStream did not accept the key.' : `AISStream: ${err.slice(0, 120)}`
      this.deps.log('warn', `Ships: ${this.message}`)
      this.close()
      return
    }
    const update = parseAisMessage(msg)
    if (!update) return
    this.status = 'live'
    const prev = this.ships.get(update.mmsi)
    this.ships.set(update.mmsi, { ...(prev ?? { mmsi: update.mmsi, name: '', lat: 0, lon: 0, speed: 0, course: 0, heading: null, type: null, category: 'Other', destination: '', length: null, at: 0 }), ...update.fields, category: shipCategory(update.fields.type ?? prev?.type ?? null) })
    if (this.ships.size > MAX_SHIPS) {
      const oldest = [...this.ships.values()].sort((a, b) => a.at - b.at).slice(0, this.ships.size - MAX_SHIPS)
      for (const s of oldest) this.ships.delete(s.mmsi)
    }
  }

  /** Ships in the area on screen; keeps the feed open while the map keeps asking. */
  view(box: Box): ShipsResult {
    if (!this.hasKey) return { status: 'no-key', ships: [], message: null }
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), IDLE_MS)
    this.idle.unref?.()
    if (this.status === 'error' && !this.socket) {
      // Wait for a new key or a restart rather than hammering.
      return { status: 'error', ships: [], message: this.message }
    }
    if (!this.socket) this.connect(box)
    else if (!this.subscribed || !contains(this.subscribed, box)) this.subscribe(box)
    const now = Date.now()
    const ships = [...this.ships.values()].filter(s => s.at && now - s.at < STALE_MS && s.lat >= box.south && s.lat <= box.north && s.lon >= box.west && s.lon <= box.east && s.lat !== 0).slice(0, 2000)
    return { status: this.status, ships, message: this.message }
  }

  stop() {
    this.close()
  }
}
