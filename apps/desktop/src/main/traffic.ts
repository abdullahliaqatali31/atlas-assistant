/**
 * Live traffic for the World page, main side (the TomTom key never leaves
 * here). Flow: TomTom's vector flow tiles around the view, decoded into
 * roads with their speed against free flow, cached two minutes per tile.
 * Where TomTom has no live traffic (Pakistan, among others), the main roads
 * come from OpenStreetMap (OpenFreeMap's tiles) instead and the page says
 * the movement is simulated. Incidents: TomTom's Incident Details for the view, cached and
 * capped well inside the free daily allowance.
 */
import { fitIncidentBox, INCIDENT_FIELDS, parseIncidents, roadsFromTile, simRoadsFromTile, tilesFor, type Box, type FlowRoad, type TrafficIncident } from '../shared/traffic.ts'

const TILE_TTL = 2 * 60_000
const OSM_TTL = 30 * 60_000
const INCIDENT_TTL = 2 * 60_000
/** Incident Details calls a day (TomTom's free tier allows 2,500 non-tile calls). */
const INCIDENT_DAILY = 1_200

export interface TrafficFlow {
  roads: FlowRoad[]
  /** tomtom: live; simulated: real roads, invented movement; none: nothing to show. */
  source: 'tomtom' | 'simulated' | 'none'
}

const okBox = (b: unknown): b is Box => {
  const o = b as Record<string, unknown> | null
  const n = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
  return !!o && n(o.west, 180) && n(o.east, 180) && n(o.south, 90) && n(o.north, 90) && (o.north as number) > (o.south as number) && (o.east as number) > (o.west as number)
}

export class TrafficService {
  private tiles = new Map<string, { at: number; roads: FlowRoad[] }>()
  private osm = new Map<string, { at: number; roads: FlowRoad[] }>()
  private incidentsCache = new Map<string, { at: number; list: TrafficIncident[] }>()
  private incidentDay = { day: '', calls: 0 }

  constructor(
    private readonly deps: {
      key: () => string | null
      fetch?: typeof fetch
      log?: (level: 'info' | 'warn', message: string) => void
    },
  ) {}

  private get http() {
    return this.deps.fetch ?? fetch
  }

  async flow(box: unknown, zoom: unknown): Promise<TrafficFlow> {
    if (!okBox(box) || typeof zoom !== 'number' || !Number.isFinite(zoom)) throw new Error('Bad map area.')
    const key = this.deps.key()
    if (!key) throw new Error('Live traffic needs a TomTom key (Setup › Power up).')
    // Close enough to see streets: zoom 11 shows the main roads, 14 every street.
    const z = Math.max(11, Math.min(14, Math.round(zoom)))
    const roadTypes = z >= 14 ? '[0,1,2,3,4,5,6]' : z >= 13 ? '[0,1,2,3,4,5]' : '[0,1,2,3,4]'
    const tiles = tilesFor(box, z, 12)
    const now = Date.now()
    const roads: FlowRoad[] = []
    let fetched = 0
    let failed = 0
    await Promise.all(
      tiles.map(async t => {
        const id = `${t.z}/${t.x}/${t.y}`
        const hit = this.tiles.get(id)
        if (hit && now - hit.at < TILE_TTL) return void roads.push(...hit.roads)
        try {
          const res = await this.http(`https://api.tomtom.com/traffic/map/4/tile/flow/relative/${id}.pbf?key=${encodeURIComponent(key)}&roadTypes=${encodeURIComponent(roadTypes)}`, { signal: AbortSignal.timeout(12_000) })
          if (res.status === 403) throw new Error('TomTom refused the key.')
          if (!res.ok) throw new Error(`TomTom answered ${res.status}.`)
          const got = roadsFromTile(new Uint8Array(await res.arrayBuffer()), t)
          this.tiles.set(id, { at: now, roads: got })
          fetched++
          roads.push(...got)
        } catch (e) {
          failed++
          if (failed === 1) this.deps.log?.('warn', `Traffic tile ${id}: ${e instanceof Error ? e.message : String(e)}`)
          if (e instanceof Error && e.message.includes('refused')) throw e
        }
      }),
    )
    if (this.tiles.size > 400) for (const k of [...this.tiles.keys()].slice(0, 200)) this.tiles.delete(k)
    if (roads.length) return { roads, source: 'tomtom' }
    if (failed && !fetched) throw new Error('TomTom traffic did not answer. Try again in a moment.')
    // No live traffic here: the real roads, with movement that is only an impression.
    const sim = z >= 12 ? await this.osmRoads(box, zoom).catch(() => []) : []
    return { roads: sim, source: sim.length ? 'simulated' : 'none' }
  }

  /** OpenFreeMap's current tile address (it changes with each weekly build). */
  private omt: { at: number; url: string } | null = null

  /** Main roads from OpenStreetMap (OpenFreeMap's vector tiles, the base map's own), for places TomTom does not cover. */
  private async osmRoads(b: Box, zoom: number): Promise<FlowRoad[]> {
    if (!this.omt || Date.now() - this.omt.at > 6 * 3600_000) {
      const res = await this.http('https://tiles.openfreemap.org/planet', { signal: AbortSignal.timeout(10_000) })
      const tj = (await res.json()) as { tiles?: string[] }
      if (!tj.tiles?.[0]) throw new Error('OpenFreeMap did not say where its tiles are.')
      this.omt = { at: Date.now(), url: tj.tiles[0] }
    }
    const url = this.omt.url
    const z = Math.min(14, Math.max(12, Math.round(zoom)))
    const roads: FlowRoad[] = []
    await Promise.all(
      tilesFor(b, z, 9).map(async t => {
        const id = `${t.z}/${t.x}/${t.y}`
        const hit = this.osm.get(id)
        if (hit && Date.now() - hit.at < OSM_TTL) return void roads.push(...hit.roads)
        try {
          const res = await this.http(url.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y)), { signal: AbortSignal.timeout(12_000) })
          if (!res.ok) return
          const got = simRoadsFromTile(new Uint8Array(await res.arrayBuffer()), t)
          this.osm.set(id, { at: Date.now(), roads: got })
          roads.push(...got)
        } catch {
          // A missing tile only leaves a gap.
        }
      }),
    )
    if (this.osm.size > 300) for (const k of [...this.osm.keys()].slice(0, 150)) this.osm.delete(k)
    return roads
  }

  async incidents(box: unknown): Promise<TrafficIncident[]> {
    if (!okBox(box)) throw new Error('Bad map area.')
    const key = this.deps.key()
    if (!key) return []
    const b = fitIncidentBox(box)
    const id = [b.west, b.south, b.east, b.north].map(v => v.toFixed(2)).join(',')
    const hit = this.incidentsCache.get(id)
    if (hit && Date.now() - hit.at < INCIDENT_TTL) return hit.list
    const day = new Date().toISOString().slice(0, 10)
    if (this.incidentDay.day !== day) this.incidentDay = { day, calls: 0 }
    if (this.incidentDay.calls >= INCIDENT_DAILY) return hit?.list ?? []
    this.incidentDay.calls++
    const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${encodeURIComponent(key)}&bbox=${id}&fields=${encodeURIComponent(INCIDENT_FIELDS)}&language=en-GB&timeValidityFilter=present`
    const res = await this.http(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`TomTom incidents answered ${res.status}.`)
    const list = parseIncidents(await res.json()).slice(0, 400)
    this.incidentsCache.set(id, { at: Date.now(), list })
    if (this.incidentsCache.size > 60) for (const k of [...this.incidentsCache.keys()].slice(0, 30)) this.incidentsCache.delete(k)
    return list
  }
}
