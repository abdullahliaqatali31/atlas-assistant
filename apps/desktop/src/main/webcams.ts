/**
 * Worldwide webcams from Windy (api.windy.com/webcams, API v3) with the
 * owner's own free key, kept in the Windows credential store like the
 * AISStream key. Only the cameras in the current map view are asked for,
 * at zoom 4 and closer, and nothing is stored: Windy's image links expire
 * after 10 minutes on the free tier, so views are cached for 5. Windy's
 * terms ask for a visible credit with a link, which the map shows.
 */
import type { CredentialStore } from '@assistant/runtime'

import { parseWindyClusters, windyBox, type Camera } from '../shared/world.ts'
import { imageDataUrl } from './cameras.ts'

const KEY_NAME = 'WINDY_WEBCAMS_API_KEY' as const
const VIEW_TTL = 5 * 60_000
const IMAGE_TTL = 60_000
const MAX_KNOWN = 5000

export interface WebcamsView {
  status: 'no-key' | 'ok' | 'error'
  cameras: Camera[]
  message: string | null
}

export class WebcamService {
  private views = new Map<string, { at: number; cameras: Camera[] }>()
  /** Every camera seen recently, so its card can fetch its picture. */
  private known = new Map<string, Camera>()
  private images = new Map<string, { at: number; dataUrl: string }>()
  private pausedUntil = 0

  constructor(
    private readonly deps: {
      secrets: CredentialStore
      fetch?: typeof fetch
      log?: (level: 'info' | 'warn', message: string) => void
    },
  ) {}

  hasKey() {
    return Boolean(this.deps.secrets.get(KEY_NAME))
  }

  setKey(key: string | null): { hasKey: boolean } {
    const k = key?.trim() ?? ''
    if (!k) {
      this.deps.secrets.delete(KEY_NAME)
      this.views.clear()
      return { hasKey: false }
    }
    if (!/^[\w-]{16,128}$/.test(k)) throw new Error('That does not look like a Windy Webcams API key.')
    this.deps.secrets.set(KEY_NAME, k)
    this.views.clear()
    this.pausedUntil = 0
    return { hasKey: true }
  }

  async view(box: { south: number; west: number; north: number; east: number }, zoom: number): Promise<WebcamsView> {
    const key = this.deps.secrets.get(KEY_NAME)
    if (!key) return { status: 'no-key', cameras: [], message: null }
    if (zoom < 4) return { status: 'ok', cameras: [], message: 'Zoom in to see webcams.' }
    const b = windyBox(box, zoom)
    const id = [b.zoom, b.north, b.south, b.east, b.west].map(v => Math.round(v * 20) / 20).join(',')
    const hit = this.views.get(id)
    if (hit && Date.now() - hit.at < VIEW_TTL) return { status: 'ok', cameras: hit.cameras, message: null }
    if (Date.now() < this.pausedUntil) return { status: 'error', cameras: hit?.cameras ?? [], message: 'Windy asked us to slow down; trying again shortly.' }
    const url = `https://api.windy.com/webcams/api/v3/map/clusters?northLat=${b.north.toFixed(4)}&southLat=${b.south.toFixed(4)}&eastLon=${b.east.toFixed(4)}&westLon=${b.west.toFixed(4)}&zoom=${b.zoom}&include=images,location,player,urls`
    try {
      const res = await (this.deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(20_000), headers: { 'x-windy-api-key': key, 'user-agent': 'Atlas personal assistant (open source)' } })
      if (res.status === 401 || res.status === 403) return { status: 'error', cameras: [], message: 'Windy did not accept the key; check it on api.windy.com/keys.' }
      if (res.status === 429) {
        this.pausedUntil = Date.now() + 60_000
        return { status: 'error', cameras: hit?.cameras ?? [], message: 'Windy asked us to slow down; trying again in a minute.' }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const cameras = parseWindyClusters(await res.json())
      this.views.set(id, { at: Date.now(), cameras })
      if (this.views.size > 60) this.views.delete(this.views.keys().next().value!)
      for (const c of cameras) {
        this.known.delete(c.id)
        this.known.set(c.id, c)
      }
      while (this.known.size > MAX_KNOWN) this.known.delete(this.known.keys().next().value!)
      return { status: 'ok', cameras, message: null }
    } catch (e) {
      this.deps.log?.('warn', `Webcams: ${e instanceof Error ? e.message : String(e)}`)
      return { status: 'error', cameras: hit?.cameras ?? [], message: 'Webcams unavailable right now.' }
    }
  }

  /** The latest picture of a webcam seen in a recent view, as a data URL. */
  async image(id: string): Promise<{ dataUrl: string; at: number }> {
    const cam = this.known.get(id)
    if (!cam) throw new Error('Move the map a little to refresh this webcam.')
    const hit = this.images.get(id)
    if (hit && Date.now() - hit.at < IMAGE_TTL) return hit
    const out = await imageDataUrl(cam.image)
    this.images.set(id, out)
    if (this.images.size > 40) this.images.delete(this.images.keys().next().value!)
    return out
  }
}
