/**
 * Intelligence, main side: the GDELT 2.0 conflict feed (one small zip every
 * 15 minutes, keyless), the country shapes for highlighting (Natural Earth,
 * public domain) and Ukraine's live air-raid alerts (siren.pp.ua) with the
 * oblast shapes (geoBoundaries, ODbL). Nothing is fetched until the
 * intelligence panel or layer first asks; then the last two hours are filled
 * in and a rolling day is kept. Shapes are cached on disk.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { countryStats, parseGdeltExport, rollUpAlerts, type AlertRegion, type IntelEvent } from '../shared/intel.ts'

const UA = { 'user-agent': 'Atlas personal assistant (open source)' }
const FEED_EVERY = 15 * 60_000
const KEEP_MS = 24 * 3600_000
const BACKFILL = 8
const ALERTS_TTL = 45_000
const COUNTRIES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson'
const UKRAINE_URL = 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/UKR/ADM1/geoBoundaries-UKR-ADM1_simplified.geojson'

type GeoJson = { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }[] }

const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: UA })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

/** The one file inside a GDELT zip (stored or deflated). */
export const unzipFirst = (buf: Buffer): string => {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('Not a zip file.')
  const method = buf.readUInt16LE(8)
  const size = buf.readUInt32LE(18)
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28)
  const data = buf.subarray(start, start + size)
  return (method === 8 ? inflateRawSync(data) : data).toString('utf8')
}

/** "20261020014500" minus k quarters of an hour. */
const earlier = (stamp: string, quarters: number) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!m) return null
  const t = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, 0) - quarters * 15 * 60_000)
  return t.toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

export class IntelFeed {
  private events = new Map<string, IntelEvent>()
  private files = new Set<string>()
  private polledAt = 0
  private polling: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private countries: { fips: Map<string, { iso: string; name: string }>; shapes: GeoJson } | null = null
  private ukraine: GeoJson | null = null
  private alerts: { at: number; regions: AlertRegion[] } | null = null
  private regionTree: { at: number; data: unknown } | null = null

  constructor(private readonly deps: { cacheDir: string; log?: (level: 'info' | 'warn', message: string) => void }) {}

  /** A shape file, from the disk cache or (once) the network, trimmed to what the map needs. */
  private async shapes(name: string, url: string, keep: (p: Record<string, unknown>) => Record<string, unknown>): Promise<GeoJson> {
    const file = join(this.deps.cacheDir, name)
    try {
      return JSON.parse(await readFile(file, 'utf8')) as GeoJson
    } catch {
      // Not cached yet.
    }
    const raw = (await (await get(url)).json()) as GeoJson
    const slim: GeoJson = { type: 'FeatureCollection', features: raw.features.map(f => ({ type: 'Feature', geometry: f.geometry, properties: keep(f.properties) })) }
    await mkdir(this.deps.cacheDir, { recursive: true }).catch(() => undefined)
    await writeFile(file, JSON.stringify(slim)).catch(() => undefined)
    return slim
  }

  /** Country shapes with ISO code and name (and the FIPS map GDELT needs). */
  async countryShapes() {
    if (this.countries) return this.countries
    const shapes = await this.shapes('ne_110m_countries.json', COUNTRIES_URL, p => {
      const iso = [p.ISO_A2_EH, p.ISO_A2].find(v => typeof v === 'string' && /^[A-Z]{2}$/.test(v)) ?? ''
      return { iso, name: String(p.NAME ?? ''), fips: String(p.FIPS_10 ?? '') }
    })
    const fips = new Map<string, { iso: string; name: string }>()
    for (const f of shapes.features) {
      const p = f.properties as { iso: string; name: string; fips: string }
      if (p.fips && p.fips !== '-99') fips.set(p.fips, { iso: p.iso, name: p.name })
    }
    this.countries = { fips, shapes }
    return this.countries
  }

  private async addFile(stamp: string) {
    if (this.files.has(stamp)) return
    this.files.add(stamp)
    const { fips } = await this.countryShapes()
    const buf = Buffer.from(await (await get(`http://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip`)).arrayBuffer())
    for (const e of parseGdeltExport(unzipFirst(buf), fips)) {
      const prev = this.events.get(e.url)
      if (!prev || prev.mentions < e.mentions) this.events.set(e.url, e)
    }
  }

  /** The newest export (and, the first time, the two hours before it); old events drop off. */
  private async poll() {
    const index = await (await get('http://data.gdeltproject.org/gdeltv2/lastupdate.txt')).text()
    const stamp = /(\d{14})\.export\.CSV\.zip/.exec(index)?.[1]
    if (!stamp) throw new Error('GDELT gave no export.')
    const first = this.files.size === 0
    const stamps = first ? Array.from({ length: BACKFILL }, (_, k) => earlier(stamp, k)).filter((s): s is string => !!s) : [stamp]
    for (const s of stamps) await this.addFile(s).catch(e => this.deps.log?.('warn', `Intelligence: GDELT ${s} failed (${e instanceof Error ? e.message : e}).`))
    const cut = Date.now() - KEEP_MS
    for (const [k, e] of this.events) if (e.at < cut) this.events.delete(k)
    this.polledAt = Date.now()
  }

  private ensure() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), FEED_EVERY)
      this.timer.unref?.()
    }
    if (Date.now() - this.polledAt > FEED_EVERY) return this.refresh()
    return this.polling ?? Promise.resolve()
  }

  private refresh() {
    this.polling ??= this.poll()
      .catch(e => this.deps.log?.('warn', `Intelligence: the feed failed (${e instanceof Error ? e.message : e}).`))
      .finally(() => {
        this.polling = null
      })
    return this.polling
  }

  /** Conflict events of the last `hours` (up to a day), newest first. */
  async list(hours: number): Promise<IntelEvent[]> {
    await this.ensure()
    const cut = Date.now() - Math.min(24, Math.max(1, hours)) * 3600_000
    return [...this.events.values()].filter(e => e.at >= cut).sort((a, b) => b.at - a.at).slice(0, 2000)
  }

  async stats(hours: number) {
    return countryStats(await this.list(hours))
  }

  /** Oblasts under an air-raid alert right now. */
  async ukraineAlerts(): Promise<AlertRegion[]> {
    if (this.alerts && Date.now() - this.alerts.at < ALERTS_TTL) return this.alerts.regions
    if (!this.regionTree || Date.now() - this.regionTree.at > 24 * 3600_000) this.regionTree = { at: Date.now(), data: await (await get('https://siren.pp.ua/api/v3/regions')).json() }
    const regions = rollUpAlerts(await (await get('https://siren.pp.ua/api/v3/alerts')).json(), this.regionTree.data)
    this.alerts = { at: Date.now(), regions }
    return regions
  }

  async ukraineShapes(): Promise<GeoJson> {
    this.ukraine ??= await this.shapes('ukraine_oblasts.json', UKRAINE_URL, p => ({ name: String(p.shapeName ?? '') }))
    return this.ukraine
  }
}
